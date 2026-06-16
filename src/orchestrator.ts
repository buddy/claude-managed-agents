/**
 * Claude Managed Agents (self-hosted) orchestrator for Buddy Sandboxes.
 *
 * Runs INSIDE its own Buddy sandbox, exposed on a public Buddy HTTP endpoint
 * registered as the Anthropic webhook target. On `session.status_run_started`
 * it schedules a background dispatch and returns 200 fast; the dispatcher
 * pre-readies the session's worker sandbox, then claims queued work and starts
 * one `ant beta:worker run` per item. A safety-net poller and a janitor run
 * continuously alongside the server.
 *
 * Run exactly ONE orchestrator per Anthropic environment.
 */
import { Sandbox } from "@buddy-works/sandbox-sdk";
import Fastify from "fastify";

import {
  CONFIG,
  requireBaseSnapshotId,
  requireEnvironmentId,
  requireEnvironmentKey,
  webhookSigningKey,
} from "./config.js";
import { anthropicEnvClient, buddyConnection } from "./clients.js";
import { Janitor, startJanitorLoop } from "./janitor.js";
import { makeLogger } from "./log.js";
import { startPollerLoop } from "./poller.js";
import type { AnthropicLike, SandboxLike, SandboxStatic } from "./types.js";
import { errLabel, sleep } from "./util.js";
import { Dispatcher } from "./worker-dispatch.js";

const log = makeLogger("orchestrator");

const environmentId = requireEnvironmentId();
const environmentKey = requireEnvironmentKey();
const baseSnapshotId = requireBaseSnapshotId();

const client = anthropicEnvClient();
const anthropic = client as unknown as AnthropicLike;
const sandboxes = Sandbox as unknown as SandboxStatic;
// Explicit Buddy connection from CMA_BUDDY_TOKEN. The static Sandbox methods
// otherwise fall back to the sandbox's auto-injected, self-scoped BUDDY_TOKEN,
// which cannot list/create sibling sandboxes (HTTP 401).
const connection = buddyConnection();

const dispatcher = new Dispatcher({
  anthropic,
  sandboxes,
  environmentId,
  environmentKey,
  baseSnapshotId,
  log,
  baseUrl: CONFIG.baseUrl,
  connection,
});

const janitor = new Janitor({ anthropic, sandboxes, dispatcher, environmentId, log, connection });

const scheduledSessions = new Set<string>();
const backgroundTasks = new Set<Promise<unknown>>();

function track(task: Promise<unknown>): void {
  backgroundTasks.add(task);
  task
    .catch((e) => log.error("background task crashed", { err: errLabel(e) }))
    .finally(() => backgroundTasks.delete(task));
}

/** Pre-ready the session's worker, then drain the queue. Deduped per session. */
function scheduleDispatch(sessionId: string): boolean {
  if (scheduledSessions.has(sessionId)) {
    log.info("dispatch already scheduled", { session: sessionId });
    return false;
  }
  scheduledSessions.add(sessionId);
  const task = (async () => {
    try {
      if (CONFIG.dispatcherDebounceMs > 0) await sleep(CONFIG.dispatcherDebounceMs);
      const prepared = new Map<string, SandboxLike>();
      try {
        prepared.set(sessionId, await dispatcher.ensureWorker(sessionId));
      } catch (e) {
        log.error("pre-ready worker failed", { session: sessionId, err: errLabel(e) });
      }
      await dispatcher.drainAndDispatch(prepared);
    } finally {
      scheduledSessions.delete(sessionId);
    }
  })();
  track(task);
  return true;
}

const app = Fastify({ logger: false });

// Keep the exact raw bytes for webhook signature verification.
app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));

app.get("/health", async () => ({ status: "ok" }));

app.post("/webhook", async (req, reply) => {
  if (CONFIG.triggerMode !== "webhook") {
    return reply.code(503).send({ error: "orchestrator is in polling mode; webhook deliveries are not accepted" });
  }
  const key = webhookSigningKey();
  if (!key) {
    return reply.code(503).send({ error: "webhook signing key not configured" });
  }
  const raw = (req.body as Buffer | undefined)?.toString("utf8") ?? "";
  let event: { data?: { type?: string; id?: string } };
  try {
    event = client.beta.webhooks.unwrap(raw, { headers: req.headers as Record<string, string>, key }) as {
      data?: { type?: string; id?: string };
    };
  } catch {
    return reply.code(401).send({ error: "signature verification failed" });
  }

  if (event.data?.type === "session.status_run_started") {
    const sessionId = event.data.id;
    if (!sessionId) {
      return reply.code(503).send({ error: "session id missing from webhook event" });
    }
    scheduleDispatch(sessionId);
  }
  return reply.send({ status: "ok" });
});

async function main(): Promise<void> {
  const mode = CONFIG.triggerMode;
  log.warn("run exactly ONE orchestrator per environment", { environment: environmentId, mode });

  if (mode === "webhook" && !webhookSigningKey()) {
    log.error(
      "TRIGGER_MODE=webhook needs ANTHROPIC_WEBHOOK_SIGNING_KEY to verify deliveries; " +
        "set it, or run with TRIGGER_MODE=polling for no inbound endpoint",
    );
    process.exit(1);
  }

  // The HTTP server runs in both modes: webhook mode serves /webhook + /health;
  // polling mode serves /health only (and rejects /webhook) so Buddy's endpoint
  // and the deploy/set-webhook liveness probes still work.
  await app.listen({ port: CONFIG.orchPort, host: "0.0.0.0" });
  log.info("orchestrator listening", { port: CONFIG.orchPort, mode });

  if (mode === "polling") {
    // The poll loop is the trigger AND covers crash recovery, so the janitor
    // skips re-dispatch to avoid double-draining.
    startPollerLoop(dispatcher, log, { primary: true });
    startJanitorLoop(janitor, log, { recoverCrashedRunners: false });
  } else {
    // Webhook is the trigger; the poll loop is a safety net (POLLER_ENABLED) and
    // the janitor owns crash recovery.
    startPollerLoop(dispatcher, log, { primary: false });
    startJanitorLoop(janitor, log, { recoverCrashedRunners: true });
  }
}

main().catch((e) => {
  log.error("orchestrator failed to start", { err: errLabel(e) });
  process.exit(1);
});

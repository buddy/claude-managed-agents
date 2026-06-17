/**
 * End-to-end proof. Creates a session against the agent + self-hosted
 * environment, sends a prompt, and waits for the transcript to go idle. Then it
 * asserts — Buddy-side — that the session's worker sandbox actually ran
 * `ant beta:worker run`. A passing transcript alone is not proof of THIS path;
 * the matching command on the `cma-worker-<sesn>` sandbox is.
 *
 * Requires a deployed + webhook-registered orchestrator (it does the dispatch).
 *
 *   npm run session
 */
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { anthropicAdminClient, BETA } from "../src/clients.js";
import { buddyConnection } from "../src/clients.js";
import { requireAgentId, requireEnvironmentId } from "../src/config.js";
import { workerIdentifier } from "../src/naming.js";
import { ANT_RUN_MARKER } from "../src/runner-probe.js";
import { errLabel, sleep } from "../src/util.js";

const PROMPT = "Create a file /workspace/hello.txt containing exactly OK, then read it back and show the contents.";
const IDLE_TIMEOUT_MS = 180_000;
// The session parks on `tool_use` (idle) BEFORE the orchestrator reacts to the
// run_started webhook and launches `ant`, so poll the worker for a window
// rather than checking once the instant the transcript goes idle.
const DISPATCH_TIMEOUT_MS = 90_000;
const DISPATCH_POLL_MS = 3_000;

function isTerminal(ev: { type?: string }): boolean {
  const t = ev.type ?? "";
  return t.includes("status_idle") || t.includes("status_terminated") || t.includes("status_run_ended");
}

async function waitForIdle(client: Anthropic, sessionId: string): Promise<boolean> {
  const consume = (async () => {
    const stream = await client.beta.sessions.events.stream(sessionId);
    for await (const ev of stream as AsyncIterable<{ type?: string }>) {
      console.log(`event: ${ev.type}`);
      if (isTerminal(ev)) return true;
    }
    return false;
  })();
  const timeout = sleep(IDLE_TIMEOUT_MS).then(() => false);
  return Promise.race([consume, timeout]);
}

async function assertWorkerRanAnt(sessionId: string): Promise<boolean> {
  const identifier = workerIdentifier(sessionId);
  try {
    const sb = await Sandbox.getByIdentifier(identifier, { connection: buddyConnection() });
    const commands = await sb.listCommands();
    const ran = commands.some((c) => (c.data.command ?? "").includes(ANT_RUN_MARKER));
    console.log(`worker ${identifier}: ${commands.length} command(s), ant beta:worker run present=${ran}`);
    return ran;
  } catch (e) {
    console.log(`worker ${identifier}: not found / unreadable (${errLabel(e)})`);
    return false;
  }
}

async function main(): Promise<void> {
  const client = anthropicAdminClient();
  const session = await client.beta.sessions.create({
    agent: requireAgentId(),
    environment_id: requireEnvironmentId(),
    betas: [BETA],
  });
  console.log(`session: ${session.id}`);

  await client.beta.sessions.events.send(session.id, {
    events: [{ type: "user.message", content: [{ type: "text", text: PROMPT }] }],
  });
  console.log("prompt sent; waiting for idle...");

  const idle = await waitForIdle(client, session.id);
  console.log(idle ? "transcript reached a terminal state" : "transcript wait timed out");

  let ranAnt = false;
  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await assertWorkerRanAnt(session.id)) {
      ranAnt = true;
      break;
    }
    await sleep(DISPATCH_POLL_MS);
  }

  if (ranAnt) {
    console.log("EXAMPLE: PASS");
  } else {
    console.log("EXAMPLE: FAIL (no matching ant beta:worker run on the worker sandbox)");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});

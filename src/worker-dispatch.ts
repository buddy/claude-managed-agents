/**
 * Worker dispatch: map Anthropic work items onto Buddy worker sandboxes.
 *
 * One sandbox per session (`cma-worker-<sesn>`), born from the base snapshot
 * with the `ant` CLI baked in. Each claimed work item launches one
 * `ant beta:worker run` via the sandbox's detached command API; `ant` then owns
 * the heartbeat, tool execution, result posting, and work-item stop.
 *
 * Buddy's exec has no per-process env, so the long-lived credentials are set as
 * sandbox variables at creation (the key encrypted) and the per-run
 * `ANTHROPIC_WORK_ID` is inlined into the BASH command string.
 */
import type { ConnectionConfig } from "@buddy-works/sandbox-sdk";

import { CONFIG } from "./config.js";
import type { Logger } from "./log.js";
import { workerIdentifier } from "./naming.js";
import { ANT_RUN_MARKER } from "./runner-probe.js";
import { workerTags } from "./tags.js";
import type {
  AnthropicLike,
  SandboxLike,
  SandboxStatic,
  VariableInput,
  WorkItem,
} from "./types.js";
import { errLabel, isNotFound, sleep, shellQuote } from "./util.js";

export interface DispatcherDeps {
  anthropic: AnthropicLike;
  sandboxes: SandboxStatic;
  environmentId: string;
  environmentKey: string;
  baseSnapshotId: string;
  log: Logger;
  baseUrl?: string;
  connection?: ConnectionConfig;
}

/** Newest work item per session wins; everything else for that session is dropped. */
function createdAtMs(work: WorkItem): number {
  const t = Date.parse(work.created_at ?? "");
  return Number.isFinite(t) ? t : -Infinity;
}

export class Dispatcher {
  private readonly inFlight = new Set<string>();
  // Promise-chain mutex so concurrent drains (webhook + poller) don't interleave polls.
  private drainChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: DispatcherDeps) {}

  /** Returns false if this work id is already being dispatched locally. */
  markInFlight(workId: string): boolean {
    if (this.inFlight.has(workId)) return false;
    this.inFlight.add(workId);
    return true;
  }

  async stopWork(work: WorkItem, force = true): Promise<void> {
    try {
      await this.deps.anthropic.beta.environments.work.stop(work.id, {
        environment_id: work.environment_id ?? this.deps.environmentId,
        force,
        betas: [CONFIG.beta],
      });
    } catch (e) {
      // ConflictError (409) = already stopped; anything else is best-effort logged.
      const status = (e as { status?: number; statusCode?: number });
      if (status?.status === 409 || status?.statusCode === 409) return;
      this.deps.log.warn("work stop failed", { work: work.id, err: errLabel(e) });
    }
  }

  private workerVariables(sessionId: string): VariableInput[] {
    const vars: VariableInput[] = [
      { key: "ANTHROPIC_ENVIRONMENT_ID", value: this.deps.environmentId },
      { key: "ANTHROPIC_SESSION_ID", value: sessionId },
      { key: "ANTHROPIC_ENVIRONMENT_KEY", value: this.deps.environmentKey, encrypted: true },
    ];
    if (this.deps.baseUrl) vars.push({ key: "ANTHROPIC_BASE_URL", value: this.deps.baseUrl });
    return vars;
  }

  /** Create-if-not-exists the session's worker sandbox and make sure it is RUNNING. */
  async ensureWorker(sessionId: string): Promise<SandboxLike> {
    const identifier = workerIdentifier(sessionId);
    const { sandboxes, log } = this.deps;

    const { connection } = this.deps;

    let sb: SandboxLike | undefined;
    try {
      sb = await sandboxes.getByIdentifier(identifier, { connection });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }

    if (!sb) {
      log.info("creating worker", { identifier, session: sessionId });
      sb = await sandboxes.createFromSnapshot(this.deps.baseSnapshotId, {
        identifier,
        name: identifier,
        resources: CONFIG.workerResources,
        tags: workerTags(),
        variables: this.workerVariables(sessionId),
        connection,
      });
      // `timeout` is not accepted by createFromSnapshot — set the idle auto-stop now.
      try {
        await sb.update({ timeout: CONFIG.workerIdleTimeoutSec });
      } catch (e) {
        log.warn("set worker idle timeout failed", { identifier, err: errLabel(e) });
      }
    } else if (sb.data.status !== "RUNNING") {
      log.info("starting existing worker", { identifier, status: sb.data.status });
      await sb.start();
    }
    return sb;
  }

  /** Launch one `ant beta:worker run` for one already-claimed work item. */
  async dispatchWorkItem(work: WorkItem, preparedWorker?: SandboxLike): Promise<boolean> {
    const { log } = this.deps;
    const sessionId = work.data.type === "session" ? work.data.id : null;
    if (!sessionId) {
      log.warn("dropping non-session work", { work: work.id, type: work.data.type });
      await this.stopWork(work, true);
      return true;
    }

    if (!this.markInFlight(work.id)) {
      log.info("work already dispatching; suppressing duplicate", { work: work.id });
      return true;
    }

    try {
      const worker = preparedWorker ?? (await this.ensureWorker(sessionId));

      // The work id travels in the launched command's text (ANTHROPIC_WORK_ID=…),
      // so the janitor can recover it from listCommands() to release a lingering
      // lease if the runner is SIGKILLed before `ant` can stop the work item.
      const command =
        `cd ${CONFIG.workspaceDir} && ` +
        `ANTHROPIC_WORK_ID=${shellQuote(work.id)} ` +
        `${ANT_RUN_MARKER} --workdir ${CONFIG.workspaceDir} --max-idle ${CONFIG.antMaxIdle}`;

      for (let attempt = 0; attempt < CONFIG.runStartAttempts; attempt++) {
        try {
          await worker.runCommand({ command, runtime: "BASH", detached: true, stdout: null, stderr: null });
          log.info("worker running ant", { work: work.id, session: sessionId });
          return true;
        } catch (e) {
          if ([0, 4, 9, CONFIG.runStartAttempts - 1].includes(attempt)) {
            log.warn("ant run start attempt failed", {
              work: work.id,
              attempt: attempt + 1,
              err: errLabel(e),
            });
          }
          await sleep(2000);
        }
      }
      log.error("worker never accepted ant run", { work: work.id, session: sessionId });
      await this.stopWork(work, true);
      return false;
    } catch (e) {
      log.error("dispatch failed", { work: work.id, session: sessionId, err: errLabel(e) });
      await this.stopWork(work, true);
      return false;
    } finally {
      // Local claim-to-start guard only. Once Buddy accepts the command, `ant`
      // owns the lease; if it dies before heartbeating, Anthropic reclaim
      // redelivers this work id.
      this.inFlight.delete(work.id);
    }
  }

  /**
   * Claim all currently-queued work and hand each item to its session sandbox.
   * Serialized via a promise-chain mutex. Keeps only the newest work item per
   * session and force-stops the rest.
   */
  async drainAndDispatch(preparedWorkers?: Map<string, SandboxLike>): Promise<boolean> {
    const run = this.drainChain.then(() => this.drainOnce(preparedWorkers ?? new Map()));
    // keep the chain alive even if this drain rejects
    this.drainChain = run.catch(() => undefined);
    return run;
  }

  private async drainOnce(preparedWorkers: Map<string, SandboxLike>): Promise<boolean> {
    const { anthropic, environmentId, log } = this.deps;
    const claimed: WorkItem[] = [];

    while (true) {
      let item: WorkItem | null;
      try {
        item = await anthropic.beta.environments.work.poll(environmentId, {
          block_ms: CONFIG.dispatcherPollBlockMs,
          reclaim_older_than_ms: CONFIG.dispatcherReclaimMs,
          betas: [CONFIG.beta],
        });
      } catch (e) {
        log.error("poll failed", { err: errLabel(e) });
        break;
      }
      if (!item) break;

      try {
        await anthropic.beta.environments.work.ack(item.id, {
          environment_id: environmentId,
          betas: [CONFIG.beta],
        });
      } catch (e) {
        log.warn("ack failed; skipping", { work: item.id, err: errLabel(e) });
        continue;
      }
      claimed.push(item);
    }

    if (claimed.length === 0) return true;

    // Collapse to newest work item per session; stop the superseded ones.
    const newest = new Map<string, WorkItem>();
    for (const work of claimed) {
      if (work.data.type !== "session") {
        await this.dispatchWorkItem(work); // drops + force-stops non-session work
        continue;
      }
      const existing = newest.get(work.data.id);
      if (!existing || createdAtMs(work) > createdAtMs(existing)) {
        if (existing) await this.stopWork(existing, true);
        newest.set(work.data.id, work);
      } else {
        await this.stopWork(work, true);
      }
    }

    const results = await Promise.all(
      [...newest.values()].map((work) => this.dispatchWorkItem(work, preparedWorkers.get(work.data.id))),
    );
    const failures = results.filter((ok) => !ok).length;
    log.info("drain complete", { claimed: claimed.length, dispatched: newest.size, failures });
    return failures === 0;
  }
}

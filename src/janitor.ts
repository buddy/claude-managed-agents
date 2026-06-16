/**
 * Janitor: reconcile managed Buddy worker sandboxes against Anthropic session
 * state. Buddy's per-worker idle `timeout` does first-stage idle-stop for free;
 * the janitor handles crash recovery, terminal cleanup, and deletion of
 * long-stopped sandboxes.
 *
 * Exact ids are read from the worker's sandbox **variables** (env + session id)
 * and from the `ant` command text (work id) — not from tags — so tags stay to
 * Buddy's safe character set (see tags.ts).
 */
import type { BuddyConnection } from "./clients.js";
import { CONFIG } from "./config.js";
import type { Logger } from "./log.js";
import { isWorkerIdentifier } from "./naming.js";
import { hasLiveAntRun, latestAntWorkId } from "./runner-probe.js";
import { isManaged, parseStoppedAtMs, readVariable, stoppedAtTag, withoutStoppedAtTag } from "./tags.js";
import type { AnthropicLike, CommandLike, SandboxLike, SandboxStatic } from "./types.js";
import { errLabel, isNotFound, sleep } from "./util.js";
import type { Dispatcher } from "./worker-dispatch.js";

export interface JanitorDeps {
  anthropic: AnthropicLike;
  sandboxes: SandboxStatic;
  dispatcher: Dispatcher;
  environmentId: string;
  log: Logger;
  connection?: BuddyConnection;
}

const DAY_MS = 86_400_000;

export class Janitor {
  constructor(private readonly deps: JanitorDeps) {}

  /** Force-stop the work item this sandbox was running (work id read from command text). */
  private async releaseInFlightWork(commands: CommandLike[]): Promise<void> {
    const workId = latestAntWorkId(commands);
    if (!workId) return;
    try {
      await this.deps.anthropic.beta.environments.work.stop(workId, {
        environment_id: this.deps.environmentId,
        force: true,
        betas: [CONFIG.beta],
      });
    } catch (e) {
      const status = e as { status?: number; statusCode?: number };
      if (status?.status === 409 || status?.statusCode === 409) return;
      this.deps.log.warn("release in-flight work failed", { work: workId, err: errLabel(e) });
    }
  }

  async janitorOnce(recoverCrashedRunners = true): Promise<void> {
    const { sandboxes, anthropic, environmentId, log, connection } = this.deps;

    let listed;
    try {
      listed = await sandboxes.list({ connection });
    } catch (e) {
      log.warn("sandbox list failed", { err: errLabel(e) });
      return;
    }

    const candidates = listed.filter((s) => isWorkerIdentifier(s.identifier) && s.id);
    const recovery: string[] = [];
    let destroyed = 0;
    let backfilled = 0;
    let recovered = 0;

    for (const item of candidates) {
      let sb: SandboxLike;
      try {
        sb = await sandboxes.getById(item.id as string, { connection });
      } catch (e) {
        if (!isNotFound(e)) log.warn("janitor getById failed", { id: item.id, err: errLabel(e) });
        continue;
      }

      // Ours, and for this environment? Exact ids come from variables, not tags.
      if (!isManaged(sb.data.tags)) continue;
      if (readVariable(sb.data.variables, "ANTHROPIC_ENVIRONMENT_ID") !== environmentId) continue;
      const sessionId = readVariable(sb.data.variables, "ANTHROPIC_SESSION_ID");
      if (!sessionId) continue;

      const status = sb.data.status;
      if (status === "RUNNING") {
        let commands: CommandLike[] = [];
        try {
          commands = await sb.listCommands();
        } catch (e) {
          log.warn("janitor listCommands failed", { id: sb.data.id, err: errLabel(e) });
          continue;
        }
        if (hasLiveAntRun(commands)) continue; // healthy runner; leave alone

        let session;
        try {
          session = await anthropic.beta.sessions.retrieve(sessionId, { betas: [CONFIG.beta] });
        } catch (e) {
          if (isNotFound(e)) {
            await this.releaseInFlightWork(commands);
            await this.destroy(sb);
            destroyed++;
            log.info("destroyed sandbox for missing session", { session: sessionId });
          } else {
            log.warn("janitor session retrieve failed", { session: sessionId, err: errLabel(e) });
          }
          continue;
        }

        if (session.archived_at || session.status === "terminated") {
          await this.releaseInFlightWork(commands);
          await this.destroy(sb);
          destroyed++;
          log.info("destroyed terminal sandbox", { session: sessionId });
        } else if (session.status === "idle") {
          // Leave it; Buddy's idle timeout will stop the sandbox.
        } else if (session.status === "running") {
          await this.releaseInFlightWork(commands);
          if (recoverCrashedRunners) recovery.push(sessionId);
          log.warn("runner missing for running session", { session: sessionId });
        } else {
          log.warn("unknown session status", { session: sessionId, status: session.status });
        }
      } else if (status === "STOPPED") {
        if (await this.reapStopped(sb)) destroyed++;
        else backfilled++;
      }
      // STARTING / STOPPING / RESTORING / FAILED: skip this pass.
    }

    if (recovery.length > 0 && recoverCrashedRunners) {
      try {
        await this.deps.dispatcher.drainAndDispatch();
        recovered = recovery.length;
      } catch (e) {
        log.warn("crash recovery drain failed", { err: errLabel(e) });
      }
    }

    if (destroyed || backfilled || recovered) {
      log.info("janitor pass", { destroyed, backfilled, recovered });
    }
  }

  /** Delete a STOPPED sandbox once idle longer than MAX_IDLE_DAYS.
   *  Returns true if destroyed, false if it only backfilled the stopped-at tag. */
  private async reapStopped(sb: SandboxLike): Promise<boolean> {
    const tags = sb.data.tags;
    const stoppedAtMs = parseStoppedAtMs(tags);
    if (stoppedAtMs === undefined) {
      try {
        await sb.update({ tags: [...withoutStoppedAtTag(tags), stoppedAtTag(Date.now())] });
      } catch (e) {
        this.deps.log.warn("backfill stopped-at failed", { err: errLabel(e) });
      }
      return false;
    }
    if (CONFIG.maxIdleDays <= 0) return false;
    if (Date.now() - stoppedAtMs >= CONFIG.maxIdleDays * DAY_MS) {
      await this.destroy(sb);
      this.deps.log.info("destroyed long-idle sandbox", { id: sb.data.id });
      return true;
    }
    return false;
  }

  private async destroy(sb: SandboxLike): Promise<void> {
    try {
      await sb.destroy();
    } catch (e) {
      this.deps.log.warn("destroy failed", { id: sb.data.id, err: errLabel(e) });
    }
  }
}

/**
 * Non-overlapping janitor loop. Returns a stop() function.
 *
 * `recoverCrashedRunners` is true in webhook mode (the janitor is the only thing
 * watching for a sandbox whose `ant` process died while its session is still
 * running) and false in polling mode (the continuous poll loop already
 * re-dispatches reclaimed work, so the janitor would only double-drain).
 */
export function startJanitorLoop(
  janitor: Janitor,
  log: Logger,
  opts: { recoverCrashedRunners: boolean } = { recoverCrashedRunners: true },
): () => void {
  let stopped = false;
  (async () => {
    while (!stopped) {
      await sleep(CONFIG.janitorSeconds * 1000);
      if (stopped) break;
      try {
        await janitor.janitorOnce(opts.recoverCrashedRunners);
      } catch (e) {
        log.warn("janitor pass crashed", { err: errLabel(e) });
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

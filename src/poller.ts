/**
 * Work-queue poll loop, with two roles set by `TRIGGER_MODE`:
 *
 * - `polling` mode (`primary: true`): this loop is the ONLY trigger, so it runs
 *   unconditionally and ignores `POLLER_ENABLED`.
 * - `webhook` mode (`primary: false`): webhook delivery is the primary trigger
 *   and this loop is a safety net — a process restart after acking a webhook
 *   could otherwise leave queued work waiting for another webhook. Gated by
 *   `POLLER_ENABLED` (default on).
 *
 * `drainAndDispatch` long-polls (block_ms) when the queue is empty, so the loop
 * is self-paced; the sleep is just a floor between drains.
 */
import { CONFIG } from "./config.ts";
import type { Logger } from "./log.ts";
import { errLabel, sleep } from "./util.ts";
import type { Dispatcher } from "./worker-dispatch.ts";

export function startPollerLoop(
  dispatcher: Dispatcher,
  log: Logger,
  opts: { primary: boolean } = { primary: false },
): () => void {
  if (!opts.primary && !CONFIG.pollerEnabled) {
    log.info("safety-net poller disabled (POLLER_ENABLED=false)");
    return () => undefined;
  }
  let stopped = false;
  (async () => {
    log.info(opts.primary ? "primary poll loop started" : "safety-net poller loop started");
    while (!stopped) {
      try {
        await dispatcher.drainAndDispatch();
      } catch (e) {
        log.warn("poller drain failed", { err: errLabel(e) });
      }
      if (stopped) break;
      await sleep(1000);
    }
  })();
  return () => {
    stopped = true;
  };
}

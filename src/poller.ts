/**
 * Safety-net polling loop. Webhook delivery is the primary trigger, but a
 * process restart after acking a webhook could leave queued work waiting for
 * another webhook. This loop drains the queue on an interval regardless.
 *
 * `drainAndDispatch` long-polls (block_ms) when the queue is empty, so the loop
 * is self-paced; the sleep is just a floor between drains.
 */
import { CONFIG } from "./config.js";
import type { Logger } from "./log.js";
import { errLabel, sleep } from "./util.js";
import type { Dispatcher } from "./worker-dispatch.js";

export function startPollerLoop(dispatcher: Dispatcher, log: Logger): () => void {
  if (!CONFIG.pollerEnabled) {
    log.info("poller disabled (POLLER_ENABLED=false)");
    return () => undefined;
  }
  let stopped = false;
  (async () => {
    log.info("poller loop started");
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

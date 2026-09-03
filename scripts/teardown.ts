/**
 * Destroy the orchestrator sandbox and all per-session worker sandboxes managed
 * by this cookbook (identifier prefix `cma-worker-`, plus `cma-orchestrator`).
 * Snapshots are left in place — delete them from the Buddy dashboard if desired.
 *
 *   npm run teardown
 */
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "../src/clients.ts";
import { isWorkerIdentifier, WORKER_PREFIX } from "../src/naming.ts";
import { errLabel } from "../src/util.ts";

const ORCH_IDENTIFIER = "cma-orchestrator";

async function main(): Promise<void> {
  const connection = buddyConnection();
  const listed = await Sandbox.list({ connection });
  const targets = listed.filter(
    (s) => isWorkerIdentifier(s.identifier) || s.identifier === ORCH_IDENTIFIER,
  );

  if (targets.length === 0) {
    console.log(`no ${WORKER_PREFIX}* or ${ORCH_IDENTIFIER} sandboxes found`);
    return;
  }

  let destroyed = 0;
  for (const item of targets) {
    if (!item.id) continue;
    try {
      const sb = await Sandbox.getById(item.id, { connection });
      await sb.destroy();
      destroyed++;
      console.log(`destroyed ${item.identifier}`);
    } catch (e) {
      console.warn(`destroy ${item.identifier} failed: ${errLabel(e)}`);
    }
  }
  console.log(`done — destroyed ${destroyed}/${targets.length} sandboxes`);
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});

/**
 * Diagnose the orchestrator: status, endpoint, which expected variables are set
 * (keys only), app status, /health, and the app's logs. Use this when a session
 * reaches idle but no `cma-worker-*` sandbox was created — the reason is in the
 * orchestrator's logs (webhook 401, poll failure, createFromSnapshot error, …).
 *
 *   npm run orchestrator-logs
 */
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "../src/clients.js";
import { errLabel } from "../src/util.js";

const ORCH_IDENTIFIER = "cma-orchestrator";
const EXPECTED_VARS = [
  "ANTHROPIC_ENVIRONMENT_ID",
  "ANTHROPIC_ENVIRONMENT_KEY",
  "ANTHROPIC_WEBHOOK_SIGNING_KEY",
  "BUDDY_TOKEN",
  "BUDDY_BASE_SNAPSHOT_ID",
];

async function main(): Promise<void> {
  const sb = await Sandbox.getByIdentifier(ORCH_IDENTIFIER, { connection: buddyConnection() });
  await sb.refresh();

  console.log(`status: ${sb.data.status}`);
  const base = sb.data.endpoints?.find((e) => e.name === "webhook")?.endpoint_url;
  console.log(`webhook endpoint: ${base ?? "(none yet)"}`);

  const keys = new Set((sb.data.variables ?? []).map((v) => v.key));
  console.log("variables present:");
  for (const k of EXPECTED_VARS) console.log(`  ${keys.has(k) ? "ok " : "-- "} ${k}`);

  if (base) {
    const healthUrl = `${base.replace(/\/$/, "")}/health`;
    try {
      const res = await fetch(healthUrl);
      console.log(`/health: ${res.ok ? "ok" : "unexpected"} (${res.status})`);
    } catch (e) {
      console.log(`/health: unreachable (${errLabel(e)})`);
    }
  }

  const apps = sb.data.apps ?? [];
  if (apps.length === 0) {
    console.log("\nno apps configured — the orchestrator process was never started.");
    return;
  }
  for (const app of apps) {
    console.log(`\n=== app ${app.id} [${app.app_status}] ===`);
    console.log(`$ ${app.command}`);
    if (!app.id) continue;
    try {
      const { logs } = await sb.getAppLogs(app.id);
      for (const line of logs ?? []) console.log(line);
      if (!logs || logs.length === 0) console.log("(no logs yet)");
    } catch (e) {
      console.log(`(failed to read logs: ${errLabel(e)})`);
    }
  }
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});

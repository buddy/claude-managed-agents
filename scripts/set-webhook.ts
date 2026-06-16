/**
 * Print the orchestrator's public webhook URL and the Console steps to register
 * it. Also probes /health so you can confirm the orchestrator is serving before
 * pointing Anthropic at it. (Webhook registration itself is done in the Console.)
 *
 *   npm run set-webhook
 */
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "../src/clients.js";
import { CONFIG } from "../src/config.js";
import { errLabel } from "../src/util.js";

const ORCH_IDENTIFIER = "cma-orchestrator";

async function main(): Promise<void> {
  if (CONFIG.triggerMode === "polling") {
    console.log("TRIGGER_MODE=polling — the orchestrator polls the work queue itself.");
    console.log("No webhook registration or signing key is required. Nothing to do.");
    return;
  }
  const sb = await Sandbox.getByIdentifier(ORCH_IDENTIFIER, { connection: buddyConnection() });
  await sb.refresh();
  const base = sb.data.endpoints?.find((e) => e.name === "webhook")?.endpoint_url;
  if (!base) {
    throw new Error("orchestrator has no webhook endpoint URL yet; wait for the app to start");
  }
  const root = base.replace(/\/$/, "");
  const webhookUrl = `${root}/webhook`;
  const healthUrl = `${root}/health`;

  let health = "unknown";
  try {
    const res = await fetch(healthUrl);
    health = res.ok ? `ok (${res.status})` : `unexpected ${res.status}`;
  } catch (e) {
    health = `unreachable (${errLabel(e)})`;
  }

  console.log(`orchestrator health: ${health}`);
  console.log("");
  console.log(`webhook URL: ${webhookUrl}`);
  console.log("");
  console.log("In the Anthropic Console > Managed Agents > Webhooks:");
  console.log("  1. Create a webhook for this workspace/project.");
  console.log("  2. Subscribe ONLY to session.status_run_started.");
  console.log(`  3. Set the destination URL to: ${webhookUrl}`);
  console.log("  4. Copy the signing secret (whsec_...) into .env as ANTHROPIC_WEBHOOK_SIGNING_KEY.");
  console.log("  5. Re-run `npm run deploy-orchestrator` so the orchestrator picks up the key.");
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});

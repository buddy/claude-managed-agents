/**
 * Deploy the orchestrator into its own Buddy sandbox and expose it on a public
 * HTTP endpoint (the Anthropic webhook target).
 *
 * Source delivery is ordering-safe: we create the sandbox (no app yet), upload
 * the orchestrator source, THEN set the long-running `app` so it only starts
 * once the files exist. The deployed package.json pulls @buddy-works/sandbox-sdk
 * from npm, the same as the local dev install.
 *
 *   npm run deploy-orchestrator
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "../src/clients.js";
import { CONFIG, requireBaseSnapshotId, requireEnv, requireEnvironmentId, requireEnvironmentKey, webhookSigningKey } from "../src/config.js";
import { orchestratorTags } from "../src/tags.js";
import type { VariableInput } from "../src/types.js";
import { errLabel, sleep } from "../src/util.js";

const ORCH_IDENTIFIER = "cma-orchestrator";
const REMOTE_DIR = "/opt/cma";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "src");

function runtimePackageJson(): Buffer {
  const dev = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const pkg = {
    name: "cma-buddy-orchestrator",
    private: true,
    type: "module",
    dependencies: {
      "@anthropic-ai/sdk": dev.dependencies["@anthropic-ai/sdk"],
      "@buddy-works/sandbox-sdk": dev.dependencies["@buddy-works/sandbox-sdk"],
      dotenv: dev.dependencies["dotenv"],
      fastify: dev.dependencies["fastify"],
      tsx: "^4.19.2",
    },
  };
  return Buffer.from(JSON.stringify(pkg, null, 2));
}

function orchestratorVariables(): VariableInput[] {
  const vars: VariableInput[] = [
    { key: "ANTHROPIC_ENVIRONMENT_ID", value: requireEnvironmentId() },
    { key: "ANTHROPIC_ENVIRONMENT_KEY", value: requireEnvironmentKey(), encrypted: true },
    // A Buddy sandbox auto-injects its own `BUDDY_TOKEN` scoped to managing
    // ITSELF only — it cannot list/create sibling sandboxes. Inject the real
    // workspace token under a distinct name so it does not collide with that
    // auto-injected one; `buddyConnection()` reads CMA_BUDDY_TOKEN first.
    { key: "CMA_BUDDY_TOKEN", value: requireEnv("BUDDY_TOKEN"), encrypted: true },
    { key: "BUDDY_WORKSPACE", value: requireEnv("BUDDY_WORKSPACE") },
    { key: "BUDDY_PROJECT", value: requireEnv("BUDDY_PROJECT") },
    { key: "BUDDY_REGION", value: CONFIG.region },
    { key: "BUDDY_TUNNEL_REGION", value: CONFIG.tunnelRegion },
    { key: "BUDDY_BASE_SNAPSHOT_ID", value: requireBaseSnapshotId() },
    { key: "ORCH_PORT", value: String(CONFIG.orchPort) },
    { key: "ANT_MAX_IDLE", value: CONFIG.antMaxIdle },
    { key: "WORKER_RESOURCES", value: CONFIG.workerResources },
    { key: "WORKER_IDLE_TIMEOUT_SEC", value: String(CONFIG.workerIdleTimeoutSec) },
    { key: "WORKSPACE_DIR", value: CONFIG.workspaceDir },
  ];
  const signing = webhookSigningKey();
  if (signing) vars.push({ key: "ANTHROPIC_WEBHOOK_SIGNING_KEY", value: signing, encrypted: true });
  if (CONFIG.baseUrl) vars.push({ key: "ANTHROPIC_BASE_URL", value: CONFIG.baseUrl });
  return vars;
}

async function main(): Promise<void> {
  const connection = buddyConnection();

  // Reuse an existing orchestrator sandbox if present (one per environment).
  let sb: Sandbox | undefined;
  try {
    sb = await Sandbox.getByIdentifier(ORCH_IDENTIFIER, { connection });
    console.log(`found existing ${ORCH_IDENTIFIER}; refreshing variables in place`);
    if (sb.data.status !== "RUNNING") await sb.start();
    // Refresh credentials/ids on redeploy (e.g. a new environment + key), so a
    // reused orchestrator doesn't keep stale variables. The app restart below
    // (update apps) makes the orchestrator process pick them up.
    await sb.update({ variables: orchestratorVariables().map((v) => ({ ...v, type: "VAR" as const })) });
  } catch {
    console.log(`creating orchestrator sandbox ${ORCH_IDENTIFIER}...`);
    sb = await Sandbox.create({
      name: ORCH_IDENTIFIER,
      identifier: ORCH_IDENTIFIER,
      os: "ubuntu:24.04",
      resources: CONFIG.orchestratorResources,
      // NOTE: no `timeout` — the orchestrator must not idle-stop.
      first_boot_commands: [
        "set -eux",
        `sudo mkdir -p ${REMOTE_DIR}/src`,
        `sudo chown -R buddy:buddy ${REMOTE_DIR}`,
      ].join("\n"),
      tags: orchestratorTags(),
      variables: orchestratorVariables().map((v) => ({ ...v, type: "VAR" as const })),
      endpoints: [
        {
          name: "webhook",
          type: "HTTP",
          // Buddy expects `[ip:]port`, not a hostname. The tunnel forwards the
          // public URL to this port inside the sandbox.
          endpoint: String(CONFIG.orchPort),
          region: CONFIG.tunnelRegion,
          http: { auth_type: "NONE" },
        },
      ],
      connection,
    });
  }

  // Upload orchestrator source AFTER the sandbox is up, BEFORE starting the app.
  console.log("uploading orchestrator source...");
  await sb.fs.uploadFile(runtimePackageJson(), `${REMOTE_DIR}/package.json`);
  await sb.fs.uploadFile(join(root, "tsconfig.json"), `${REMOTE_DIR}/tsconfig.json`);
  const srcFiles = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  await Promise.all(
    srcFiles.map((f) => sb!.fs.uploadFile(join(srcDir, f), `${REMOTE_DIR}/src/${f}`)),
  );

  // Configure the long-running app now that the files are in place.
  console.log("configuring orchestrator app (npm install + tsx)...");
  await sb.update({
    apps: [{ command: `cd ${REMOTE_DIR} && npm install --no-audit --no-fund && npx tsx src/orchestrator.ts` }],
  });

  // Restart so the orchestrator PROCESS picks up the latest source AND the
  // refreshed variables. Updating apps with an unchanged command does not
  // restart an already-running process, and variable updates never reach a live
  // process — without this restart a redeploy keeps polling with a stale key.
  console.log("restarting orchestrator to apply source + variables...");
  await sb.restart();

  await sb.refresh();
  let url = sb.data.endpoints?.find((e) => e.name === "webhook")?.endpoint_url;
  for (let i = 0; i < 10 && !url; i++) {
    await sleep(2000);
    await sb.refresh();
    url = sb.data.endpoints?.find((e) => e.name === "webhook")?.endpoint_url;
  }

  console.log("");
  if (url) {
    console.log(`PUBLIC_WEBHOOK_URL=${url.replace(/\/$/, "")}/webhook`);
    console.log(`HEALTH_URL=${url.replace(/\/$/, "")}/health`);
  } else {
    console.log("endpoint URL not yet available — run `npm run set-webhook` shortly to read it.");
  }
  console.log("");
  console.log("Register the webhook URL in the Anthropic Console (subscribe only to");
  console.log("session.status_run_started), copy the signing key into .env as");
  console.log("ANTHROPIC_WEBHOOK_SIGNING_KEY, then re-run deploy-orchestrator.");
}

main().catch((e) => {
  console.error(errLabel(e));
  process.exit(1);
});

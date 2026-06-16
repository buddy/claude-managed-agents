/**
 * Guided, autonomous-but-transparent setup for the CMA-on-Buddy cookbook.
 *
 * Walks an interactive form for the prerequisites (ANTHROPIC_API_KEY, Buddy
 * token/workspace/project, trigger mode) — showing already-set values masked and
 * asking before overwriting — then runs every deterministic step it can. The two
 * Anthropic Console gates (generate the environment key, register the webhook)
 * require a human in a browser; in an interactive run it prompts for each key
 * inline once you've done the Console action, so there is nothing to re-run.
 *
 * In a non-interactive run (CI, pipes — no TTY) it never prompts: it fails fast
 * if a prerequisite is missing, and at each gate falls back to printing the
 * paste-into-.env + re-run instructions.
 *
 * Kills the multi-step copy/paste churn:
 *   - reads `.env` directly (no `source .env` between runs);
 *   - ids it creates (environment, agent, base snapshot) are appended back to
 *     `.env` (after a one-time `.env.bak` backup), so nothing is pasted by hand
 *     and resources are never double-created on re-run.
 *
 *   npm run bootstrap          # run up to the next gate
 *   npm run bootstrap -- --plan  # show state + next action, run nothing
 *
 * The two Console steps are unavoidable: environment-key generation and webhook
 * registration are Console-only in Managed Agents, so no script can do them.
 */
import { spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { confirm, input, password, select } from "@inquirer/prompts";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");
const ENV_PATH = join(ROOT, ".env");
const ENV_EXAMPLE_PATH = join(ROOT, ".env.example");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

const ENV_ID = "ANTHROPIC_ENVIRONMENT_ID";
const ENV_KEY = "ANTHROPIC_ENVIRONMENT_KEY";
const AGENT_ID = "ANTHROPIC_AGENT_ID";
const SNAPSHOT_ID = "BUDDY_BASE_SNAPSHOT_ID";
const SIGNING_KEY = "ANTHROPIC_WEBHOOK_SIGNING_KEY";
const TRIGGER_MODE = "TRIGGER_MODE";

// --- .env read / append + output parsing (pure, unit-tested) ---------------

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    let value = m[2] ?? "";
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

/** process.env overlaid with non-empty .env values (.env wins, like dotenv override). */
export function mergeEnv(base: NodeJS.ProcessEnv, fileEnv: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) merged[k] = v;
  for (const [k, v] of Object.entries(fileEnv)) if (v.trim() !== "") merged[k] = v;
  return merged;
}

/** Extract a `KEY=value` line from captured script output. */
export function extractValue(output: string, key: string): string | undefined {
  const m = new RegExp(`^${key}=(.+)$`, "m").exec(output);
  return m?.[1]?.trim();
}

/** Append `export NAME=value` to .env. No-op if already present with that value. */
export function appendExport(path: string, name: string, value: string): boolean {
  const existing = existsSync(path) ? parseEnvText(readFileSync(path, "utf8")) : {};
  if (existing[name] === value) return false;
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const backup = `${path}.bak`;
  if (existsSync(path) && !existsSync(backup)) copyFileSync(path, backup);
  const prefix = text === "" || text.endsWith("\n") ? "" : "\n";
  appendFileSync(path, `${prefix}export ${name}=${value}\n`);
  return true;
}

/**
 * Seed `.env` from `.env.example` when it's missing, so the user never has to
 * `cp` it by hand. No-op if `.env` already exists or there's no template.
 * Returns true only when it actually created the file.
 */
export function seedEnvFromExample(envPath: string, examplePath: string): boolean {
  if (existsSync(envPath) || !existsSync(examplePath)) return false;
  copyFileSync(examplePath, envPath);
  return true;
}

// --- prompt specs + validation (pure parts unit-tested) --------------------

const API_KEY = "ANTHROPIC_API_KEY";
const BUDDY_TOKEN = "BUDDY_TOKEN";
const BUDDY_WORKSPACE = "BUDDY_WORKSPACE";
const BUDDY_PROJECT = "BUDDY_PROJECT";

export interface VarSpec {
  key: string;
  label: string;
  secret?: boolean;
  /** Returns true if valid, or an error message string. */
  validate?: (value: string) => true | string;
}

/** Require a non-empty value, optionally with an expected prefix. */
export function requireValue(prefix?: string): (value: string) => true | string {
  return (value: string) => {
    const v = value.trim();
    if (!v) return "required — paste a value";
    if (prefix && !v.startsWith(prefix)) return `expected a value starting with "${prefix}"`;
    return true;
  };
}

/** Show a secret without leaking it: first 6 + last 4 chars, rest masked. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "•".repeat(value.length);
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Things the user must supply before any resource can be created. */
const PREREQS: VarSpec[] = [
  { key: API_KEY, label: "ANTHROPIC_API_KEY (admin key, local only — sk-ant-api03-…)", secret: true, validate: requireValue("sk-ant-api03-") },
  { key: BUDDY_TOKEN, label: "BUDDY_TOKEN (Buddy personal access token)", secret: true, validate: requireValue() },
  { key: BUDDY_WORKSPACE, label: "BUDDY_WORKSPACE (workspace domain)", validate: requireValue() },
  { key: BUDDY_PROJECT, label: "BUDDY_PROJECT (project name)", validate: requireValue() },
];

const ENV_KEY_SPEC: VarSpec = { key: ENV_KEY, label: "ANTHROPIC_ENVIRONMENT_KEY (from the Console — sk-ant-oat01-…)", secret: true, validate: requireValue("sk-ant-oat01-") };
const SIGNING_KEY_SPEC: VarSpec = { key: SIGNING_KEY, label: "ANTHROPIC_WEBHOOK_SIGNING_KEY (Console signing secret — whsec_…)", secret: true, validate: requireValue("whsec_") };

// --- flow decision (pure, unit-tested) -------------------------------------

export type Step = "create_env" | "gate_env_key" | "provision" | "gate_webhook" | "finalize";

/** Polling mode needs no inbound endpoint, so there is no webhook to register. */
export function isPollingMode(env: Record<string, string>): boolean {
  return (env[TRIGGER_MODE] ?? "").toLowerCase() === "polling";
}

export function decide(env: Record<string, string>): Step {
  if (!env[ENV_ID]) return "create_env";
  if (!env[ENV_KEY]) return "gate_env_key";
  if (!env[AGENT_ID] || !env[SNAPSHOT_ID]) return "provision";
  if (isPollingMode(env)) return "finalize"; // no webhook gate in polling mode
  if (!env[SIGNING_KEY]) return "gate_webhook";
  return "finalize";
}

// --- runtime wiring --------------------------------------------------------

function loadEnv(): Record<string, string> {
  const fileEnv = existsSync(ENV_PATH) ? parseEnvText(readFileSync(ENV_PATH, "utf8")) : {};
  const merged = mergeEnv(process.env, fileEnv);
  // Treat leftover .env.example placeholders (e.g. `env_...`, `agent_...`,
  // `sk-ant-oat01-...`) as unset, so bootstrap creates real resources instead of
  // silently trusting the template. The real value gets appended and wins (last
  // occurrence wins in both dotenv and parseEnvText).
  for (const [k, v] of Object.entries(merged)) {
    if (/\.\.\.\s*$/.test(v)) delete merged[k];
  }
  return merged;
}

/** True only when we can safely block on stdin for prompts (not in CI/pipes). */
function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ensure `spec.key` has a value, prompting interactively. If it is already set
 * (placeholders are stripped by loadEnv), show it masked and ask whether to
 * overwrite, defaulting to NO. New values are appended to .env and reflected in
 * the passed-in `env` so the caller sees them without a reload.
 */
async function ensureVar(env: Record<string, string>, spec: VarSpec): Promise<void> {
  const current = env[spec.key];
  if (current) {
    const shown = spec.secret ? maskSecret(current) : current;
    console.log(`  ok ${spec.key} already set (${shown})`);
    const overwrite = await confirm({ message: `Overwrite ${spec.key}?`, default: false });
    if (!overwrite) return;
  }
  const value = (
    spec.secret
      ? await password({ message: spec.label, mask: "*", validate: spec.validate })
      : await input({ message: spec.label, validate: spec.validate })
  ).trim();
  appendExport(ENV_PATH, spec.key, value);
  env[spec.key] = value;
  console.log(`    saved ${spec.key} to .env`);
}

/** Prompt for the trigger mode (webhook vs polling) and persist the choice. */
async function ensureTriggerMode(env: Record<string, string>): Promise<void> {
  const current = isPollingMode(env) ? "polling" : "webhook";
  const mode = await select({
    message: "TRIGGER_MODE — how the orchestrator learns about queued work",
    default: current,
    choices: [
      { name: "webhook — Anthropic POSTs to a public endpoint (lower latency, needs a signing secret)", value: "webhook" },
      { name: "polling — orchestrator long-polls the queue (no endpoint, no secret)", value: "polling" },
    ],
  });
  appendExport(ENV_PATH, TRIGGER_MODE, mode);
  env[TRIGGER_MODE] = mode;
}

/** Run a cookbook script via tsx, teeing its output live while capturing stdout. */
function runScript(rel: string): Promise<string> {
  return new Promise((resolve, reject) => {
    console.log(`\n   $ tsx ${rel}`);
    const child = spawn(TSX, [rel], { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      out += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${rel} exited with code ${code}`));
    });
  });
}

function printState(env: Record<string, string>): void {
  const polling = isPollingMode(env);
  const rows: Array<[string, string]> = [
    ["trigger mode", polling ? "polling" : "webhook"],
    ["environment", env[ENV_ID] ?? ""],
    ["environment key", env[ENV_KEY] ? "set" : ""],
    ["agent", env[AGENT_ID] ?? ""],
    ["base snapshot", env[SNAPSHOT_ID] ?? ""],
  ];
  if (!polling) rows.push(["webhook signing key", env[SIGNING_KEY] ? "set" : ""]);
  console.log("\nstate:");
  for (const [label, detail] of rows) {
    console.log(`  ${detail ? "ok " : "-- "} ${label}: ${detail || "not set"}`);
  }
}

function gateEnvKey(env: Record<string, string>): void {
  console.log(
    "\n>> NEXT — Anthropic Console (generate the environment key):\n" +
      "   1. Open https://platform.claude.com and select the workspace/project for\n" +
      "      your ANTHROPIC_API_KEY, then open Managed Agents > Environments.\n" +
      `   2. Choose the environment shown above (${env[ENV_ID]}).\n` +
      '   3. Click "Generate environment key".',
  );
}

function gateWebhook(url: string | undefined): void {
  const shown = url ?? "<the URL deploy-orchestrator printed above>";
  console.log(
    "\n>> NEXT — Anthropic Console (register the webhook):\n" +
      "   1. Open https://platform.claude.com, select the same workspace/project,\n" +
      "      then create a Managed Agents webhook.\n" +
      "   2. Subscribe ONLY to session.status_run_started.\n" +
      `   3. Set the destination URL to: ${shown}`,
  );
}

/** Non-interactive fallback: tell the user to paste the key and re-run. */
function manualTail(spec: VarSpec): void {
  console.log(
    `\n   Then add it to .env:   export ${spec.key}=...\n` +
      "   And re-run:            npm run bootstrap\n" +
      "   (No `source .env` needed — bootstrap reads .env directly.)",
  );
}

async function ensureFromScript(label: string, script: string, key: string): Promise<void> {
  console.log(`\n-> ${label}`);
  const out = await runScript(script);
  const value = extractValue(out, key);
  if (!value) throw new Error(`could not read ${key} from ${script} output`);
  if (appendExport(ENV_PATH, key, value)) console.log(`   saved ${key} to .env`);
}

/** Deploy (idempotent) and return the printed webhook URL, if any. */
async function deploy(): Promise<string | undefined> {
  console.log("\n-> deploying the orchestrator (idempotent)");
  const out = await runScript("scripts/deploy-orchestrator.ts");
  return extractValue(out, "PUBLIC_WEBHOOK_URL");
}

function planLabel(step: Step): string {
  switch (step) {
    case "create_env": return "create the self-hosted environment";
    case "gate_env_key": return "GATE: generate the environment key in the Console";
    case "provision": return "create the agent + base snapshot";
    case "gate_webhook": return "deploy, then GATE: register the webhook in the Console";
    case "finalize": return "deploy the orchestrator — then you're done";
  }
}

async function main(): Promise<void> {
  const planOnly = process.argv.includes("--plan");

  if (planOnly) {
    const env = loadEnv();
    printState(env);
    console.log(`\nnext: ${planLabel(decide(env))}`);
    return;
  }

  const interactive = isInteractive();

  // Phase 0 — prerequisites form. Interactively walk each required value
  // (confirming before overwriting anything already in .env); non-interactively
  // (CI/pipes) just fail fast if something is missing rather than hanging.
  if (interactive) {
    if (seedEnvFromExample(ENV_PATH, ENV_EXAMPLE_PATH)) {
      console.log("\ncreated .env from .env.example (fill in the values below).");
    }
    console.log("\nPrerequisites (Ctrl+C to abort; you'll be asked before overwriting anything already set):");
    const env0 = loadEnv();
    for (const spec of PREREQS) await ensureVar(env0, spec);
    await ensureTriggerMode(env0);
  } else {
    const env0 = loadEnv();
    const missing = PREREQS.filter((s) => !env0[s.key]).map((s) => s.key);
    if (missing.length) {
      throw new Error(`missing required env (non-interactive run): ${missing.join(", ")}`);
    }
  }

  let lastUrl: string | undefined;
  // Loop through autonomous steps until we hit a gate or finish. Each iteration
  // reloads .env so freshly-pasted keys take effect immediately.
  for (;;) {
    const env = loadEnv();
    printState(env);
    const step = decide(env);

    if (step === "create_env") {
      await ensureFromScript("creating the self-hosted environment", "scripts/create-environment.ts", ENV_ID);
      continue;
    }
    if (step === "gate_env_key") {
      gateEnvKey(env);
      if (interactive) {
        await ensureVar(env, ENV_KEY_SPEC);
        if (env[ENV_KEY]) continue;
      }
      manualTail(ENV_KEY_SPEC);
      return;
    }
    if (step === "provision") {
      if (!env[AGENT_ID]) await ensureFromScript("creating the agent", "scripts/create-agent.ts", AGENT_ID);
      if (!env[SNAPSHOT_ID]) await ensureFromScript("building the base snapshot", "scripts/build-snapshot.ts", SNAPSHOT_ID);
      continue;
    }
    if (step === "gate_webhook") {
      lastUrl = await deploy();
      gateWebhook(lastUrl);
      if (interactive) {
        await ensureVar(env, SIGNING_KEY_SPEC);
        if (env[SIGNING_KEY]) continue;
      }
      manualTail(SIGNING_KEY_SPEC);
      return;
    }
    // finalize
    await deploy();
    console.log("\nsetup complete — run `npm run run-session` to prove it end to end.");
    return;
  }
}

// Only run the flow when executed directly (`tsx scripts/bootstrap.ts`), never
// when imported (e.g. by the unit tests) — otherwise importing would trigger a
// real deploy.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`\nstopped: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

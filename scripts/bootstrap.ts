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

// --- presentation layer (colors + field/section rendering) -----------------
// Pure formatting; carries no logic. Colors collapse to '' when output is not a
// TTY or NO_COLOR is set, so piped/CI output stays plain.

const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const HOST = COLOR ? "\x1b[36m" : ""; // crisp cyan — var names, ✔ marker, separators
const WHITE = COLOR ? "\x1b[97m" : ""; // bright white — » marker, entered values
const DIM = COLOR ? "\x1b[90m" : ""; // gray (bright-black) — hints (↳), secret masks, tags
const RESET = COLOR ? "\x1b[0m" : "";

/** Glyphs: » = a value you supply, ✔ = a value a script produced. */
const MARK_USER = `${WHITE}»${RESET}`;
const MARK_DONE = `${HOST}✔${RESET}`;

// Fixed columns so every field lines up. Longest var name is
// ANTHROPIC_WEBHOOK_SIGNING_KEY (29); pad to 31 for breathing room.
const NAME_W = 31;
const MARK_INDENT = "   "; // 3 spaces before the glyph
const VALUE_COL = MARK_INDENT.length + 3 + NAME_W; // 3 + (glyph + 2 spaces) + NAME_W

/**
 * Style a prompt label: variable name / prose in HOST (dim cyan), any
 * parenthetical aside (URLs, hints) in DIM.
 */
function styleMessage(text: string): string {
  return text.replace(/(\([^)]*\))|([^(]+)/g, (_m, paren, rest) =>
    paren ? `${DIM}${paren}${RESET}` : `${HOST}${rest}${RESET}`,
  );
}

/** Shared inquirer theme: » prefix (white), label in HOST, entered value white. */
const PROMPT_THEME = {
  prefix: MARK_USER,
  style: { message: styleMessage, answer: (text: string) => `${WHITE}${text}${RESET}` },
};

/** Secrets render as a fixed mask on submit — never the real length. */
const SECRET_THEME = {
  ...PROMPT_THEME,
  style: { ...PROMPT_THEME.style, answer: () => `${DIM}········${RESET}` },
};

/** Wrap a hint to the terminal width on spaces only (never mid-token, e.g. URLs). */
function wrapHint(text: string, indentWidth: number): string[] {
  const width = (process.stdout.columns || 80) - indentWidth - 2; // minus "↳ "
  if (width <= 0 || text.length <= width) return [text];
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(" ")) {
    if (cur && cur.length + 1 + word.length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface FieldOpts {
  secret?: boolean; // mask the value
  last4?: string; // trailing chars to confirm a secret's identity
  done?: boolean; // ✔ (script produced it) vs » (you supplied it)
  hints?: string[]; // ↳ lines rendered under the value
}

/** Render one form field: `  ⟪marker⟫  NAME            value   ⟪tags⟫` + hint lines. */
function field(name: string, value: string, opts: FieldOpts = {}): void {
  const glyph = opts.done ? MARK_DONE : MARK_USER;
  const namePad = name.length >= NAME_W ? `${name} ` : name.padEnd(NAME_W);
  const valuePart = opts.secret
    ? `${DIM}········${opts.last4 ?? ""}${RESET}`
    : `${WHITE}${value}${RESET}`;
  const tag = opts.secret ? `   ${DIM}secret${RESET}` : "";
  const lines = [`${MARK_INDENT}${glyph}  ${HOST}${namePad}${RESET}${valuePart}${tag}`];
  const cont = " ".repeat(VALUE_COL);
  for (const hint of opts.hints ?? []) {
    wrapHint(hint, VALUE_COL).forEach((seg, i) => {
      lines.push(`${cont}${DIM}${i === 0 ? "↳ " : "  "}${seg}${RESET}`);
    });
  }
  console.log(lines.join("\n"));
}

/** A dashed section header, e.g. `┄┄ Credentials ┄┄┄┄┄…`. */
function sectionHeader(title: string): void {
  const left = `┄┄ ${title} `;
  const fill = "┄".repeat(Math.max(3, 56 - left.length));
  console.log(`\n${HOST}${left}${fill}${RESET}`);
}

/** Banner, printed once at the very top. */
function banner(): void {
  console.log(`\n${HOST}CREATING ANTHROPIC SELF-HOSTED AGENT${RESET}`);
}

/** Closing summary once everything is wired up. */
function footer(): void {
  console.log(`\n${HOST}✓${RESET} Setup complete.`);
  console.log(`  ${DIM}→${RESET} ${WHITE}npm run run-session${RESET}     to prove it end-to-end.`);
}

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
const BUDDY_REGION = "BUDDY_REGION";
const BUDDY_TOKEN = "BUDDY_TOKEN";
const BUDDY_WORKSPACE = "BUDDY_WORKSPACE";
const BUDDY_PROJECT = "BUDDY_PROJECT";

export interface VarSpec {
  key: string;
  label: string;
  secret?: boolean;
  /** When set, prompt with an arrow-key select over these choices instead of free text. */
  choices?: Array<{ name: string; value: string }>;
  /** Derive the prompt label from the current env (e.g. a region-specific URL). Overrides `label`. */
  labelFor?: (env: Record<string, string>) => string;
  /** Returns true if valid, or an error message string. */
  validate?: (value: string) => true | string;
}

/** Buddy security/PAT page per region (BUDDY_REGION value → URL). */
export function buddySecurityUrl(region: string | undefined): string {
  switch (region) {
    case "EU": return "https://eu.buddy.works/security";
    case "AP": return "https://asia.buddy.works/security";
    default: return "https://app.buddy.works/security";
  }
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
  { key: API_KEY, label: "ANTHROPIC_API_KEY (https://platform.claude.com/settings/keys)", secret: true, validate: requireValue("sk-ant-api03-") },
  {
    key: BUDDY_REGION,
    label: "BUDDY_REGION — Buddy region for sandboxes",
    choices: [
      { name: "US", value: "US" },
      { name: "EU", value: "EU" },
      { name: "Asia", value: "AP" },
    ],
  },
  {
    key: BUDDY_TOKEN,
    label: "BUDDY_TOKEN (Buddy personal access token)",
    labelFor: (env) => `BUDDY_TOKEN — generate Buddy personal access token with SANDBOX_MANAGE scope (${buddySecurityUrl(env[BUDDY_REGION])})`,
    secret: true,
    validate: requireValue(),
  },
  { key: BUDDY_WORKSPACE, label: "BUDDY_WORKSPACE (workspace domain)", validate: requireValue() },
  { key: BUDDY_PROJECT, label: "BUDDY_PROJECT (project name)", validate: requireValue() },
];

/** Console deep-link to the environment where the user clicks "Generate environment key". */
export function environmentKeyUrl(envId: string | undefined): string {
  return `https://platform.claude.com/workspaces/default/environments/${envId ?? ""}`;
}

const ENV_KEY_SPEC: VarSpec = {
  key: ENV_KEY,
  label: "ANTHROPIC_ENVIRONMENT_KEY (from the Console — sk-ant-oat01-…)",
  labelFor: (env) => `ANTHROPIC_ENVIRONMENT_KEY — Generate Environment key (${environmentKeyUrl(env[ENV_ID])})`,
  secret: true,
  validate: requireValue("sk-ant-oat01-"),
};
const WEBHOOK_URL = "PUBLIC_WEBHOOK_URL";

const SIGNING_KEY_SPEC: VarSpec = {
  key: SIGNING_KEY,
  label:
    "ANTHROPIC_WEBHOOK_SIGNING_KEY — generate Anthropic Webhook with session.status_run_started event (https://platform.claude.com/settings/workspaces/default/webhooks)",
  labelFor: (env) => {
    const endpoint = env[WEBHOOK_URL] ? ` pointing at ${env[WEBHOOK_URL]}` : "";
    return `ANTHROPIC_WEBHOOK_SIGNING_KEY — generate Anthropic Webhook${endpoint} subscribed to the session.status_run_started event (https://platform.claude.com/settings/workspaces/default/webhooks)`;
  },
  secret: true,
  validate: requireValue("whsec_"),
};

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
 * Run an async task behind a braille spinner that narrates `label` (dim cyan).
 * The spinner is purely transient: once the task settles its line is erased, so
 * the caller can render the finished step as a proper ✔ field. On a non-TTY
 * (CI/pipes) there is no animation at all.
 */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) return task();

  let i = 0;
  process.stdout.write("\x1B[?25l"); // hide cursor
  const render = () => {
    const frame = SPINNER_FRAMES[i] as string;
    i = (i + 1) % SPINNER_FRAMES.length;
    process.stdout.write(`\r\x1B[2K${MARK_INDENT}${HOST}${frame}  ${DIM}${label}…${RESET}`);
  };
  render();
  const timer = setInterval(render, 80);
  const clear = () => {
    clearInterval(timer);
    process.stdout.write(`\r\x1B[2K\x1B[?25h`); // erase line, restore cursor
  };
  try {
    return await task();
  } finally {
    clear();
  }
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
    field(spec.key, current, {
      secret: spec.secret,
      last4: spec.secret ? current.slice(-4) : undefined,
    });
    const overwrite = await confirm({ message: `Overwrite ${spec.key}?`, default: false, theme: PROMPT_THEME });
    if (!overwrite) return;
  }
  const label = spec.labelFor ? spec.labelFor(env) : spec.label;
  let value: string;
  if (spec.choices) {
    value = await select({ message: label, default: current, choices: spec.choices, theme: PROMPT_THEME });
  } else {
    value = (
      spec.secret
        ? await password({ message: label, mask: "•", validate: spec.validate, theme: SECRET_THEME })
        : await input({ message: label, validate: spec.validate, theme: PROMPT_THEME })
    ).trim();
  }
  appendExport(ENV_PATH, spec.key, value);
  env[spec.key] = value;
}

/** Prompt for the trigger mode (webhook vs polling) and persist the choice. */
async function ensureTriggerMode(env: Record<string, string>): Promise<void> {
  const current = isPollingMode(env) ? "polling" : "webhook";
  const mode = await select({
    message: "TRIGGER_MODE — how the orchestrator learns about queued work",
    default: current,
    theme: PROMPT_THEME,
    choices: [
      { name: "webhook — Anthropic POSTs to a public endpoint (lower latency, needs a signing secret)", value: "webhook" },
      { name: "polling — orchestrator long-polls the queue (no endpoint, no secret)", value: "polling" },
    ],
  });
  appendExport(ENV_PATH, TRIGGER_MODE, mode);
  env[TRIGGER_MODE] = mode;
}

/**
 * Run a cookbook script via tsx, capturing stdout silently (it's parsed for the
 * `KEY=value` line, not shown — the spinner narrates progress instead). stderr
 * streams through live, and on a non-zero exit the captured stdout is dumped so
 * failures stay debuggable.
 */
function runScript(rel: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, [rel], { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else {
        if (out.trim()) process.stderr.write(out.endsWith("\n") ? out : `${out}\n`);
        reject(new Error(`${rel} exited with code ${code}`));
      }
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

async function ensureFromScript(label: string, name: string, script: string, key: string): Promise<void> {
  const out = await withSpinner(label, () => runScript(script));
  const value = extractValue(out, key);
  if (!value) throw new Error(`could not read ${key} from ${script} output`);
  appendExport(ENV_PATH, key, value);
  field(name, value, { done: true });
}

/** Deploy (idempotent) and return the printed webhook URL, if any. */
async function deploy(): Promise<string | undefined> {
  const out = await withSpinner("deploying the orchestrator", () =>
    runScript("scripts/deploy-orchestrator.ts"),
  );
  const url = extractValue(out, "PUBLIC_WEBHOOK_URL");
  field("deploy orchestrator", "ready", { done: true, hints: url ? [url] : [] });
  return url;
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
      console.log(`\n${DIM}created .env from .env.example${RESET}`);
    }
    banner();
    sectionHeader("Credentials");
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

  if (interactive) sectionHeader("Provision & wire-up");

  let lastUrl: string | undefined;
  // Loop through autonomous steps until we hit a gate or finish. Each iteration
  // reloads .env so freshly-pasted keys take effect immediately.
  for (;;) {
    const env = loadEnv();
    const step = decide(env);
    // Only show the state table in non-interactive (CI) runs, where it's the
    // status report. In an interactive run it's just noise above the prompts and
    // script output, which already narrate progress on their own.
    if (!interactive) printState(env);

    if (step === "create_env") {
      await ensureFromScript("creating the self-hosted environment", "create self-hosted environment", "scripts/create-environment.ts", ENV_ID);
      continue;
    }
    if (step === "gate_env_key") {
      if (interactive) {
        await ensureVar(env, ENV_KEY_SPEC);
        if (env[ENV_KEY]) continue;
      } else {
        gateEnvKey(env);
      }
      manualTail(ENV_KEY_SPEC);
      return;
    }
    if (step === "provision") {
      if (!env[AGENT_ID]) await ensureFromScript("creating the agent", "create agent", "scripts/create-agent.ts", AGENT_ID);
      if (!env[SNAPSHOT_ID]) await ensureFromScript("building the base snapshot", "build base snapshot", "scripts/build-snapshot.ts", SNAPSHOT_ID);
      continue;
    }
    if (step === "gate_webhook") {
      lastUrl = await deploy();
      if (interactive) {
        // The signing-key prompt label carries the Console link, the endpoint
        // URL to register, and the event to subscribe to, so there's no separate
        // ">> NEXT" block to print.
        if (lastUrl) env[WEBHOOK_URL] = lastUrl;
        await ensureVar(env, SIGNING_KEY_SPEC);
        if (env[SIGNING_KEY]) continue;
      } else {
        gateWebhook(lastUrl);
      }
      manualTail(SIGNING_KEY_SPEC);
      return;
    }
    // finalize
    await deploy();
    footer();
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

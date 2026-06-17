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

const HINT_INDENT = 5; // spaces before the ↳ glyph
const HINT_BODY = HINT_INDENT + 2; // text column, just past "↳ "
const CHOICE_PAD = " ".repeat(HINT_INDENT); // prefix that aligns select choices with hints

/** Indent a select's choices so their text lines up with the ↳ hint column. */
function indentChoices<T extends { name: string }>(choices: T[]): T[] {
  return choices.map((c) => ({ ...c, name: `${CHOICE_PAD}${c.name}` }));
}
const RULE_W = 63; // width of banner / section rules

/** Mask a secret for display: fixed dots + the last 4 chars to confirm identity. */
function maskValue(value: string): string {
  return `········${value.slice(-4)}`;
}

/** Strip the protocol so links read tighter in hints. */
function shortUrl(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

/** Inquirer theme: label in HOST, parenthetical asides in DIM, value white. */
const PROMPT_THEME = {
  prefix: MARK_USER,
  style: {
    message: (text: string) =>
      text.replace(/(\([^)]*\))|([^(]+)/g, (_m, paren, rest) =>
        paren ? `${DIM}${paren}${RESET}` : `${HOST}${rest}${RESET}`,
      ),
    answer: (text: string) => `${WHITE}${text}${RESET}`,
  },
};
/**
 * Theme for the live input: it renders as one more `↳` line under the header
 * (`         ↳ Paste key: …`) rather than repeating the variable name.
 */
const CUE_THEME = {
  prefix: `${" ".repeat(HINT_INDENT)}${DIM}↳${RESET}`,
  style: {
    message: (text: string) => `${DIM}${text}${RESET}`,
    answer: (text: string) => `${WHITE}${text}${RESET}`,
  },
};

/** On submit, fully erase the live prompt — the polished field() line replaces it. */
const ERASE_ON_DONE = { clearPromptOnDone: true } as const;

/** A hint line under a field: a bare note/link, or an aligned `label  value` pair. */
type Hint = string | { label: string; value: string };

/** Greedy word-wrap; hard-breaks a single token longer than the column (e.g. a URL). */
function wrap(text: string, width: number): string[] {
  if (width < 8) return [text];
  const out: string[] = [];
  let cur = "";
  for (let word of text.split(" ")) {
    if (word.length > width) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      while (word.length > width) {
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      cur = word;
    } else if (cur && cur.length + 1 + word.length > width) {
      out.push(cur);
      cur = word;
    } else {
      cur = cur ? `${cur} ${word}` : word;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Render the ↳ hint lines under a field. Bare hints come first, then aligned pairs. */
function renderHints(hints: Hint[]): string[] {
  const cols = process.stdout.columns || 80;
  const labelW = Math.max(0, ...hints.map((h) => (typeof h === "string" ? 0 : h.label.length)));
  const out: string[] = [];
  for (const hint of hints) {
    if (typeof hint === "string") {
      wrap(hint, cols - HINT_BODY).forEach((seg, i) =>
        out.push(`${" ".repeat(HINT_INDENT)}${DIM}${i === 0 ? "↳ " : "  "}${seg}${RESET}`),
      );
    } else {
      const valueCol = HINT_BODY + labelW + 2;
      wrap(hint.value, cols - valueCol).forEach((seg, i) =>
        out.push(
          i === 0
            ? `${" ".repeat(HINT_INDENT)}${DIM}↳ ${hint.label.padEnd(labelW)}  ${seg}${RESET}`
            : `${" ".repeat(valueCol)}${DIM}${seg}${RESET}`,
        ),
      );
    }
  }
  return out;
}

interface FieldOpts {
  done?: boolean; // ✔ (script produced it) vs » (you supplied it)
  value?: string; // shown as `: value` after the name (e.g. an id a ✔ step produced)
  note?: string; // dim aside after the name, e.g. on a value-less ✔ step
  hints?: Hint[]; // ↳ lines rendered under the field
}

/** The header line for a field: `»  NAME` (you supply) or `✔  NAME: value` (script did). */
function headerLine(name: string, opts: { done?: boolean; value?: string; note?: string } = {}): string {
  const glyph = opts.done ? MARK_DONE : MARK_USER;
  const body = opts.value ? `${HOST}${name}:${RESET} ${WHITE}${opts.value}${RESET}` : `${HOST}${name}${RESET}`;
  const note = opts.note ? `  ${DIM}${opts.note}${RESET}` : "";
  return `${glyph}  ${body}${note}`;
}

/** A `↳ <cue> <value>` line — the entered value (masked for secrets) under its prompt. */
function valueHintLine(cue: string, value: string, secret: boolean): string {
  return `${" ".repeat(HINT_INDENT)}${DIM}↳ ${cue} ${WHITE}${secret ? maskValue(value) : value}${RESET}`;
}

/** The input cue shown as the field's last ↳ line. */
function cueFor(spec: VarSpec): string {
  return spec.cue ?? (spec.choices ? "Choose:" : spec.secret ? "Paste key:" : "Enter value:");
}

/** Render a field: its header line plus any ↳ hint lines. */
function field(name: string, opts: FieldOpts = {}): void {
  console.log([headerLine(name, opts), ...renderHints(opts.hints ?? [])].join("\n"));
}

/** A dashed section header, e.g. `┄┄ Credentials ┄┄┄┄┄…`. */
function sectionHeader(title: string): void {
  const left = `┄┄ ${title} `;
  console.log(`\n${HOST}${left}${"┄".repeat(Math.max(3, RULE_W - left.length))}${RESET}`);
}

/** Banner, printed once at the very top. */
function banner(): void {
  const left = "═══ cma-buddy-sandboxes · bootstrap ";
  console.log(`\n${HOST}${left}${"═".repeat(Math.max(3, RULE_W - left.length))}${RESET}`);
}

/** Closing summary once everything is wired up. */
function footer(): void {
  console.log();
  field("Setup complete", { done: true, hints: [{ label: "Run session to test it:", value: "npm run session" }] });
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
  /** ↳ hint lines under the field; the `Open:` link comes first, then params. */
  hintsFor?: (env: Record<string, string>) => Hint[];
  /** Override the input cue (the field's last ↳ line), e.g. "Paste signing secret:". */
  cue?: string;
}

/** Buddy "add personal access token" page per region (BUDDY_REGION value → URL). */
export function buddyTokenUrl(region: string | undefined): string {
  switch (region) {
    case "EU": return "https://eu.buddy.works/api-tokens/add";
    case "AP": return "https://asia.buddy.works/api-tokens/add";
    default: return "https://app.buddy.works/api-tokens/add";
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
  {
    key: API_KEY,
    label: "ANTHROPIC_API_KEY (https://platform.claude.com/settings/keys)",
    secret: true,
    validate: requireValue("sk-ant-api03-"),
    hintsFor: () => ["Open: platform.claude.com/settings/keys"],
  },
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
    labelFor: (env) => `BUDDY_TOKEN — generate Buddy personal access token with SANDBOX_MANAGE scope (${buddyTokenUrl(env[BUDDY_REGION])})`,
    secret: true,
    validate: requireValue(),
    hintsFor: (env) => [`Open: ${shortUrl(buddyTokenUrl(env[BUDDY_REGION]))}`, "Scope: SANDBOX_MANAGE"],
  },
  { key: BUDDY_WORKSPACE, label: "BUDDY_WORKSPACE (workspace domain)", validate: requireValue() },
  { key: BUDDY_PROJECT, label: "BUDDY_PROJECT (project name)", validate: requireValue() },
];

/** Console deep-link to the environment where the user clicks "Generate environment key". */
export function environmentKeyUrl(envId: string | undefined): string {
  return `https://platform.claude.com/workspaces/default/environments/${envId ?? ""}`;
}

const WEBHOOK_SETTINGS_URL = "https://platform.claude.com/settings/workspaces/default/webhooks";

const ENV_KEY_SPEC: VarSpec = {
  key: ENV_KEY,
  label: "ANTHROPIC_ENVIRONMENT_KEY (from the Console — sk-ant-oat01-…)",
  labelFor: (env) => `ANTHROPIC_ENVIRONMENT_KEY — Generate Environment key (${environmentKeyUrl(env[ENV_ID])})`,
  secret: true,
  validate: requireValue("sk-ant-oat01-"),
  hintsFor: (env) => [`Open: ${shortUrl(environmentKeyUrl(env[ENV_ID]))}`],
};
const WEBHOOK_URL = "PUBLIC_WEBHOOK_URL";

const SIGNING_KEY_SPEC: VarSpec = {
  key: SIGNING_KEY,
  label:
    "ANTHROPIC_WEBHOOK_SIGNING_KEY — generate Anthropic Webhook with session.status_run_started event (https://platform.claude.com/settings/workspaces/default/webhooks)",
  labelFor: (env) => {
    const endpoint = env[WEBHOOK_URL] ? ` pointing at ${env[WEBHOOK_URL]}` : "";
    return `ANTHROPIC_WEBHOOK_SIGNING_KEY — generate Anthropic Webhook${endpoint} subscribed to the session.status_run_started event (${WEBHOOK_SETTINGS_URL})`;
  },
  secret: true,
  validate: requireValue("whsec_"),
  cue: "Paste signing secret:",
  hintsFor: (env) => [
    `Open: ${shortUrl(WEBHOOK_SETTINGS_URL)}`,
    ...(env[WEBHOOK_URL] ? [{ label: "Endpoint:", value: env[WEBHOOK_URL] } as Hint] : []),
    { label: "Event:", value: "session.status_run_started" },
  ],
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
    process.stdout.write(`\r\x1B[2K${HOST}${frame}  ${DIM}${label}…${RESET}`);
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
 * Print the field header (`»  NAME`) with its hints expanded *first*, then prompt
 * on the line below — so you read the `Open:`/`Scope:` hints before typing. The
 * live prompt renders as the field's last `↳ <cue>` line; on submit it's erased
 * and reprinted as `↳ <cue> <value>` (the value masked for secrets), so the cue
 * stays put with the entered value beside it. Returns the entered value.
 */
async function promptInPlace(env: Record<string, string>, spec: VarSpec, current?: string): Promise<string> {
  const hintLines = renderHints(spec.hintsFor?.(env) ?? []);
  console.log([headerLine(spec.key), ...hintLines].join("\n"));

  const cue = cueFor(spec);
  let value: string;
  if (spec.choices) {
    value = await select({ message: cue, default: current, choices: indentChoices(spec.choices), theme: CUE_THEME }, ERASE_ON_DONE);
  } else {
    value = (
      spec.secret
        ? await password({ message: cue, mask: "•", validate: spec.validate, theme: CUE_THEME }, ERASE_ON_DONE)
        : await input({ message: cue, validate: spec.validate, theme: CUE_THEME }, ERASE_ON_DONE)
    ).trim();
  }
  console.log(valueHintLine(cue, value, Boolean(spec.secret)));
  return value;
}

async function ensureVar(env: Record<string, string>, spec: VarSpec): Promise<void> {
  const current = env[spec.key];
  if (current) {
    // Confirm (and erase) before any field renders, so "keep" leaves one block.
    const shown = spec.secret ? `…${current.slice(-4)}` : current;
    const overwrite = await confirm(
      { message: `${spec.key} is set (${shown}) — overwrite?`, default: false, theme: PROMPT_THEME },
      ERASE_ON_DONE,
    );
    if (!overwrite) {
      console.log(
        [
          headerLine(spec.key),
          ...renderHints(spec.hintsFor?.(env) ?? []),
          valueHintLine(cueFor(spec), current, Boolean(spec.secret)),
        ].join("\n"),
      );
      return;
    }
  }
  const value = await promptInPlace(env, spec, current);
  appendExport(ENV_PATH, spec.key, value);
  env[spec.key] = value;
}

/** Prompt for the trigger mode (webhook vs polling) and persist the choice. */
async function ensureTriggerMode(env: Record<string, string>): Promise<void> {
  const current = isPollingMode(env) ? "polling" : "webhook";
  console.log(headerLine(TRIGGER_MODE));
  const mode = await select(
    {
      message: "Choose:",
      default: current,
      theme: CUE_THEME,
      choices: indentChoices([
        { name: "webhook — Anthropic POSTs to a public endpoint (lower latency, needs a signing secret)", value: "webhook" },
        { name: "polling — orchestrator long-polls the queue (no endpoint, no secret)", value: "polling" },
      ]),
    },
    ERASE_ON_DONE,
  );
  appendExport(ENV_PATH, TRIGGER_MODE, mode);
  env[TRIGGER_MODE] = mode;
  console.log(valueHintLine("Choose:", mode, false));
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
  field(name, { done: true, value });
}

/** Deploy (idempotent) and return the printed webhook URL, if any. */
async function deploy(): Promise<string | undefined> {
  const out = await withSpinner("Deploying the orchestrator", () =>
    runScript("scripts/deploy-orchestrator.ts"),
  );
  field("Deploy orchestrator", { done: true, note: "(idempotent)" });
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
    banner();
    console.log();
    if (seedEnvFromExample(ENV_PATH, ENV_EXAMPLE_PATH)) {
      console.log("Created .env from .env.example.");
    }
    console.log(`${DIM}Ctrl+C to abort · existing values are confirmed before overwrite.${RESET}`);
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
      await ensureFromScript("Creating the self-hosted environment", "Claude self-hosted environment", "scripts/create-environment.ts", ENV_ID);
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
      if (!env[AGENT_ID]) await ensureFromScript("Creating the agent", "Claude agent", "scripts/create-agent.ts", AGENT_ID);
      if (!env[SNAPSHOT_ID]) await ensureFromScript("Building the base snapshot", "Base snapshot", "scripts/build-snapshot.ts", SNAPSHOT_ID);
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

/**
 * Central, typed configuration. Importing this loads `.env` (via dotenv) once.
 *
 * Tunables resolve eagerly with safe defaults so this module is import-safe in
 * tests. Secrets/ids are exposed as `require*()` functions that throw a clear
 * error only when actually needed, so unit tests never need real credentials.
 */
import "dotenv/config";

import type { CreateFromSnapshotConfig, Region } from "@buddy-works/sandbox-sdk";

function str(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : undefined;
}

export function requireEnv(name: string): string {
  const v = str(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = str(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name);
  if (v === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export type SandboxResources = NonNullable<CreateFromSnapshotConfig["resources"]>;

export const BETA = str("ANTHROPIC_BETA") ?? "managed-agents-2026-04-01";

/**
 * How the orchestrator learns there is queued work to dispatch.
 *
 * - `webhook`: Anthropic POSTs `session.status_run_started` to the orchestrator's
 *   public HTTP endpoint (primary trigger); a safety-net poll loop and the
 *   janitor's crash recovery back it up. Requires `ANTHROPIC_WEBHOOK_SIGNING_KEY`.
 * - `polling`: the orchestrator long-polls the work queue continuously as its
 *   only trigger — no inbound endpoint, no webhook secret. The poll loop also
 *   covers crash recovery, so the janitor leaves that case alone.
 */
export type TriggerMode = "webhook" | "polling";

function triggerMode(): TriggerMode {
  const v = str("TRIGGER_MODE")?.toLowerCase();
  return v === "polling" ? "polling" : "webhook";
}

export const CONFIG = {
  beta: BETA,

  // Trigger
  triggerMode: triggerMode(),

  // Worker runtime
  antVersion: str("ANT_VERSION") ?? "1.10.0",
  antMaxIdle: str("ANT_MAX_IDLE") ?? "60s",
  workerResources: (str("WORKER_RESOURCES") ?? "2x4") as SandboxResources,
  workerIdleTimeoutSec: num("WORKER_IDLE_TIMEOUT_SEC", 900),
  workspaceDir: str("WORKSPACE_DIR") ?? "/workspace",

  // Orchestrator
  orchPort: num("ORCH_PORT", 8080),
  orchestratorResources: (str("ORCHESTRATOR_RESOURCES") ?? "1x2") as SandboxResources,
  dispatcherDebounceMs: num("DISPATCHER_DEBOUNCE_MS", 250),
  dispatcherPollBlockMs: num("DISPATCHER_POLL_BLOCK_MS", 999),
  dispatcherReclaimMs: num("DISPATCHER_RECLAIM_MS", 30000),
  runStartAttempts: num("RUN_START_ATTEMPTS", 10),

  // Janitor / polling
  janitorSeconds: num("JANITOR_SECONDS", 60),
  maxIdleDays: num("MAX_IDLE_DAYS", 7),
  pollerEnabled: bool("POLLER_ENABLED", true),

  // Buddy connection
  region: (str("BUDDY_REGION") ?? "US") as Region,
  tunnelRegion: (str("BUDDY_TUNNEL_REGION") ?? "US") as "US" | "EU" | "AS",

  // Optional Anthropic overrides
  baseUrl: str("ANTHROPIC_BASE_URL"),
  agentModel: str("ANTHROPIC_AGENT_MODEL") ?? "claude-opus-4-8",
} as const;

// Required-on-demand accessors (throw with a clear message if unset).
export const requireEnvironmentId = () => requireEnv("ANTHROPIC_ENVIRONMENT_ID");
export const requireEnvironmentKey = () => requireEnv("ANTHROPIC_ENVIRONMENT_KEY");
export const requireApiKey = () => requireEnv("ANTHROPIC_API_KEY");
export const requireAgentId = () => requireEnv("ANTHROPIC_AGENT_ID");
export const requireBaseSnapshotId = () => requireEnv("BUDDY_BASE_SNAPSHOT_ID");
export const webhookSigningKey = () => str("ANTHROPIC_WEBHOOK_SIGNING_KEY");

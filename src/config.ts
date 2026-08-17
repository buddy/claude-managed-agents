/**
 * Central, typed configuration. Importing this loads `.env` (via dotenv) once.
 *
 * Tunables resolve eagerly with safe defaults so this module is import-safe in
 * tests. Secrets/ids are exposed as `require*()` functions that throw a clear
 * error only when actually needed, so unit tests never need real credentials.
 */
import "dotenv/config";

import { REGIONS } from "@buddy-works/sandbox-sdk";
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

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name);
  if (v === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(v)) {
    throw new Error(`config: invalid ${name}=${JSON.stringify(v)}; expected one of: ${allowed.join(", ")}`);
  }
  return v as T;
}

export type SandboxResources = NonNullable<CreateFromSnapshotConfig["resources"]>;

const SANDBOX_RESOURCES = [
  "1x2", "2x4", "3x6", "4x8", "5x10", "6x12",
  "7x14", "8x16", "9x18", "10x20", "11x22", "12x24", "CUSTOM",
] as const satisfies readonly SandboxResources[];

function resourceSpec(name: string, fallback: SandboxResources): SandboxResources {
  return oneOf(name, SANDBOX_RESOURCES, fallback);
}

type TunnelRegion = NonNullable<CreateFromSnapshotConfig["endpoints"]>[number]["region"];

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
  antVersion: str("ANT_VERSION") ?? "1.23.0",
  antMaxIdle: str("ANT_MAX_IDLE") ?? "60s",
  workerResources: (str("WORKER_RESOURCES") ?? "2x4") as SandboxResources,
  workerIdleTimeoutSec: num("WORKER_IDLE_TIMEOUT_SEC", 900),
  workspaceDir: str("WORKSPACE_DIR") ?? "/workspace",

  // Orchestrator
  orchPort: num("ORCH_PORT", 8080),
  orchestratorResources: resourceSpec("ORCHESTRATOR_RESOURCES", "1x2"),
  dispatcherDebounceMs: num("DISPATCHER_DEBOUNCE_MS", 250),
  dispatcherPollBlockMs: num("DISPATCHER_POLL_BLOCK_MS", 999),
  dispatcherReclaimMs: num("DISPATCHER_RECLAIM_MS", 30000),
  runStartAttempts: num("RUN_START_ATTEMPTS", 10),

  // Janitor / polling
  janitorSeconds: num("JANITOR_SECONDS", 60),
  maxIdleDays: num("MAX_IDLE_DAYS", 7),
  pollerEnabled: bool("POLLER_ENABLED", true),

  // Buddy connection
  region: oneOf<Region>("BUDDY_REGION", Object.values(REGIONS), "US"),
  tunnelRegion: oneOf<TunnelRegion>("BUDDY_TUNNEL_REGION", ["US", "EU", "AS"] as const, "US"),

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

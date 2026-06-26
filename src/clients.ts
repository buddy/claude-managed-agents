/**
 * Client factories. Two distinct Anthropic credentials, by design:
 *   - environment-key client  → poll/ack/stop work, retrieve sessions, verify
 *     webhooks. This is what the orchestrator and workers use.
 *   - admin (API-key) client  → create environments/agents/sessions. LOCAL only.
 *
 * The Buddy SDK reads BUDDY_* from the environment by default; `buddyConnection()`
 * makes that explicit so the same config flows whether we run locally or inside
 * the orchestrator sandbox.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ConnectionConfig } from "@buddy-works/sandbox-sdk";

import { CONFIG, requireApiKey, requireEnvironmentKey } from "./config.js";

export { BETA } from "./config.js";

export function anthropicEnvClient(): Anthropic {
  return new Anthropic({
    authToken: requireEnvironmentKey(),
    ...(CONFIG.baseUrl ? { baseURL: CONFIG.baseUrl } : {}),
  });
}

export function anthropicAdminClient(): Anthropic {
  return new Anthropic({
    apiKey: requireApiKey(),
    ...(CONFIG.baseUrl ? { baseURL: CONFIG.baseUrl } : {}),
  });
}

/** Explicit Buddy connection from env, or undefined to let the SDK read env itself. */
export function buddyConnection(): ConnectionConfig | undefined {
  // Prefer CMA_BUDDY_TOKEN (the workspace token we inject into the orchestrator
  // sandbox) over the sandbox's auto-injected, self-scoped BUDDY_TOKEN. Locally,
  // only BUDDY_TOKEN is set, so scripts keep working off `.env`.
  const token = process.env.CMA_BUDDY_TOKEN?.trim() || process.env.BUDDY_TOKEN?.trim();
  if (!token) return undefined;
  return {
    token,
    workspace: process.env.BUDDY_WORKSPACE?.trim(),
    project: process.env.BUDDY_PROJECT?.trim(),
    region: CONFIG.region,
  };
}

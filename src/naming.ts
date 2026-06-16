/**
 * Pure naming helpers. Buddy identifiers allow only lowercase alphanumerics,
 * underscores, and hyphens, with no leading/trailing hyphen. Anthropic ids look
 * like `sesn_01AbC...` / `work_01...`, so the underscore (and any unexpected
 * char) maps to a hyphen and the id is bounded so names stay short.
 *
 * No I/O here — heavily unit-tested.
 */

export const WORKER_PREFIX = "cma-worker-";

/** Lowercase, replace any non `[a-z0-9-]` with `-`, collapse repeats, trim hyphens, bound length. */
export function sanitize(raw: string, maxLen = 40): string {
  const lowered = (raw ?? "").toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-");
  const trimmed = replaced.replace(/^-+/, "").replace(/-+$/, "");
  return trimmed.slice(0, maxLen).replace(/-+$/, "");
}

/** Stable per-session worker sandbox identifier: `cma-worker-<sanitized session id>`. */
export function workerIdentifier(sessionId: string): string {
  return `${WORKER_PREFIX}${sanitize(sessionId)}`;
}

/** True for a Buddy sandbox we manage as a worker (matched from list() by identifier). */
export function isWorkerIdentifier(identifier: string | undefined | null): boolean {
  return typeof identifier === "string" && identifier.startsWith(WORKER_PREFIX);
}

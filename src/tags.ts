/**
 * Buddy sandbox tags. We keep these to characters Buddy accepts (alphanumerics
 * and hyphens) — NO colons, and we never encode Anthropic ids (which contain
 * `_`) into tags. The janitor recovers exact ids from sandbox **variables**
 * (`ANTHROPIC_ENVIRONMENT_ID`, `ANTHROPIC_SESSION_ID`) and the work id from the
 * `ant` command text, so tags only carry a coarse marker plus a digits-only
 * stopped-at timestamp.
 */

export const TAG_MARKER = "cma";
const STOPPED_AT_PREFIX = "cma-stopped-at-";

/** Tags applied to a managed worker sandbox at creation. */
export function workerTags(): string[] {
  return [TAG_MARKER];
}

/** Tags applied to the orchestrator sandbox. */
export function orchestratorTags(): string[] {
  return [TAG_MARKER, "cma-orchestrator"];
}

export function isManaged(tags: string[] | undefined): boolean {
  return (tags ?? []).includes(TAG_MARKER);
}

/** `cma-stopped-at-<epochMs>` — digits only, always tag-safe. */
export function stoppedAtTag(epochMs: number): string {
  return `${STOPPED_AT_PREFIX}${epochMs}`;
}

export function parseStoppedAtMs(tags: string[] | undefined): number | undefined {
  for (const t of tags ?? []) {
    if (t.startsWith(STOPPED_AT_PREFIX)) {
      const n = Number(t.slice(STOPPED_AT_PREFIX.length));
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

export function withoutStoppedAtTag(tags: string[] | undefined): string[] {
  return (tags ?? []).filter((t) => !t.startsWith(STOPPED_AT_PREFIX));
}

/** Read a plaintext sandbox variable value by key (encrypted values are absent). */
export function readVariable(
  variables: Array<{ key?: string; value?: string }> | undefined,
  key: string,
): string | undefined {
  for (const v of variables ?? []) {
    if (v.key === key) return v.value;
  }
  return undefined;
}

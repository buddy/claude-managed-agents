export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Single-quote a value for safe interpolation into a BASH command string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Best-effort 404 detection across Anthropic (`status`) and Buddy (`statusCode`) SDK errors. */
export function isNotFound(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; message?: string } | null;
  return e?.status === 404 || e?.statusCode === 404 || /not found/i.test(e?.message ?? "");
}

export function errLabel(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

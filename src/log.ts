/** Tiny structured logger. One line per event, JSON-friendly fields appended. */

type Level = "info" | "warn" | "error";

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>): void {
  const parts = [`[${scope}]`, msg];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function makeLogger(scope: string) {
  return {
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", scope, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", scope, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", scope, msg, fields),
  };
}

export type Logger = ReturnType<typeof makeLogger>;

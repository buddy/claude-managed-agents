/**
 * Runner-alive probe + work-id recovery. Buddy has no per-process state RPC, but
 * `listCommands()` exposes each command's text and status. `ant beta:worker run`
 * is the only long-running command we launch on a worker, so the worker has a
 * live runner iff some command whose text contains the marker is INPROGRESS, and
 * the current work id can be read back from that command's `ANTHROPIC_WORK_ID=…`.
 *
 * (We can't stamp a custom command name — `runCommand` only accepts
 * `{ command, runtime }` — so we match on the command text.)
 */
import type { CommandLike, SandboxLike } from "./types.js";

export const ANT_RUN_MARKER = "ant beta:worker run";

const WORK_ID_RE = /ANTHROPIC_WORK_ID='([^']+)'/;

function antRunCommands(commands: CommandLike[]): CommandLike[] {
  return commands.filter((c) => (c.data.command ?? "").includes(ANT_RUN_MARKER));
}

/** True if some `ant beta:worker run` command is still INPROGRESS. */
export function hasLiveAntRun(commands: CommandLike[]): boolean {
  return antRunCommands(commands).some((c) => c.data.status === "INPROGRESS");
}

/** Recover the work id from the most recent `ant beta:worker run` command, if any. */
export function latestAntWorkId(commands: CommandLike[]): string | undefined {
  const ant = antRunCommands(commands);
  const last = ant[ant.length - 1];
  const m = WORK_ID_RE.exec(last?.data.command ?? "");
  return m?.[1];
}

export async function isRunnerAlive(sb: SandboxLike): Promise<boolean> {
  try {
    return hasLiveAntRun(await sb.listCommands());
  } catch {
    return false;
  }
}

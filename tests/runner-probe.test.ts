import { describe, expect, it, vi } from "vitest";

import { ANT_RUN_MARKER, isRunnerAlive, latestAntWorkId } from "../src/runner-probe.ts";
import type { CommandLike, SandboxLike } from "../src/types.ts";

function sandboxWithCommands(commands: Array<{ command?: string; status?: string }>): SandboxLike {
  return {
    listCommands: vi.fn(async () => commands.map((c) => ({ data: c }))),
  } as unknown as SandboxLike;
}

describe("isRunnerAlive", () => {
  it("true when an ant beta:worker run command is INPROGRESS", async () => {
    const sb = sandboxWithCommands([{ command: `... ${ANT_RUN_MARKER} --max-idle 60s`, status: "INPROGRESS" }]);
    expect(await isRunnerAlive(sb)).toBe(true);
  });
  it("false when the ant command already finished", async () => {
    const sb = sandboxWithCommands([{ command: `${ANT_RUN_MARKER} ...`, status: "SUCCESSFUL" }]);
    expect(await isRunnerAlive(sb)).toBe(false);
  });
  it("false for unrelated in-progress commands", async () => {
    const sb = sandboxWithCommands([{ command: "npm install", status: "INPROGRESS" }]);
    expect(await isRunnerAlive(sb)).toBe(false);
  });
  it("false when listCommands throws", async () => {
    const sb = { listCommands: vi.fn(async () => { throw new Error("boom"); }) } as unknown as SandboxLike;
    expect(await isRunnerAlive(sb)).toBe(false);
  });
});

describe("latestAntWorkId", () => {
  const antRun = (workId: string, started_at?: string): CommandLike => ({
    data: { command: `ANTHROPIC_WORK_ID='${workId}' ${ANT_RUN_MARKER} --max-idle 60s`, status: "SUCCESSFUL", started_at },
  });

  it("picks the newest run when the list is newest first, as the API returns it", () => {
    const commands = [antRun("work_new", "2026-11-20T10:00:00Z"), antRun("work_old", "2026-11-20T09:00:00Z")];
    expect(latestAntWorkId(commands)).toBe("work_new");
  });
  it("picks by start time, whatever the list order", () => {
    const commands = [antRun("work_old", "2026-11-20T09:00:00Z"), antRun("work_new", "2026-11-20T10:00:00Z")];
    expect(latestAntWorkId(commands)).toBe("work_new");
  });
  it("falls back to the API's newest-first order without start times", () => {
    expect(latestAntWorkId([antRun("work_new"), antRun("work_old")])).toBe("work_new");
  });
  it("ignores unrelated commands and returns undefined without an ant run", () => {
    const other: CommandLike = { data: { command: "ANTHROPIC_WORK_ID='work_x' npm install", started_at: "2026-11-20T11:00:00Z" } };
    expect(latestAntWorkId([other, antRun("work_a", "2026-11-20T08:00:00Z")])).toBe("work_a");
    expect(latestAntWorkId([other])).toBeUndefined();
  });
});

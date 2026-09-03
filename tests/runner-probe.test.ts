import { describe, expect, it, vi } from "vitest";

import { ANT_RUN_MARKER, isRunnerAlive } from "../src/runner-probe.ts";
import type { SandboxLike } from "../src/types.ts";

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

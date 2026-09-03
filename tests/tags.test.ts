import { describe, expect, it } from "vitest";

import {
  isManaged,
  orchestratorTags,
  parseStoppedAtMs,
  readVariable,
  stoppedAtTag,
  withoutStoppedAtTag,
  workerTags,
} from "../src/tags.ts";

describe("tags", () => {
  it("worker/orchestrator tags use only safe characters (no colons)", () => {
    for (const t of [...workerTags(), ...orchestratorTags()]) {
      expect(t).toMatch(/^[a-z0-9-]+$/);
    }
    expect(isManaged(workerTags())).toBe(true);
    expect(isManaged(["something-else"])).toBe(false);
  });

  it("stopped-at tag is digits-only and round-trips", () => {
    const ms = 1_718_524_800_000;
    const tag = stoppedAtTag(ms);
    expect(tag).toBe(`cma-stopped-at-${ms}`);
    expect(tag).toMatch(/^[a-z0-9-]+$/);
    expect(parseStoppedAtMs(["cma", tag])).toBe(ms);
    expect(parseStoppedAtMs(["cma"])).toBeUndefined();
  });

  it("withoutStoppedAtTag drops only the stopped-at tag", () => {
    const tags = ["cma", stoppedAtTag(123)];
    expect(withoutStoppedAtTag(tags)).toEqual(["cma"]);
  });
});

describe("readVariable", () => {
  it("returns the value of a plaintext variable by key", () => {
    const vars = [
      { key: "ANTHROPIC_ENVIRONMENT_ID", value: "env_01" },
      { key: "ANTHROPIC_SESSION_ID", value: "sesn_02" },
    ];
    expect(readVariable(vars, "ANTHROPIC_SESSION_ID")).toBe("sesn_02");
    expect(readVariable(vars, "MISSING")).toBeUndefined();
    expect(readVariable(undefined, "X")).toBeUndefined();
  });
});

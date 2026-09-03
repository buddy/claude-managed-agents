import { describe, expect, it } from "vitest";

import { isWorkerIdentifier, sanitize, WORKER_PREFIX, workerIdentifier } from "../src/naming.ts";

describe("sanitize", () => {
  it("lowercases and maps non [a-z0-9-] to hyphens", () => {
    expect(sanitize("Sesn_01AbC")).toBe("sesn-01abc");
  });
  it("collapses repeats and trims leading/trailing hyphens", () => {
    expect(sanitize("__a__b__")).toBe("a-b");
  });
  it("bounds length without leaving a trailing hyphen", () => {
    const out = sanitize("a".repeat(50) + "-".repeat(10), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("-")).toBe(false);
  });
  it("handles empty input", () => {
    expect(sanitize("")).toBe("");
  });
});

describe("workerIdentifier", () => {
  it("prefixes and sanitizes the session id", () => {
    expect(workerIdentifier("sesn_01XYZ")).toBe(`${WORKER_PREFIX}sesn-01xyz`);
  });
  it("round-trips through isWorkerIdentifier", () => {
    expect(isWorkerIdentifier(workerIdentifier("sesn_1"))).toBe(true);
    expect(isWorkerIdentifier("cma-orchestrator")).toBe(false);
    expect(isWorkerIdentifier(undefined)).toBe(false);
  });
});

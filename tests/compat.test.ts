import { describe, expect, it } from "vitest";

import { antVersionProblem, BASE_SNAPSHOT_PREFIX, baseSnapshotProblem } from "../src/compat.ts";

describe("antVersionProblem", () => {
  it("accepts ant 2.x and later", () => {
    expect(antVersionProblem("2.11.0")).toBeUndefined();
    expect(antVersionProblem("10.0.0")).toBeUndefined();
  });
  it("refuses ant 1.x and versions it cannot parse", () => {
    expect(antVersionProblem("1.23.0")).toContain("too old");
    expect(antVersionProblem("latest")).toContain("too old");
  });
});

describe("baseSnapshotProblem", () => {
  const current = { id: "snap_new", name: `${BASE_SNAPSHOT_PREFIX}1795000000000` };
  const old = { id: "snap_old", name: "cma-base-1795000000000" };

  it("accepts a snapshot built with the current layout", () => {
    expect(baseSnapshotProblem([old, current], "snap_new")).toBeUndefined();
  });
  it("refuses a snapshot built before the work-secret change", () => {
    expect(baseSnapshotProblem([old, current], "snap_old")).toContain("built before");
  });
  it("refuses a snapshot that does not exist", () => {
    expect(baseSnapshotProblem([current], "snap_gone")).toContain("not found");
  });
});

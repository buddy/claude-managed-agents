import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendExport, decide, extractValue, mergeEnv, parseEnvText } from "../scripts/bootstrap.js";

describe("parseEnvText", () => {
  it("tolerates export, quotes, and comments", () => {
    const env = parseEnvText(
      ["# comment", "export A=1", 'B="two"', "C='three'", "  D=4  ", "blank", ""].join("\n"),
    );
    expect(env).toEqual({ A: "1", B: "two", C: "three", D: "4" });
  });
});

describe("mergeEnv", () => {
  it("lets non-empty .env values win over process env", () => {
    const merged = mergeEnv({ A: "proc", B: "proc" }, { A: "file", B: "", C: "filec" });
    expect(merged).toEqual({ A: "file", B: "proc", C: "filec" });
  });
});

describe("extractValue", () => {
  it("pulls a KEY=value line out of mixed output", () => {
    const out = "created environment env_99\n\nANTHROPIC_ENVIRONMENT_ID=env_99\n\nNext: ...";
    expect(extractValue(out, "ANTHROPIC_ENVIRONMENT_ID")).toBe("env_99");
    expect(extractValue(out, "NOPE")).toBeUndefined();
  });
});

describe("decide", () => {
  const full = {
    ANTHROPIC_ENVIRONMENT_ID: "e",
    ANTHROPIC_ENVIRONMENT_KEY: "k",
    ANTHROPIC_AGENT_ID: "a",
    BUDDY_BASE_SNAPSHOT_ID: "s",
    ANTHROPIC_WEBHOOK_SIGNING_KEY: "w",
  };
  it("walks the flow in order", () => {
    expect(decide({})).toBe("create_env");
    expect(decide({ ANTHROPIC_ENVIRONMENT_ID: "e" })).toBe("gate_env_key");
    expect(decide({ ANTHROPIC_ENVIRONMENT_ID: "e", ANTHROPIC_ENVIRONMENT_KEY: "k" })).toBe("provision");
    expect(decide({ ...full, ANTHROPIC_WEBHOOK_SIGNING_KEY: "" })).toBe("gate_webhook");
    expect(decide(full)).toBe("finalize");
  });
  it("provisions when only the snapshot is missing", () => {
    expect(decide({ ...full, BUDDY_BASE_SNAPSHOT_ID: "", ANTHROPIC_WEBHOOK_SIGNING_KEY: "" })).toBe("provision");
  });
});

describe("appendExport", () => {
  it("appends once and is idempotent for the same value", () => {
    const dir = mkdtempSync(join(tmpdir(), "cma-env-"));
    const path = join(dir, ".env");
    writeFileSync(path, "export EXISTING=1\n");

    expect(appendExport(path, "ANTHROPIC_AGENT_ID", "agent_1")).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("export ANTHROPIC_AGENT_ID=agent_1");
    // backup made
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("export EXISTING=1\n");
    // second call with same value is a no-op
    expect(appendExport(path, "ANTHROPIC_AGENT_ID", "agent_1")).toBe(false);
  });
});

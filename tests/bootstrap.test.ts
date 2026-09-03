import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendExport, decide, extractValue, isPollingMode, maskSecret, mergeEnv, parseEnvText, requireValue, seedEnvFromExample } from "../scripts/bootstrap.ts";

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
  it("polling mode skips the webhook gate and finalizes once provisioned", () => {
    const polling = { TRIGGER_MODE: "polling", ANTHROPIC_ENVIRONMENT_ID: "e", ANTHROPIC_ENVIRONMENT_KEY: "k" };
    expect(decide({ ...polling, ANTHROPIC_AGENT_ID: "a", BUDDY_BASE_SNAPSHOT_ID: "s" })).toBe("finalize");
    // still walks the earlier steps in order
    expect(decide({ TRIGGER_MODE: "polling" })).toBe("create_env");
    expect(decide({ ...polling, ANTHROPIC_AGENT_ID: "a" })).toBe("provision");
  });
});

describe("isPollingMode", () => {
  it("is case-insensitive and defaults to webhook", () => {
    expect(isPollingMode({ TRIGGER_MODE: "polling" })).toBe(true);
    expect(isPollingMode({ TRIGGER_MODE: "POLLING" })).toBe(true);
    expect(isPollingMode({ TRIGGER_MODE: "webhook" })).toBe(false);
    expect(isPollingMode({})).toBe(false);
  });
});

describe("requireValue", () => {
  it("rejects blank and enforces an optional prefix", () => {
    expect(requireValue()("")).toBe("required — paste a value");
    expect(requireValue()("  ")).toBe("required — paste a value");
    expect(requireValue()("anything")).toBe(true);
    expect(requireValue("sk-ant-api03-")("nope")).toContain("sk-ant-api03-");
    expect(requireValue("sk-ant-api03-")("sk-ant-api03-xyz")).toBe(true);
    // trims before checking the prefix
    expect(requireValue("whsec_")("  whsec_abc ")).toBe(true);
  });
});

describe("maskSecret", () => {
  it("never reveals the middle of a secret", () => {
    expect(maskSecret("short")).toBe("•••••");
    const masked = maskSecret("sk-ant-api03-supersecretvalue1234");
    expect(masked).toBe("sk-ant…1234");
    expect(masked).not.toContain("supersecret");
  });
});

describe("seedEnvFromExample", () => {
  it("copies the template only when .env is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cma-seed-"));
    const env = join(dir, ".env");
    const example = join(dir, ".env.example");
    writeFileSync(example, "export ANTHROPIC_API_KEY=sk-ant-api03-...\n");

    // missing .env -> seeded from the template
    expect(seedEnvFromExample(env, example)).toBe(true);
    expect(readFileSync(env, "utf8")).toBe("export ANTHROPIC_API_KEY=sk-ant-api03-...\n");

    // existing .env is never overwritten
    writeFileSync(env, "export ANTHROPIC_API_KEY=real\n");
    expect(seedEnvFromExample(env, example)).toBe(false);
    expect(readFileSync(env, "utf8")).toBe("export ANTHROPIC_API_KEY=real\n");
  });

  it("is a no-op when there is no template", () => {
    const dir = mkdtempSync(join(tmpdir(), "cma-seed-"));
    const env = join(dir, ".env");
    expect(seedEnvFromExample(env, join(dir, ".env.example"))).toBe(false);
    expect(existsSync(env)).toBe(false);
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

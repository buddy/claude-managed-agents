import { describe, expect, it, vi } from "vitest";

import { Janitor } from "../src/janitor.js";
import { workerIdentifier } from "../src/naming.js";
import { ANT_RUN_MARKER } from "../src/runner-probe.js";
import { stoppedAtTag, TAG_MARKER } from "../src/tags.js";
import type { CommandLike, SandboxData, SessionLike } from "../src/types.js";
import { Dispatcher } from "../src/worker-dispatch.js";
import { makeFakeAnthropic, makeFakeSandbox, makeFakeSandboxStatic, silentLogger, type FakeSandbox } from "./fixtures.js";

const ENV = "env_test";

function workerData(overrides: Partial<SandboxData> = {}): SandboxData {
  return {
    id: "sb1",
    identifier: workerIdentifier("sesn_a"),
    status: "RUNNING",
    tags: [TAG_MARKER],
    variables: [
      { key: "ANTHROPIC_ENVIRONMENT_ID", value: ENV },
      { key: "ANTHROPIC_SESSION_ID", value: "sesn_a" },
    ],
    ...overrides,
  };
}

function harness(sandbox: FakeSandbox, sessions?: Map<string, SessionLike>) {
  const id = sandbox.data.id ?? "sb1";
  const sandboxes = makeFakeSandboxStatic({
    list: [{ id, identifier: sandbox.data.identifier, status: sandbox.data.status }],
    byId: new Map([[id, sandbox]]),
  });
  const anthropic = makeFakeAnthropic({ sessions });
  const dispatcher = new Dispatcher({
    anthropic,
    sandboxes,
    environmentId: ENV,
    environmentKey: "k",
    baseSnapshotId: "snap",
    log: silentLogger(),
  });
  const janitor = new Janitor({ anthropic, sandboxes, dispatcher, environmentId: ENV, log: silentLogger() });
  return { janitor, anthropic, dispatcher };
}

const aliveCmds: CommandLike[] = [{ data: { command: `x ${ANT_RUN_MARKER}`, status: "INPROGRESS" } }];
const deadCmds: CommandLike[] = [
  { data: { command: `ANTHROPIC_WORK_ID='work_w' ${ANT_RUN_MARKER} --max-idle 60s`, status: "SUCCESSFUL" } },
];

describe("janitorOnce", () => {
  it("leaves a RUNNING worker with a live runner untouched", async () => {
    const sb = makeFakeSandbox(workerData(), aliveCmds);
    const { janitor } = harness(sb);
    await janitor.janitorOnce();
    expect(sb.destroy).not.toHaveBeenCalled();
  });

  it("destroys a crashed worker whose session terminated and stops the lease", async () => {
    const sb = makeFakeSandbox(workerData(), deadCmds);
    const { janitor, anthropic } = harness(sb, new Map([["sesn_a", { status: "terminated" }]]));
    await janitor.janitorOnce();
    expect(anthropic.stop).toHaveBeenCalledWith("work_w", expect.objectContaining({ force: true }));
    expect(sb.destroy).toHaveBeenCalledOnce();
  });

  it("recovers when the session is still running but the runner is gone", async () => {
    const sb = makeFakeSandbox(workerData(), deadCmds);
    const { janitor, dispatcher } = harness(sb, new Map([["sesn_a", { status: "running" }]]));
    const spy = vi.spyOn(dispatcher, "drainAndDispatch").mockResolvedValue(true);
    await janitor.janitorOnce();
    expect(spy).toHaveBeenCalledOnce();
    expect(sb.destroy).not.toHaveBeenCalled();
  });

  it("backfills stopped-at on a freshly STOPPED worker without destroying it", async () => {
    const sb = makeFakeSandbox(workerData({ status: "STOPPED" }));
    const { janitor } = harness(sb);
    await janitor.janitorOnce();
    expect(sb.destroy).not.toHaveBeenCalled();
    expect(sb.data.tags?.some((t) => t.startsWith("cma-stopped-at-"))).toBe(true);
  });

  it("destroys a STOPPED worker idle longer than MAX_IDLE_DAYS", async () => {
    const oldMs = Date.now() - 100 * 86_400_000;
    const sb = makeFakeSandbox(workerData({ status: "STOPPED", tags: [TAG_MARKER, stoppedAtTag(oldMs)] }));
    const { janitor } = harness(sb);
    await janitor.janitorOnce();
    expect(sb.destroy).toHaveBeenCalledOnce();
  });

  it("ignores workers from a different environment", async () => {
    const sb = makeFakeSandbox(
      workerData({ variables: [{ key: "ANTHROPIC_ENVIRONMENT_ID", value: "env_other" }, { key: "ANTHROPIC_SESSION_ID", value: "sesn_a" }] }),
      deadCmds,
    );
    const { janitor, anthropic } = harness(sb);
    await janitor.janitorOnce();
    expect(anthropic.retrieve).not.toHaveBeenCalled();
    expect(sb.destroy).not.toHaveBeenCalled();
  });
});

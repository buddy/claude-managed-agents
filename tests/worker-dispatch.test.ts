import { describe, expect, it } from "vitest";

import { CONFIG } from "../src/config.ts";
import { workerIdentifier } from "../src/naming.ts";
import { ANT_RUN_MARKER, latestAntWorkId } from "../src/runner-probe.ts";
import { Dispatcher } from "../src/worker-dispatch.ts";
import {
  makeFakeAnthropic,
  makeFakeSandbox,
  makeFakeSandboxStatic,
  nonSessionWork,
  silentLogger,
  workItem,
} from "./fixtures.ts";

function makeDispatcher(overrides: {
  anthropic?: ReturnType<typeof makeFakeAnthropic>;
  sandboxes?: ReturnType<typeof makeFakeSandboxStatic>;
}) {
  const anthropic = overrides.anthropic ?? makeFakeAnthropic({});
  const sandboxes = overrides.sandboxes ?? makeFakeSandboxStatic({});
  const dispatcher = new Dispatcher({
    anthropic,
    sandboxes,
    environmentId: "env_test",
    environmentKey: "sk-ant-oat01-secret",
    baseSnapshotId: "snap_base",
    log: silentLogger(),
  });
  return { dispatcher, anthropic, sandboxes };
}

describe("markInFlight", () => {
  it("dedups by work id", () => {
    const { dispatcher } = makeDispatcher({});
    expect(dispatcher.markInFlight("work_1")).toBe(true);
    expect(dispatcher.markInFlight("work_1")).toBe(false);
  });
});

describe("dispatchWorkItem", () => {
  it("drops and force-stops non-session work without touching sandboxes", async () => {
    const { dispatcher, anthropic, sandboxes } = makeDispatcher({});
    const ok = await dispatcher.dispatchWorkItem(nonSessionWork("work_ns"));
    expect(ok).toBe(true);
    expect(anthropic.stop).toHaveBeenCalledWith("work_ns", expect.objectContaining({ force: true }));
    expect(sandboxes.createFromSnapshot).not.toHaveBeenCalled();
  });

  it("inlines ANTHROPIC_WORK_ID and runs ant on the session worker", async () => {
    const id = workerIdentifier("sesn_a");
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING" });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher } = makeDispatcher({ sandboxes });

    const ok = await dispatcher.dispatchWorkItem(workItem("work_x", "sesn_a"));
    expect(ok).toBe(true);

    const expected =
      `cd ${CONFIG.workspaceDir} && ANTHROPIC_WORK_ID='work_x' ` +
      `${ANT_RUN_MARKER} --workdir ${CONFIG.workspaceDir} --max-idle ${CONFIG.antMaxIdle}`;
    expect(worker.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: expected, runtime: "BASH", detached: true }),
    );
    // the janitor recovers the work id from the command text, not a tag
    expect(latestAntWorkId([{ data: { command: expected, status: "INPROGRESS" } }])).toBe("work_x");
  });
});

describe("ensureWorker", () => {
  it("creates from snapshot and sets idle timeout when missing", async () => {
    const sandboxes = makeFakeSandboxStatic({});
    const { dispatcher } = makeDispatcher({ sandboxes });

    const sb = await dispatcher.ensureWorker("sesn_new");
    expect(sandboxes.createFromSnapshot).toHaveBeenCalledWith(
      "snap_base",
      expect.objectContaining({ identifier: workerIdentifier("sesn_new") }),
    );
    expect(sb.update).toHaveBeenCalledWith(expect.objectContaining({ timeout: CONFIG.workerIdleTimeoutSec }));
  });

  it("starts an existing stopped worker", async () => {
    const id = workerIdentifier("sesn_stopped");
    const worker = makeFakeSandbox({ identifier: id, status: "STOPPED" });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher } = makeDispatcher({ sandboxes });

    await dispatcher.ensureWorker("sesn_stopped");
    expect(worker.start).toHaveBeenCalledOnce();
    expect(sandboxes.createFromSnapshot).not.toHaveBeenCalled();
  });
});

describe("drainAndDispatch", () => {
  it("keeps the newest work per session and force-stops the rest", async () => {
    const id = workerIdentifier("sesn_a");
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING" });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const anthropic = makeFakeAnthropic({
      pollQueue: [
        workItem("work_old", "sesn_a", "2026-01-01T00:00:00Z"),
        workItem("work_new", "sesn_a", "2026-01-01T00:05:00Z"),
      ],
    });
    const { dispatcher } = makeDispatcher({ anthropic, sandboxes });

    const ok = await dispatcher.drainAndDispatch();
    expect(ok).toBe(true);
    expect(anthropic.ack).toHaveBeenCalledTimes(2);
    expect(anthropic.stop).toHaveBeenCalledWith("work_old", expect.objectContaining({ force: true }));
    expect(worker.runCommand).toHaveBeenCalledOnce();
  });
});

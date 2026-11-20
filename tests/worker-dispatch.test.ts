import { describe, expect, it } from "vitest";

import { CONFIG } from "../src/config.ts";
import { workerIdentifier } from "../src/naming.ts";
import { ANT_RUN_MARKER, latestAntWorkId } from "../src/runner-probe.ts";
import { workerTags } from "../src/tags.ts";
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
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING", tags: workerTags() });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher } = makeDispatcher({ sandboxes });

    const ok = await dispatcher.dispatchWorkItem(workItem("work_x", "sesn_a"));
    expect(ok).toBe(true);

    const secretFile = `${CONFIG.workSecretDir}/work-secret`;
    const expected =
      `cd ${CONFIG.workspaceDir} && chmod 600 ${secretFile} && ANTHROPIC_WORK_ID='work_x' ` +
      `ANTHROPIC_WORK_SECRET_FILE=${secretFile} ` +
      `${ANT_RUN_MARKER} --workdir ${CONFIG.workspaceDir} --max-idle ${CONFIG.antMaxIdle}`;
    expect(worker.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: expected, runtime: "BASH", detached: true, output: null }),
    );
    const opts = worker.runCommand.mock.calls[0]![0];
    expect(opts).not.toHaveProperty("stdout");
    expect(opts).not.toHaveProperty("stderr");
    // the janitor recovers the work id from the command text, not a tag
    expect(latestAntWorkId([{ data: { command: expected, status: "INPROGRESS" } }])).toBe("work_x");
  });

  it("uploads the work item's secret before starting ant, never inlining it", async () => {
    const id = workerIdentifier("sesn_a");
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING", tags: workerTags() });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher } = makeDispatcher({ sandboxes });

    await dispatcher.dispatchWorkItem(workItem("work_x", "sesn_a"));

    expect(worker.fs.uploadFile).toHaveBeenCalledWith(
      Buffer.from("secret-for-work_x"),
      `${CONFIG.workSecretDir}/work-secret`,
    );
    expect(worker.fs.uploadFile.mock.invocationCallOrder[0]!).toBeLessThan(
      worker.runCommand.mock.invocationCallOrder[0]!,
    );
    expect(worker.runCommand.mock.calls[0]![0].command).not.toContain("secret-for-work_x");
  });

  it("force-stops a work item that carries no secret without starting ant", async () => {
    const id = workerIdentifier("sesn_a");
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING", tags: workerTags() });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher, anthropic } = makeDispatcher({ sandboxes });

    const ok = await dispatcher.dispatchWorkItem({ ...workItem("work_x", "sesn_a"), secret: null });

    expect(ok).toBe(false);
    expect(anthropic.stop).toHaveBeenCalledWith("work_x", expect.objectContaining({ force: true }));
    expect(worker.fs.uploadFile).not.toHaveBeenCalled();
    expect(worker.runCommand).not.toHaveBeenCalled();
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

  it("never gives a new worker the environment key", async () => {
    const sandboxes = makeFakeSandboxStatic({});
    const { dispatcher } = makeDispatcher({ sandboxes });

    await dispatcher.ensureWorker("sesn_new");
    const config = sandboxes.createFromSnapshot.mock.calls[0]![1] as { variables: Array<{ key: string }> };
    expect(config.variables.map((v) => v.key)).toEqual(["ANTHROPIC_ENVIRONMENT_ID", "ANTHROPIC_SESSION_ID"]);
  });

  it("starts an existing stopped worker", async () => {
    const id = workerIdentifier("sesn_stopped");
    const worker = makeFakeSandbox({ identifier: id, status: "STOPPED", tags: workerTags() });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher } = makeDispatcher({ sandboxes });

    await dispatcher.ensureWorker("sesn_stopped");
    expect(worker.start).toHaveBeenCalledOnce();
    expect(sandboxes.createFromSnapshot).not.toHaveBeenCalled();
  });

  it("recreates a worker created before the work-secret change", async () => {
    const id = workerIdentifier("sesn_old");
    const byIdentifier = new Map([[id, makeFakeSandbox({ identifier: id, status: "RUNNING", tags: ["cma"] })]]);
    const old = byIdentifier.get(id)!;
    old.destroy.mockImplementation(async () => {
      byIdentifier.delete(id);
    });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier });
    const { dispatcher } = makeDispatcher({ sandboxes });

    const sb = await dispatcher.ensureWorker("sesn_old");

    expect(old.destroy).toHaveBeenCalledOnce();
    expect(sandboxes.createFromSnapshot).toHaveBeenCalledWith(
      "snap_base",
      expect.objectContaining({ identifier: id, tags: workerTags() }),
    );
    expect(sb).not.toBe(old);
  });

  it("keeps a worker that already has the current layout", async () => {
    const id = workerIdentifier("sesn_current");
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING", tags: workerTags() });
    const sandboxes = makeFakeSandboxStatic({ byIdentifier: new Map([[id, worker]]) });
    const { dispatcher } = makeDispatcher({ sandboxes });

    const sb = await dispatcher.ensureWorker("sesn_current");

    expect(sb).toBe(worker);
    expect(worker.destroy).not.toHaveBeenCalled();
    expect(sandboxes.createFromSnapshot).not.toHaveBeenCalled();
  });
});

describe("drainAndDispatch", () => {
  it("keeps the newest work per session and force-stops the rest", async () => {
    const id = workerIdentifier("sesn_a");
    const worker = makeFakeSandbox({ identifier: id, status: "RUNNING", tags: workerTags() });
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

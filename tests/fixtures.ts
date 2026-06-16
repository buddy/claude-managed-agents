import { vi } from "vitest";

import type { Logger } from "../src/log.js";
import type {
  AnthropicLike,
  CommandLike,
  SandboxData,
  SandboxLike,
  SandboxListItem,
  SandboxStatic,
  SessionLike,
  WorkItem,
} from "../src/types.js";

export function silentLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export function workItem(id: string, sessionId: string, createdAt?: string): WorkItem {
  return {
    id,
    environment_id: "env_test",
    created_at: createdAt,
    data: { type: "session", id: sessionId },
  };
}

export function nonSessionWork(id: string): WorkItem {
  return { id, environment_id: "env_test", data: { type: "skill", id: "skill_x" } };
}

export interface FakeSandbox extends SandboxLike {
  data: SandboxData;
  commands: CommandLike[];
  start: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  refresh: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  listCommands: ReturnType<typeof vi.fn>;
}

export function makeFakeSandbox(data: SandboxData, commands: CommandLike[] = []): FakeSandbox {
  const sb: FakeSandbox = {
    data,
    commands,
    start: vi.fn(async () => {
      sb.data.status = "RUNNING";
    }),
    destroy: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    update: vi.fn(async (cfg: { tags?: string[] }) => {
      if (cfg.tags) sb.data.tags = cfg.tags;
    }),
    runCommand: vi.fn(async (opts: { command: string }) => ({ data: { command: opts.command, status: "INPROGRESS" } })),
    listCommands: vi.fn(async () => sb.commands),
  };
  return sb;
}

/** Fake Sandbox static surface. `byIdentifier` maps identifier→sandbox (or throws 404). */
export function makeFakeSandboxStatic(opts: {
  byIdentifier?: Map<string, FakeSandbox>;
  byId?: Map<string, FakeSandbox>;
  list?: SandboxListItem[];
  onCreateFromSnapshot?: (snapshotId: string, config: any) => FakeSandbox;
}): SandboxStatic & {
  getByIdentifier: ReturnType<typeof vi.fn>;
  createFromSnapshot: ReturnType<typeof vi.fn>;
} {
  const byIdentifier = opts.byIdentifier ?? new Map();
  const byId = opts.byId ?? new Map();
  return {
    getByIdentifier: vi.fn(async (identifier: string) => {
      const sb = byIdentifier.get(identifier);
      if (!sb) throw Object.assign(new Error("not found"), { statusCode: 404 });
      return sb;
    }),
    getById: vi.fn(async (id: string) => {
      const sb = byId.get(id);
      if (!sb) throw Object.assign(new Error("not found"), { statusCode: 404 });
      return sb;
    }),
    createFromSnapshot: vi.fn(async (snapshotId: string, config: any) => {
      const sb = opts.onCreateFromSnapshot
        ? opts.onCreateFromSnapshot(snapshotId, config)
        : makeFakeSandbox({ identifier: config?.identifier, status: "RUNNING", tags: config?.tags });
      byIdentifier.set(config?.identifier, sb);
      return sb;
    }),
    list: vi.fn(async () => opts.list ?? []),
  } as any;
}

/** Fake Anthropic surface. `pollQueue` drains then returns null; tracks ack/stop. */
export function makeFakeAnthropic(opts: {
  pollQueue?: WorkItem[];
  sessions?: Map<string, SessionLike>;
}): AnthropicLike & {
  stop: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
} {
  const queue = [...(opts.pollQueue ?? [])];
  const sessions = opts.sessions ?? new Map();
  const stop = vi.fn(async () => undefined);
  const ack = vi.fn(async () => undefined);
  const retrieve = vi.fn(async (sessionId: string) => {
    const s = sessions.get(sessionId);
    if (!s) throw Object.assign(new Error("not found"), { status: 404 });
    return s;
  });
  return {
    stop,
    ack,
    retrieve,
    beta: {
      environments: {
        work: {
          poll: vi.fn(async () => queue.shift() ?? null),
          ack,
          stop,
        },
      },
      sessions: { retrieve },
    },
  } as any;
}

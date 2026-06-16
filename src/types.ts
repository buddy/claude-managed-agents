/**
 * Narrow structural interfaces for the bits of the Anthropic and Buddy SDKs the
 * control plane touches. Real SDK objects are cast to these at the orchestrator
 * boundary; unit tests pass plain fakes. This keeps the orchestration logic
 * decoupled from exact SDK type names and trivially testable.
 */

export interface WorkItem {
  id: string;
  environment_id?: string;
  created_at?: string;
  data: { type: string; id: string };
}

export type SandboxStatus =
  | "STARTING"
  | "STOPPING"
  | "FAILED"
  | "RUNNING"
  | "STOPPED"
  | "RESTORING";

export interface CommandLike {
  data: {
    id?: string;
    command?: string;
    status?: "INPROGRESS" | "SUCCESSFUL" | "FAILED";
  };
}

export interface RunCommandOpts {
  command: string;
  runtime?: "BASH" | "JAVASCRIPT" | "TYPESCRIPT" | "PYTHON";
  detached?: boolean;
  stdout?: unknown;
  stderr?: unknown;
}

export interface VariableInput {
  key: string;
  value?: string;
  encrypted?: boolean;
}

export interface UpdateInput {
  timeout?: number;
  tags?: string[];
  variables?: VariableInput[];
  apps?: Array<{ command: string }>;
}

export interface SandboxData {
  id?: string;
  identifier?: string;
  status?: SandboxStatus;
  tags?: string[];
  variables?: Array<{ key?: string; value?: string }>;
  endpoints?: Array<{ name?: string; endpoint_url?: string }>;
}

export interface SandboxLike {
  readonly data: SandboxData;
  start(): Promise<void>;
  destroy(): Promise<void>;
  refresh(): Promise<void>;
  update(cfg: UpdateInput): Promise<void>;
  runCommand(opts: RunCommandOpts): Promise<CommandLike>;
  listCommands(): Promise<CommandLike[]>;
}

export interface SandboxListItem {
  id?: string;
  identifier?: string;
  status?: SandboxStatus;
}

export interface SandboxStatic {
  getByIdentifier(identifier: string, config?: unknown): Promise<SandboxLike>;
  getById(id: string, config?: unknown): Promise<SandboxLike>;
  createFromSnapshot(snapshotId: string, config?: unknown): Promise<SandboxLike>;
  list(config?: unknown): Promise<SandboxListItem[]>;
}

export interface WorkApi {
  poll(environmentId: string, opts: Record<string, unknown>): Promise<WorkItem | null>;
  ack(workId: string, opts: Record<string, unknown>): Promise<unknown>;
  stop(workId: string, opts: Record<string, unknown>): Promise<unknown>;
}

export interface SessionLike {
  status?: string;
  archived_at?: string | null;
}

export interface SessionsApi {
  retrieve(sessionId: string, opts?: Record<string, unknown>): Promise<SessionLike>;
}

export interface AnthropicLike {
  beta: {
    environments: { work: WorkApi };
    sessions: SessionsApi;
  };
}

# Architecture & operations guide

## What CMA self-hosted is

Claude Managed Agents splits an agent into three pieces. In this cookbook:

| Piece | Owner |
| --- | --- |
| Agent loop (model, session state, event history, tool selection) | Anthropic |
| Work queue for the self-hosted environment | Anthropic |
| Tool execution (bash, file ops, web fetch/search) | Buddy worker sandbox via `ant beta:worker run` |

The model and event history stay on Anthropic's side. The filesystem, process
execution, and network boundary for tools live in the Buddy worker sandbox.

## Three sandbox roles

1. **Base snapshot** (`scripts/build-snapshot.ts`) — a throwaway `ubuntu:24.04`
   sandbox whose `first_boot_commands` install the `ant` CLI. We snapshot it and
   destroy the builder. Every worker is born from this snapshot, so workers cold
   start without reinstalling `ant`.
2. **Orchestrator sandbox** (`scripts/deploy-orchestrator.ts`) — long-lived,
   runs `src/orchestrator.ts` as a Buddy **app** (long-running command) with a
   Buddy **HTTP endpoint** as the public webhook URL. It has **no `timeout`** so
   it never idle-stops.
3. **Worker sandboxes** — one per session, `cma-worker-<sanitized session id>`,
   created from the base snapshot. Each claimed work item launches one
   `ant beta:worker run`.

## Request flow

```
User creates a session and sends a message
        │
        ▼
Anthropic enqueues work on the self-hosted environment
        │
        ▼
Anthropic POSTs session.status_run_started to the Buddy HTTP endpoint
        │
        ▼
Orchestrator verifies the signature, schedules background dispatch, returns 200
        │
        ▼
Dispatcher pre-readies the session's worker sandbox, then claims queued work
(poll + ack), keeping the newest work item per session
        │
        ▼
Worker runs:  cd /workspace && ANTHROPIC_WORK_ID=<id> ant beta:worker run \
                --workdir /workspace --max-idle 60s
        │
        ▼
ant heartbeats the lease, runs tools, posts results, stops the work item,
and exits after --max-idle once the session goes idle
```

The orchestrator claims work; it does not execute tools. `ant` owns the first
heartbeat, the session event stream, tool execution, and the work stop.

## Buddy-specific design decisions

- **No per-process env in exec.** `runCommand` only accepts `{ command, runtime }`.
  Long-lived credentials are set as sandbox `variables` at worker creation
  (`ANTHROPIC_ENVIRONMENT_KEY` encrypted); the per-run `ANTHROPIC_WORK_ID` is
  inlined into the BASH command string. See `src/worker-dispatch.ts`.
- **Idle timeout set after creation.** `createFromSnapshot` does not accept
  `timeout`, so `ensureWorker` sets `WORKER_IDLE_TIMEOUT_SEC` via `update()`
  right after creating the worker.
- **Tags are the janitor's source of truth** (`src/tags.ts`): `cma`,
  `cma-env:<id>`, `cma-session:<id>`, `cma-work:<id>`, `cma-stopped-at:<iso>`.
  `Sandbox.list()` omits tags, so the janitor filters by the `cma-worker-`
  identifier prefix, then `getById` to read tags.
- **Runner-alive probe** (`src/runner-probe.ts`): Buddy has no per-process RPC,
  so "alive" = some `listCommands()` entry whose text contains
  `ant beta:worker run` is still `INPROGRESS` (we can't stamp a custom command
  name).

## Lifecycle & the janitor (`src/janitor.ts`)

Buddy's per-worker idle `timeout` does first-stage idle-stop for free. The
janitor sweeps every `JANITOR_SECONDS` and reconciles each managed worker
against Anthropic session state:

| Sandbox state | Runner | Session | Action |
| --- | --- | --- | --- |
| RUNNING | alive | — | leave untouched |
| RUNNING | dead | terminated / missing | release lingering work + `destroy()` |
| RUNNING | dead | idle | clear work tag (Buddy `timeout` stops it) |
| RUNNING | dead | running | release work + re-dispatch (crash recovery) |
| STOPPED | — | — | backfill `cma-stopped-at`; `destroy()` after `MAX_IDLE_DAYS` |
| STARTING/STOPPING/RESTORING | — | — | skip this pass |

`releaseInFlightWorkFor` force-stops the work id stamped in `cma-work:` so a lease
left by a SIGKILLed runner doesn't block the next prompt for that session.

## Triggers

`TRIGGER_MODE` (default `webhook`) selects how the orchestrator discovers queued
work. Both modes share the dispatcher (`src/worker-dispatch.ts`) and the janitor;
only the trigger and the crash-recovery owner differ.

- **`webhook`** — Anthropic POSTs `session.status_run_started` to `POST /webhook`
  (signature-verified with `ANTHROPIC_WEBHOOK_SIGNING_KEY`). The poll loop
  (`src/poller.ts`) runs behind it as a safety net so a restart after acking a
  webhook can't strand queued work; disable it with `POLLER_ENABLED=false`. The
  janitor owns crash recovery (re-dispatches dead runners). The orchestrator
  **fails fast at startup** if the signing key is missing.
- **`polling`** — the poll loop is the only trigger and runs continuously,
  ignoring `POLLER_ENABLED`. No inbound endpoint and no signing key are needed
  (`POST /webhook` returns 503; only `/health` is served, so Buddy's endpoint and
  the deploy/liveness probes still work). Because the poll loop already
  re-dispatches reclaimed work, the janitor skips crash recovery to avoid
  double-draining.

Pick `polling` to avoid exposing an endpoint or managing a webhook secret; pick
`webhook` for lower per-event latency.

## Single-claimant rule

Run **exactly one orchestrator per Anthropic environment**. Buddy has no
cross-process lock; the orchestrator identifier (`cma-orchestrator`) is unique,
and the server logs a warning at startup. Two claimants on one environment would
double-dispatch.

## Security boundaries

Buddy does not inject credentials into a worker's outbound requests — no egress
proxy or firewall holds them on the worker's behalf. The environment key is
decrypted into the worker's process env, where the agent's `bash` can read it.
Therefore:

- Workers receive only the scoped, revocable `ANTHROPIC_ENVIRONMENT_KEY` — never
  the admin `ANTHROPIC_API_KEY` or `BUDDY_TOKEN`.
- The orchestrator holds `BUDDY_TOKEN` (to spawn workers) and the webhook signing
  key; workers hold neither.
- The HTTP endpoint uses `auth_type: NONE` because the webhook **signature** is
  the auth boundary — every delivery is verified with `webhooks.unwrap`.
- Before production: review egress, key rotation, and log retention for your
  trust boundary.

## Staging inputs and collecting deliverables

Self-hosted environments have no `/mnt/session/outputs`. A worker is an ordinary
`ubuntu:24.04` sandbox, and `--workdir` (`WORKSPACE_DIR`, default `/workspace`) is
just a directory `scripts/build-snapshot.ts` creates inside it — the place the
agent's file tools are pointed by default, not a boundary. `ant` is explicit that
the workdir check guards the file tools only and that `bash` ignores it, so treat
the whole sandbox filesystem as reachable.

That directory is plain sandbox storage: nothing is mounted, and no worker shares
it with the orchestrator or with another session. Files therefore move in and out
only through Buddy's file API, and nothing is copied out for you.

The worker identifier is derived from the session id, so anything holding the
**workspace** token can reach a session's workspace without going through the
orchestrator (a sandbox's own auto-injected `BUDDY_TOKEN` cannot — it is scoped to
managing that one sandbox):

```ts
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "./src/clients.js";
import { CONFIG } from "./src/config.js";
import { workerIdentifier } from "./src/naming.js";

const dir = CONFIG.workspaceDir;

// Assumes the session's worker already exists and is RUNNING — see below.
const sb = await Sandbox.getByIdentifier(workerIdentifier(sessionId), {
  connection: buddyConnection(),
});

await sb.fs.uploadFile(Buffer.from(csv), `${dir}/input.csv`); // stage an input
const produced = await sb.fs.listFiles(dir);                  // see what came out
const report = await sb.fs.downloadFile(`${dir}/report.pdf`); // collect it
```

Two preconditions that bare `getByIdentifier` does not cover, and that
`ensureWorker` (`src/worker-dispatch.ts:86`) exists to handle — reuse it rather
than reimplementing either:

- **The worker is created lazily.** It does not exist until the session's first
  work item is dispatched, so `getByIdentifier` raises not-found before then;
  `ensureWorker` catches that and creates from the base snapshot.
- **The worker idle-stops.** Buddy stops it `WORKER_IDLE_TIMEOUT_SEC` after it
  goes quiet (default 900s), and a stopped sandbox has to be started before its
  filesystem is reachable; `ensureWorker` does that too.

Derive the name with `workerIdentifier()` and the path from `CONFIG.workspaceDir`
rather than building either by hand — session ids are sanitized and length-bounded
(`src/naming.ts`), and the workdir is `WORKSPACE_DIR`, which the dispatch command
already reads from config. Since `bash` is not confined to the workdir, listing it
reflects a convention rather than a guarantee: agree an output path with the agent
instead of assuming everything it produces lands there.

### Carrying the pointers in session metadata

Self-hosted environments do not mount `file` or `github_repository` resources, and
this is enforced rather than merely unimplemented: a session that includes **any**
`resources` entry on a self-hosted environment is rejected. Staging is the control
plane's job here, and the documented division of labour is that the caller passes
**pointers** in the session's `metadata` map, which the orchestrator resolves into
the workdir **before dispatch**.

```ts
// caller side: name what the run needs, not the payload
const session = await anthropic.beta.sessions.create({
  agent: agentId,
  environment_id: environmentId,
  metadata: { inputs: "s3://bucket/input.csv", deliverable: "/workspace/report.pdf" },
  betas: [CONFIG.beta],
});
```

Metadata values are strings, so pass paths, URLs, ids, or a JSON blob. **A claimed
work item does not carry the session's metadata**, only the session id, so reading
it costs one `sessions.retrieve(sessionId)` — and a field on `SessionLike`, which
`src/types.ts` narrows to `status` and `archived_at`. The seam for a
retrieve-fetch-upload is `dispatchWorkItem`, between `ensureWorker()` and the
`runCommand()` that launches `ant` (`src/worker-dispatch.ts:138`–`150`): every
session funnels through it under both trigger modes, so it is the only point
guaranteed to run before `ant` starts. The webhook path's pre-ready step
(`scheduleDispatch`, `src/orchestrator.ts:80`) is not that point — it warms only
the session named in the webhook, and polling mode never calls it. For fixtures
every session needs, bake them into the base snapshot instead and skip the round
trip.

Two rules follow from the lifecycle:

- **Deliverables land in the workdir, and nothing collects them.** On self-hosted
  environments the session's system prompt omits the `/mnt/session/outputs`
  instruction, so the agent writes final artifacts under `--workdir` by default —
  but no Files API captures them, so they stay there until something pulls them.
- **Deliverables die with the worker, in stages.** The sandbox idle-stops first
  (`WORKER_IDLE_TIMEOUT_SEC`), which only means you must start it before reading
  the files. It is *destroyed* once the janitor sees the session terminated,
  archived, or missing, reaped after `MAX_IDLE_DAYS` in STOPPED, or removed
  immediately by `npm run teardown`. Collect before any of those three.

Two platform features do not apply here at all: `memory_store` session resources
and vault `environment_variable` credentials are cloud-only, the latter because
egress is yours, so there is no Anthropic-managed hop at which a secret could be
substituted.

## Upgrading the `ant` CLI

`ANT_VERSION` is baked into the base snapshot at build time, so raising it in
`.env` does nothing to an existing install on its own: `npm run bootstrap` skips
the snapshot step whenever `BUDDY_BASE_SNAPSHOT_ID` is already set, and the
orchestrator creates workers from whatever snapshot id it was deployed with.

```bash
npm run build-snapshot        # prints a new BUDDY_BASE_SNAPSHOT_ID
# replace BUDDY_BASE_SNAPSHOT_ID in .env with the printed id
npm run deploy-orchestrator   # pushes the new id into the orchestrator's variables
```

- No `teardown` needed, but the restart is not free: `deploy-orchestrator`
  refreshes an existing orchestrator's variables in place and then calls
  `restart()`, so the HTTP endpoint is down for that plus `npm install` and the
  Node boot. Brief, but real. In webhook mode a delivery that lands in that
  window is recovered by the safety-net poll loop, so keep `POLLER_ENABLED=true`
  across a redeploy — the janitor cannot cover it, since it reconciles existing
  workers and a session that never got one is invisible to it.
- Workers are per-session, so **new sessions** are born from the new snapshot
  right away. A session that already has a worker stays on the old `ant`; the
  image is fixed when the sandbox is created.
- **Re-check the CLI surface, not just the version.** Diff
  `ant beta:worker run --help` against what the dispatcher emits — the
  `--workdir` / `--max-idle` flags and the `ANTHROPIC_*` variables in
  `workerVariables()`. A changed invocation does not fail loudly:
  `runCommand({ detached: true })` returns as soon as Buddy accepts the string, so
  dispatch reports success while `ant` exits on bad arguments, and the janitor
  then re-dispatches that session every `JANITOR_SECONDS` forever. Identical from
  1.10.0 through 1.23.0, so there is no drift to date.
- Those older workers need no manual cleanup. The janitor destroys a worker once
  its session is terminated/archived/missing and reaps STOPPED ones after
  `MAX_IDLE_DAYS`. Reach for `npm run teardown` only to force every session onto
  the new `ant` at once — it also destroys the orchestrator and cuts off
  in-flight tool execution.

## Known caveats (validate in your workspace)

- `ant` release tag / asset naming — pin `ANT_VERSION` to a current release and
  rebuild the snapshot (see [Upgrading the `ant` CLI](#upgrading-the-ant-cli)).
- Keep `WORKER_IDLE_TIMEOUT_SEC` well above expected idle gaps so a quiet `ant`
  run is not stopped mid-session (`ant --max-idle` should be the stop signal).
- The orchestrator relies on `timeout` being omitted (not `0`) plus the
  long-running app to stay alive; confirm it does not idle-stop in your region.

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

The worker identifier is derived from the session id, so any holder of
`BUDDY_TOKEN` can reach a session's workspace without going through the
orchestrator:

```ts
import { Sandbox } from "@buddy-works/sandbox-sdk";

import { buddyConnection } from "./src/clients.js";
import { workerIdentifier } from "./src/naming.js";

const sb = await Sandbox.getByIdentifier(workerIdentifier(sessionId), {
  connection: buddyConnection(),
});

await sb.fs.uploadFile(Buffer.from(csv), "/workspace/input.csv"); // stage an input
const produced = await sb.fs.listFiles("/workspace");             // see what came out
const report = await sb.fs.downloadFile("/workspace/report.pdf"); // collect it
```

Derive the name with `workerIdentifier()` instead of building it by hand — session
ids are sanitized and length-bounded (`src/naming.ts`). And since `bash` is not
confined to the workdir, listing `/workspace` reflects a convention rather than a
guarantee: agree an output path with the agent instead of assuming everything it
produces lands there.

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
work item does not carry the session's metadata** — only the session id — so
reading it costs one `sessions.retrieve(sessionId)`. The seam for that is the
pre-ready step: `startup()` calls `ensureWorker()` (`src/orchestrator.ts:80`) to
bring a session's sandbox up *before* work is claimed, which is where a
retrieve-fetch-upload belongs — the files are in place by the time `ant` starts.
**This control plane reads none of it**: `src/types.ts` narrows `SessionLike` to
`status` and `archived_at`, so wiring the convention means widening that type and
adding the staging step. For fixtures every session needs, bake them into the base
snapshot instead and skip the round trip.

Two rules follow from the lifecycle:

- **Deliverables land in the workdir, and nothing collects them.** On self-hosted
  environments the session's system prompt omits the `/mnt/session/outputs`
  instruction, so the agent writes final artifacts under `--workdir` by default —
  but no Files API captures them, so they stay there until something pulls them.
- **Deliverables die with the worker.** The janitor destroys the sandbox once its
  session is terminated, archived, or missing, and reaps STOPPED ones after
  `MAX_IDLE_DAYS` — and `npm run teardown` removes them immediately. Download
  before terminating the session.

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

- No `teardown` and no downtime — `deploy-orchestrator` refreshes an existing
  orchestrator's variables in place and restarts the app.
- Workers are per-session, so **new sessions** are born from the new snapshot
  right away. A session that already has a worker stays on the old `ant`; the
  image is fixed when the sandbox is created.
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

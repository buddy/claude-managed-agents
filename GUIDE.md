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
- **Tags are the janitor's source of truth** (`src/tags.ts`), the analog of
  Daytona's labels: `cma`, `cma-env:<id>`, `cma-session:<id>`, `cma-work:<id>`,
  `cma-stopped-at:<iso>`. `Sandbox.list()` omits tags, so the janitor filters by
  the `cma-worker-` identifier prefix, then `getById` to read tags.
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

- **Webhook** is the primary trigger (`POST /webhook`).
- **Polling** (`src/poller.ts`) is a safety net so a restart after acking a
  webhook can't strand queued work. Disable with `POLLER_ENABLED=false`.

## Single-claimant rule

Run **exactly one orchestrator per Anthropic environment**. Buddy has no
cross-process lock; the orchestrator identifier (`cma-orchestrator`) is unique,
and the server logs a warning at startup. Two claimants on one environment would
double-dispatch.

## Security boundaries

Buddy does not inject credentials at a network firewall (unlike Vercel's brokered
model or Cloudflare egress). The environment key is decrypted into the worker's
process env, where the agent's `bash` can read it. Therefore:

- Workers receive only the scoped, revocable `ANTHROPIC_ENVIRONMENT_KEY` — never
  the admin `ANTHROPIC_API_KEY` or `BUDDY_TOKEN`.
- The orchestrator holds `BUDDY_TOKEN` (to spawn workers) and the webhook signing
  key; workers hold neither.
- The HTTP endpoint uses `auth_type: NONE` because the webhook **signature** is
  the auth boundary — every delivery is verified with `webhooks.unwrap`.
- Before production: review egress, key rotation, and log retention for your
  trust boundary.

## Known caveats (validate in your workspace)

- `ant` release tag / asset naming — pin `ANT_VERSION` to a current release.
- Keep `WORKER_IDLE_TIMEOUT_SEC` well above expected idle gaps so a quiet `ant`
  run is not stopped mid-session (`ant --max-idle` should be the stop signal).
- The orchestrator relies on `timeout` being omitted (not `0`) plus the
  long-running app to stay alive; confirm it does not idle-stop in your region.

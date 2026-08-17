# Claude Managed Agents on Buddy Sandboxes

Run the self-hosted Claude Managed Agents (CMA) path on [Buddy Sandboxes](https://buddy.works).
Anthropic owns the agent loop, session state, event history, and the self-hosted
work queue. Buddy runs the execution layer: one **orchestrator** sandbox (control
plane) and one **worker** sandbox per session that runs the built-in CMA toolset
via the `ant beta:worker run` CLI.


## How it works

```
session.status_run_started  ──▶  Orchestrator sandbox (Buddy HTTP endpoint)
                                   │  verify signature, schedule dispatch, 200
                                   ▼
                                  pre-ready worker, claim queued work (poll+ack)
                                   ▼
                                  Worker sandbox  cma-worker-<session>
                                   │  ANTHROPIC_WORK_ID=… ant beta:worker run
                                   ▼
                                  ant heartbeats, runs tools in /workspace,
                                  posts results, stops the work item, exits idle
```

- **Orchestrator** runs inside its own Buddy sandbox. In **webhook mode** it is
  exposed on a public Buddy HTTP endpoint registered as the Anthropic webhook
  target, with a safety-net polling loop behind it; in **polling mode** it
  long-polls the work queue itself and needs no inbound endpoint or signing key.
  A janitor runs in both modes. Pick the mode with `TRIGGER_MODE` (see below).
- **Worker** sandboxes are born from a prebuilt **snapshot** with the `ant` CLI
  baked in. One per session, identified `cma-worker-<sanitized session id>`.
- A passing transcript is only proof of *this* path when the matching
  `cma-worker-<session>` sandbox shows an `ant beta:worker run` command.

See [GUIDE.md](./GUIDE.md) for architecture, lifecycle states, and the security model.

## Trigger mode: webhook or polling

The orchestrator supports two triggers, selected
with `TRIGGER_MODE` in `.env` (default `webhook`). Both modes share the same
sandbox lifecycle, dispatcher, and janitor — only how work is discovered differs.

| | `webhook` (default) | `polling` |
| --- | --- | --- |
| Trigger | Anthropic POSTs `session.status_run_started` to the public endpoint | Orchestrator long-polls the work queue continuously |
| Inbound endpoint | required (public Buddy HTTP URL) | not required (only `/health` is served) |
| `ANTHROPIC_WEBHOOK_SIGNING_KEY` | required | not used |
| Console webhook registration | required | skipped |
| Crash recovery | janitor re-dispatches dead runners | the poll loop re-dispatches reclaimed work |
| Latency | lower per-event | bounded by the poll interval |

Pick **polling** when you don't want to expose an inbound endpoint or manage a
webhook secret; pick **webhook** for lower per-event latency. Switch by setting
`TRIGGER_MODE` and re-running `npm run deploy-orchestrator`.

## Before you start

- Claude Managed Agents access and an `ANTHROPIC_API_KEY`.
- A Buddy workspace + project and a `BUDDY_TOKEN` with sandbox permissions.
- Node 20+.

```bash
cd buddy
cp .env.example .env          # fill ANTHROPIC_API_KEY and BUDDY_TOKEN/WORKSPACE/PROJECT
npm install                   # pulls @buddy-works/sandbox-sdk from npm
```

## Quickstart (guided)

`bootstrap` runs every deterministic step, **writes the ids it creates back to
`.env` for you** (no copy/paste), and stops only at the two unavoidable Anthropic
Console gates. Re-run it after each gate.

```bash
npm run bootstrap          # creates environment → stops: generate the env key in the Console
#   paste ANTHROPIC_ENVIRONMENT_KEY into .env
npm run bootstrap          # creates agent + base snapshot, deploys → stops: register the webhook
#   paste ANTHROPIC_WEBHOOK_SIGNING_KEY into .env
npm run bootstrap          # re-deploys to pick up the key — done
npm run session        # prove it end to end
```

`npm run bootstrap -- --plan` shows the current state and the next action without
running anything. `session` prints `EXAMPLE: PASS` when the transcript
completes **and** the session's `cma-worker-*` sandbox ran `ant beta:worker run`.

The two Console steps are unavoidable — generating an environment key and
registering a webhook are Console-only in Managed Agents. Everything else is
automated; ids never need to be pasted by hand.

**Polling mode** (`TRIGGER_MODE=polling` in `.env`) drops the second Console gate
entirely — there is no webhook to register and no signing key to paste, so
`bootstrap` goes straight from provisioning to a single deploy:

```bash
npm run bootstrap          # creates environment → stops: generate the env key in the Console
#   paste ANTHROPIC_ENVIRONMENT_KEY into .env
npm run bootstrap          # creates agent + snapshot, deploys in polling mode — done
npm run session        # prove it end to end
```

### Manual steps (what bootstrap automates)

```bash
npm run create-environment   # → add ANTHROPIC_ENVIRONMENT_ID to .env; mint the env key in the Console
npm run create-agent         # → add ANTHROPIC_AGENT_ID to .env
npm run build-snapshot       # → add BUDDY_BASE_SNAPSHOT_ID to .env
npm run deploy-orchestrator  # prints the public webhook URL
npm run set-webhook          # prints the URL + Console steps; then redeploy after adding the signing key
npm run session
```

## Tests

```bash
npm test          # unit tests: dispatch dedup, inline work-id, janitor matrix, probe, naming/tags
npm run typecheck
```

## Configuration

`.env.example` is the source of truth. Key knobs:

| Var | Meaning |
| --- | --- |
| `TRIGGER_MODE` | `webhook` (default) or `polling` — how the orchestrator discovers queued work. |
| `ANT_VERSION` | `ant` CLI release baked into the base snapshot (default `1.23.0`). |
| `ANT_MAX_IDLE` | `ant beta:worker run --max-idle` — primary stop signal. |
| `WORKER_IDLE_TIMEOUT_SEC` | Buddy per-worker idle auto-stop; must exceed idle gaps. |
| `MAX_IDLE_DAYS` | Janitor deletes STOPPED workers older than this (`0` disables). |
| `JANITOR_SECONDS` | Janitor sweep interval. |
| `POLLER_ENABLED` | Webhook-mode safety-net polling loop (ignored in polling mode, where it always runs). |

## Credential boundary

The worker receives `ANTHROPIC_ENVIRONMENT_KEY` as an encrypted sandbox variable.
Mitigation: only the **scoped, revocable** environment key reaches the worker —
never the admin `ANTHROPIC_API_KEY` or `BUDDY_TOKEN`.

| Credential | Local shell | Orchestrator var | Worker var |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` (admin) | yes | no | no |
| `ANTHROPIC_ENVIRONMENT_KEY` (scoped) | yes | encrypted | encrypted |
| `ANTHROPIC_WEBHOOK_SIGNING_KEY` | yes | encrypted | no |
| `BUDDY_TOKEN` | yes | encrypted | no |
| `ANTHROPIC_WORK_ID` (per run) | — | — | inline in the BASH command, not stored |

> The agent's own `bash` tool runs inside the worker, so it can read that
> worker's env. `encrypted` only hides the value in the Buddy UI/API, not from
> the running process. Rotate/revoke the environment key independently.

## Cleanup

```bash
npm run teardown   # destroys cma-orchestrator and all cma-worker-* sandboxes
```

Snapshots are left in place — delete them from the Buddy dashboard if desired.

## License

MIT — see [LICENSE](LICENSE).

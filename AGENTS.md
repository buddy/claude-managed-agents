# Conventions for this cookbook

- **Language:** TypeScript, ESM (`"type": "module"`), Node 20+. Imports use `.js`
  extensions (NodeNext) even for `.ts` sources; `tsx` runs them directly.
- **SDKs:** `@anthropic-ai/sdk` (beta `managed-agents-*`) for all Anthropic calls;
  `@buddy-works/sandbox-sdk` for all sandbox management, installed from npm.
- **Two Anthropic credentials, never mixed:** the admin `ANTHROPIC_API_KEY` is
  LOCAL only (create-environment/agent/session). The scoped
  `ANTHROPIC_ENVIRONMENT_KEY` is what the orchestrator and workers use. Never put
  the admin key or `BUDDY_TOKEN` on a worker.
- **No secrets in code or git.** Everything comes from env (`.env`, dotenv) or
  Buddy sandbox `variables` (encrypted for secrets).
- **Testability:** orchestration logic (`src/worker-dispatch.ts`, `src/janitor.ts`)
  is dependency-injected via the narrow interfaces in `src/types.ts`. Real SDK
  objects are cast to those at the orchestrator boundary; unit tests pass plain
  fakes (`tests/fixtures.ts`). Keep new logic injectable and add a unit test.
- **Worker env quirk:** Buddy `exec` has no per-process env. Long-lived values go
  in sandbox `variables`; per-run values (the work id) are inlined into the BASH
  command. Don't reach for an env arg on `runCommand` — it doesn't exist.
- **One orchestrator per environment.** Identifier `cma-orchestrator`; workers are
  `cma-worker-<sanitized session id>`. Janitor scoping keys off the `cma` tag and
  `cma-env:<id>`.
- Run `npm run typecheck && npm test` before considering a change done.

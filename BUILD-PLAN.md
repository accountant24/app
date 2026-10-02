# Accountant24 Mobile Build Plan

How we build [BLUEPRINT.md](BLUEPRINT.md): small milestones, each ending in something that runs, with the riskiest unknowns first so a dead end costs days, not weeks. One branch and PR per milestone, in this repo. The blueprint holds the decisions; this file holds the order, the status and what each step taught us.

## Status

| Milestone | Status | PR |
| --- | --- | --- |
| M0 · Eval set and desktop baseline | in progress | |
| M1 · Cloud risk spike | not started | |
| M1b · Phone client spike | not started | |
| M2 · Port the extension behind an execution environment | not started | |
| M3 · Walking skeleton | not started | |
| M4 · Finish the cloud agent | not started | |

## Starting point

- `packages/pi-extension` is about 2,400 lines with 484 tests. Every command goes through `spawnText` (`src/spawn.ts`); files are read and written with `node:fs` directly in about seven files (`ledger/edit-session.ts`, synchronous; `ledger/transactions.ts`; `ledger/query.ts`, the spill file; `memory/memory.ts`; `files/extract.ts`); paths come from module-level globals in `config.ts`. There is no execution-environment abstraction yet.
- Three ledger files import values from pi: `generateDiffString` (`edit-session.ts`, `transactions.ts`) and `DEFAULT_MAX_BYTES` (`query.ts`). Everything else in `ledger/`, `memory/`, `git/`, `files/` and `system-prompt/sections.ts` is free of pi.
- There was no eval set. The root `start:agent` script runs the pi CLI with the bundled extension, enough to drive it headlessly.

Gaps against the blueprint, fixed along the way:

- The `git/` wrappers ignore exit codes, so a failed commit or push counts as success. The cloud relies on the push being the save, so this gets fixed with a regression test.
- The extension ships no skills; the desktop installs `accountant24/skills` from the marketplace. "Built-in skills ship with the bookkeeper" means vendoring that repo.
- `extract_text` still uses `tesseract`, which the blueprint drops. `query` reads `process.stdout.columns` and spills large output to the host's tmpdir; in the cloud the spill file has to live in the container.

## Milestones

### M0 · Eval set and desktop baseline (≈ 3–4 days, alongside M1)

- An `evals/` package with 20–30 scripted tasks over fixture ledgers: a receipt, a CSV statement, a balance assertion, a bulk edit, a query, a memory update, a multi-turn correction. Each task is scored by checking the resulting journal with hledger, never by reading the reply. Token counts, calls per message and wall time are recorded.
- Run headlessly through pi with the current extension, as `start:agent` does, for the desktop baseline on Sonnet 5.5 and Haiku 4.5.
- Done when `npm run evals` writes a baseline report, committed.

### M1 · Cloud risk spike (≈ 4–5 days, throwaway code in `spikes/`)

- `cloudflare.config.ts` and `infra/bootstrap.ts` for dev: D1, R2 and an Artifacts namespace in the EU, AI Gateway.
- One EU Durable Object runs Pi Durable, calls Claude through AI Gateway, and has one `exec` tool reaching the container through `ctx.container`.
- The container clones and pushes an Artifacts repo; the outbound rule adds the token; a force push is detected.
- Kill or redeploy the Durable Object mid-run and check it resumes from the checkpoint.
- Measure first-reply time, save time, Durable Object memory with a few chats, a run continuing with no client connected, container start time.
- Decides: Pi Durable or the fallback (the desktop's agent host in the sandbox); `cloudflare.config.ts` or `wrangler.jsonc`.

What M1 needs: a Cloudflare account on Workers Paid with Artifacts and Containers, an Anthropic key for AI Gateway, the `cf` CLI logged in, and a pinnable Pi Durable version.

### M1b · Phone client spike (≈ 2–3 days, `spikes/`)

- A bare Expo app with `@assistant-ui/react-native` and `@assistant-ui/react-pi` that streams one M1 chat over the worker's WebSocket (`expo/fetch`, `watchEvents()`) and catches up after a reconnect.
- Decides: assistant-ui's pi runtime as is, patched, or our own small adapter; and with it, the chat wire format the worker exposes.

### M2 · Port the extension behind an execution environment (≈ 1 week)

1. An `ExecEnv` interface: `exec(cmd, {cwd, signal})` plus read, write, mkdir, exists, list, rm. A per-session context `{ env, workspaceRoot, memoryPath, ledgerDir }` replaces the `config.ts` globals. `JournalEditSession` becomes async; `transactions.ts`, `query.ts` (spill file inside the env), `memory.ts` and `extract.ts` go through the env. A `LocalExecEnv` stays for tests and local evals.
2. Inject the three pi value imports, so ledger logic, prompt building and memory never import pi.
3. Fix the `git/` exit codes; drop `tesseract`.
4. Delete `packages/desktop`, `website`, `demo` and `docs`; keep the Apache-2.0 `LICENSE` and `NOTICE`; rewrite `CLAUDE.md` for the new layout.

Done when the existing tests pass on `LocalExecEnv`, the coverage gate holds, and evals match the M0 baseline.

### M3 · Walking skeleton, the real code (≈ 1–1.5 weeks)

- `packages/cloud`: the worker; the `Bookkeeper` Durable Object running Pi Durable with the ported extension; `ContainerExecEnv` over `ctx.container`; the sandbox image (`debian-trixie`, pinned hledger, git, poppler, `pages.sh`); saves (push, then a `log()` check); migrations in the Durable Object's SQLite.
- `packages/mobile`: the thin Expo chat client, on what M1b settled.
- A dev-only token for sign-in; Apple comes in M4.
- Done when, from the iOS simulator, "log a €12 coffee" shows its tool steps live and the commit lands in the Artifacts repo, and evals against dev match the baseline.

### M4 · Finish the cloud agent, blueprint Phase 1 (≈ 2 weeks)

- Apple sign-in, the D1 directory and membership checks, cross-user tests in CI.
- Pages computed on save; uploads to R2 and `extract_text` in the container.
- Idle sandbox stop after a save; concurrent chats on one working copy; surviving a deploy; the caps hook.
- GitHub Actions: tests, D1 migrations, `cf deploy` to dev.

### Later

Blueprint Phases 2 (the app on TestFlight) and 3 (launch), planned in detail after M4, once the spikes have reshaped them.

## Verification

- Vitest unit and integration tests at every step; from M3, `@cloudflare/vitest-pool-workers` for the Durable Object and its SQLite.
- The eval report is the parity check after M2, M3 and M4, against the committed M0 baseline.
- Each spike ends with a short result here (numbers plus go or no-go); anything that changes a decision goes into the blueprint too.

## Results

Filled in as milestones finish.

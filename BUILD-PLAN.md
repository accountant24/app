# Accountant24 Mobile Build Plan

How we build [BLUEPRINT.md](BLUEPRINT.md): small milestones, each ending in something that runs, with the riskiest unknowns first so a dead end costs days, not weeks. The blueprint holds the decisions; this file holds the order, the status and what each step taught us.

Branches: `mobile-app` is the mobile branch, and its PR (#3) goes to `main` only once the whole app is ready. Each milestone gets its own branch and PR into `mobile-app`.

## Status

| Milestone                                               | Status                         | PR  |
| ------------------------------------------------------- | ------------------------------ | --- |
| M0 · Eval set and desktop baseline                      | done                           | #2  |
| M1 · Cloud risk spike                                   | done (spike run on 2026-10-03) |     |
| M1b · Phone client spike                                | not started                    |     |
| M2 · Port the extension behind an execution environment | not started                    |     |
| M3 · Walking skeleton                                   | not started                    |     |
| M4 · Finish the cloud agent                             | not started                    |     |

## Starting point

- `packages/pi-extension` is about 2,400 lines with 484 tests. Every command goes through `spawnText` (`src/spawn.ts`); files are read and written with `node:fs` directly in about seven files (`ledger/edit-session.ts`, synchronous; `ledger/transactions.ts`; `ledger/query.ts`, the spill file; `memory/memory.ts`; `files/extract.ts`); paths come from module-level globals in `config.ts`. There is no execution-environment abstraction yet.
- Three ledger files import values from pi: `generateDiffString` (`edit-session.ts`, `transactions.ts`) and `DEFAULT_MAX_BYTES` (`query.ts`). Everything else in `ledger/`, `memory/`, `git/`, `files/` and `system-prompt/sections.ts` is free of pi.
- ~~There was no eval set. The root `start:agent` script runs the pi CLI with the bundled extension, enough to drive it headlessly.~~ Done in M0: `packages/evals`.

Gaps against the blueprint, fixed along the way:

- The `git/` wrappers ignore exit codes, so a failed commit or push counts as success. The cloud relies on the push being the save, so this gets fixed with a regression test.
- The extension ships no skills; the desktop installs `accountant24/skills` from the marketplace. "Built-in skills ship with the bookkeeper" means vendoring that repo.
- The text after `|` in a transaction header has three names: the agent's `add_transactions` tool calls it the description, hledger and the desktop code call it the note, and the desktop Transactions page labels the column "Comment" (in hledger a comment is the `; …` text, a different thing). Settle on description everywhere, ~~the evals included~~ (done in M0), and relabel the column before the mobile pages copy it.
- `extract_text` still uses `tesseract`, which the blueprint drops. `query` reads `process.stdout.columns` and spills large output to the host's tmpdir; in the cloud the spill file has to live in the container.

## Milestones

### ~~M0 · Eval set and desktop baseline~~ (done, PR #2)

- ~~An `evals/` package with 20–30 scripted tasks over fixture ledgers: a receipt, a CSV statement, a balance assertion, a bulk edit, a query, a memory update, a multi-turn correction. Each task is scored by checking the resulting journal with hledger, never by reading the reply. Token counts, calls per message and wall time are recorded.~~ 38 cases.
- ~~Run headlessly through pi with the current extension, as `start:agent` does, for the desktop baseline on Sonnet 5.5 and Haiku 4.5.~~ Nine models, see Results.
- ~~Done when `npm run evals` writes a baseline report, committed.~~

### ~~M1 · Cloud risk spike~~ (done, `spikes/m1-cloud`, see Results)

Cloudflare's Pi harness (`agents/harness/pi`, agents 0.26) already hosts Pi Durable in a Durable Object, so the spike checks it fits rather than building that part.

- ~~`cloudflare.config.ts` and `infra/bootstrap.ts` for dev: D1, R2 and an Artifacts namespace in the EU, AI Gateway.~~ `wrangler.jsonc` plus `infra/up.ts` and `infra/down.ts`; R2 waits on being enabled in the dashboard.
- ~~One EU Durable Object with `Lifecycle.install(this).use(new PiHarness(…))`, on pinned agents and Pi Durable versions, calling DeepSeek V4.1 Flash on Fireworks through AI Gateway's custom provider (`custom-fireworks`, key stored in the gateway), with images passing through unchanged. Two ledger tools, one prompt section and the memory guard ported to Pi Durable's extension API.~~
- ~~An `ExecutionEnv` over the container (`ctx.container`, Sandbox SDK) running Pi Durable's file tools, `bash` and hledger, one environment per set of books; tool calls set to run one at a time.~~
- ~~The container clones and pushes an Artifacts repo; the outbound rule adds the token; a force push is detected.~~
- ~~Two chats at once on one container, then a crash or deploy mid-`bash`: the tool not safe to replay comes back as interrupted, the safe one reruns, and both chats finish.~~
- ~~Measure: first-reply time, save time, memory with a few chats (not measurable from inside; left to the beta), a run finishing with no client connected, container start time, a photo over 2 MB, SQLite writes per run, and whether a newly deployed tool reaches existing chats.~~
- ~~Decides: the harness, a vendored copy of it, or the fallback (the desktop's agent host in the sandbox); `cloudflare.config.ts` or `wrangler.jsonc`.~~ The harness, as is; `wrangler.jsonc`.

What M1 needs: a Cloudflare account on Workers Paid with Artifacts and Containers, a Fireworks key to store in AI Gateway, and the `cf` CLI logged in.

### M1b · Phone client spike (≈ 2–3 days, `spikes/`)

- A bare Expo app with `@assistant-ui/react-native` and `@assistant-ui/react-pi` that streams one M1 chat over the worker's WebSocket and catches up after a reconnect. react-pi is built for pi-coding-agent, so this includes the adapter that maps Pi Durable's snapshot and events to react-pi's client interface.
- Decides: the adapter's shape and, with it, the chat wire format the worker exposes.

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

### M0 · Eval set and desktop baseline (2026-10-02)

- `packages/evals`: 38 cases on a generated US household (invented data), run through pi exactly as the desktop agent host runs it, graded on the books left behind: correct (expected transactions, payees, descriptions, balances, memory), saved (committed, history never rewritten), valid (`hledger check --strict`), safe (journals never changed through bash). Every case states why it exists and its source; `npm run evals:overview` shows them all.
- Results live in dated run sets stamped with the cases, harness and agent they ran against; `npm run evals:compare` writes `comparison.md`. The first run set is `packages/evals/results/2026-10-02-models/`.
- Baseline, desktop agent at medium thinking, 76 runs per model (38 cases × 2):

| Model            | Pass | Cost per case |
| ---------------- | ---- | ------------- |
| Claude Opus 5    | 95%  | $0.111        |
| GPT-5.6 Sol      | 89%  | $0.099        |
| GPT-5.6 Terra    | 89%  | $0.032        |
| Claude Sonnet 5  | 78%  | $0.050        |
| GPT-5.6 Luna     | 74%  | $0.004        |
| Claude Haiku 4.5 | 45%  | $0.026        |

- Every model kept the ledger valid and never touched journals through bash. Opus, Sol and Terra sit within the noise of each other (about ±10 points at 76 runs); Opus is the clear best at statement imports. Terra matches Sol at about a third of the cost. Haiku 4.5 often skips the commit, which rules it out where the push is the save.
- Weak spots shared by every model point at the prompt, not a model: no holdings checks from a broker screenshot (0% everywhere), missing balance checks after CSV imports, explanations not reaching the description, and "from now on" rules not saved to memory. These are the first candidates for a prompt round, measured as a new run set.
- The blueprint's model decision (Sonnet 5.5 or Haiku) predates these numbers: Haiku 4.5 is out, and an OpenAI model such as Terra is now a serious option next to Claude. The M3 eval run against the cloud agent compares with this run set.

### M1 · Cloud risk spike (2026-10-03)

- `spikes/m1-cloud` ran the cloud half end to end on the Personal Cloudflare account: an EU bookkeeper hosting Pi Durable through the Pi harness (one session per chat, tools one at a time), DeepSeek V4.1 Flash on Fireworks through AI Gateway, pi's file tools and `bash` plus ported ledger tools running in the books' container through our `ExecutionEnv`, and the working copy cloned from and pushed to Artifacts. Everything is named `a24-m1-*` and removed with `npm run down -- --yes`; moving to the hosting account is a fresh `up` and `deploy` there.
- **Decides: the harness, as is,** with `wrangler.jsonc` (the `cf` CLI wasn't needed). Nothing in the harness had to be vendored or patched.
- Numbers:

| What                                                                                          | Measured                                                                      |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Booking a receipt and saving it, alone (4 model calls: look up accounts, add, save, answer)   | 13.4 s; the save alone 5.5 s                                                  |
| The same while a second chat ran, with one rejected attempt and a memory note (7 model calls) | 28.7 s, first text after 3.8 s                                                |
| A question in a second chat at the same time, same container                                  | 8.0 s, first text after 3.0 s                                                 |
| A photo of 2.3 MB                                                                             | stored and read correctly, 3.8 s; the database grew by 3 MB                   |
| Container cold start / clone / first command                                                  | 0.3 s / 1.0–1.4 s / 1.5–1.9 s                                                 |
| Bookkeeper restart onto a running container                                                   | 7 ms, no clone                                                                |
| SQLite rows written per message                                                               | about 200 for a short answer, 560 for a booking (every index counts as a row) |

- **Recovery works as designed.** A crash mid-tool in two chats: the replay-safe tool reran and finished, the unsafe `bash` came back as interrupted and the model said so without retrying. With no client connected after the crash, the harness's alarm woke the bookkeeper about 20 seconds later and the run finished.
- **Deploys.** The bookkeeper picks up new code 30–40 seconds after a deploy; the running container and its unsaved changes survive; chats created before a tool existed can call it after the deploy.
- **Force pushes are detected.** The check after each push compares the new history with the last known head; a force push in the spike was flagged, a normal push wasn't. The Artifacts token never enters the sandbox: the container has no internet, and the Worker adds a 15-minute repo token to its git requests.
- **What didn't work as documented,** each with a workaround in the spike:
  - `createAI` (agents/models/pi-ai) refuses custom gateway providers, and the gateway's universal endpoint, which the AI binding uses, answers 502 for them. The model call goes to the gateway's provider URL with a Run-only gateway token instead, which reaches every gateway in the account.
  - A BYOK key for a custom provider only works when registered under the bare slug (`a24-m1-fireworks`), not under `custom-a24-m1-fireworks` as the docs say.
  - `container.exec`'s `user` option wants numeric `"1000:1000"`; a name like `"agent"` fails with an opaque internal error. A separate user also wouldn't protect much on its own: the runtime gives every process, root or not, capabilities including `CAP_DAC_OVERRIDE`. Decided to keep it simple: everything runs as root, and the container plus the checks after each push are the boundary.
  - R2 has to be enabled once in the dashboard before the API can create a bucket.
- **Time.** The same booking takes about 9 s on the desktop with the same model. The cloud's extra goes to the save (5.5 s: the Worker mints a fresh Artifacts token for every git request of a push) and to tool calls, each a few container round trips of 100–300 ms. Caching the token for its lifetime and doing a tool's file write and hledger check in one container call are the first fixes.
- **SQLite writes.** Most rows are Pi Durable's checkpoints (`pi_tasks`, six rows per write with its indexes) and document revisions (`pi_document_revisions`: the live view, usage and inbox, written as the run goes). At 560 rows a message and 80 messages a month that is about 45,000 rows per subscriber; 2,000 subscribers stay near the 50 million rows a month Workers Paid includes, and the rest costs $1 per million, about $0.02 per subscriber.
- Not measured: the bookkeeper's memory with several chats (nothing reports it from inside; watch it in the beta).

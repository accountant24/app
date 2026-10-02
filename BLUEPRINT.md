# Accountant24 Mobile Blueprint

How to turn the desktop agent into a paid, closed-source iPhone app on Cloudflare, with the model (Claude), compute and storage included.

## The short version

Keep the ledger logic, the tools, the prompt and hledger. Each set of books gets one Durable Object, the bookkeeper, that runs the agent on Pi Durable with a checkpoint after every step, and one sandbox where the agent's commands run on a clone of the books repo (git, in Cloudflare Artifacts). Pages are computed at save time. Everything stored stays in Cloudflare's EU jurisdiction; the model is Claude through Cloudflare's AI Gateway.

| Area | Pick |
| --- | --- |
| Cloud | Cloudflare: Workers, Durable Objects, Containers, Artifacts, R2, D1, AI Gateway; storage in the EU; defined in TypeScript (`cloudflare.config.ts`, `cf` CLI) |
| Books | One git repo per set of books in Artifacts (the books repo), with a daily fork as a snapshot |
| Server | One Worker (the worker): sign-in, the chat connection, uploads, pages |
| State | The bookkeeper, one Durable Object per set of books: chats, checkpoints, page data. The directory (D1): users, sessions, members, limits |
| Agent | Pi Durable in the bookkeeper, one conversation per chat, with `pi-extension` ported to it |
| Sandbox | One container per set of books, shared by its chats, driven through `ctx.container`; runs commands only |
| Model | Claude via AI Gateway, one model as a server setting; open models on Workers AI if the evals pick them |
| Accounting engine | hledger, one pinned version |
| Uploads | PDFs and CSVs in R2, read with `extract_text`; photos go to the model directly |
| Mobile app | Expo, assistant-ui (React Native) with its pi runtime (`@assistant-ui/react-pi`) |
| Sign-in | Sign in with Apple only, with our own session tokens |
| Payments | None in the beta; RevenueCat on StoreKit 2 at the public launch |

This repo is a closed fork of the open-source desktop app; keep the Apache-2.0 license and notice for the forked code.

## Architecture

The bookkeeper holds the agent: it runs every chat, stores chats and checkpoints in its SQLite, calls the model and streams each chat to the phones. The sandbox only runs the agent's commands, on one working copy shared by all chats, as every chat on the Mac shares the workspace folder. It holds no agent, no credentials and never the only copy, and pages never wake it.

```
                 +-----------------------------------+ token +---------------+
                 | MOBILE APP (Expo, React Native)   | <---- | Sign in with  |
                 | chat with tool steps              |       | Apple         |
                 | Transactions, Net worth           |       +---------------+
                 | photos, Files, share sheet        |
                 +-----------------------------------+
                                   |
                                   | chat (WebSocket), uploads, pages, sign-in
+----------------------------------|-------------------------------------------------------+
|                                  v                                                       |
|  +------------------------------------------------+   +-------------------------------+  |
|  | WORKER                                         |-->| DIRECTORY (D1)                |  |
|  | sign-in, session tokens, chat connection,      |   | users, identities, sessions,  |  |
|  | uploads, pages                                 |   | books, members, daily_runs    |  |
|  +------------------------------------------------+   +-------------------------------+  |
|                          |                                                               |
|                          v                                                               |
|  +------------------------------------------------+   +-------------------------------+  |
|  | BOOKKEEPER (Durable Object)                    |-->| UPLOADS (R2)                  |  |
|  | one per set of books; the agent (Pi Durable),  |   | PDFs and CSVs, per set of     |  |
|  | chats and checkpoints, saves, pages; drives    |   | books                         |  |
|  | its container via ctx.container; outbound rule |   +-------------------------------+  |
|  +------------------------------------------------+                                      |
|        |  commands, files            |  model calls                                      |
|        v                             v                                                   |
|  +---------------------------+   +------------------+                                    |
|  | SANDBOX                   |   | AI GATEWAY       |                                    |
|  | one per set of books;     |   +------------------+                                    |
|  | the clone, hledger, git,  |            |                                              |
|  | poppler; no agent         |            |                                              |
|  +---------------------------+            |                                              |
|        |  git, through the outbound rule  |                                              |
|        v                                  |                                              |
|  +------------------+                     |                                              |
|  | BOOKS REPO       |                     |                                              |
|  | Artifacts, one   |                     |                                              |
|  | git repo per set |                     |                                              |
|  | of books         |                     |                                              |
|  +------------------+                     |                                              |
+-------------------------------------------|----------------------------------------------+
  Cloudflare, EU jurisdiction               v
                                  +------------------+
                                  | CLAUDE           |
                                  | (Anthropic)      |
                                  +------------------+
```

### Storage

```
-- books repo: Artifacts namespace "books-repo" (EU jurisdiction)
<books_id>                  -- one git repo per set of books, with their full history
<books_id>-snapshot-<date>  -- a daily fork as a snapshot, kept for 30 days

-- uploads: R2 bucket "uploads" (EU jurisdiction)
<books_id>/files/YYYY/MM/<timestamp>_<name>   -- PDFs and CSVs the user attached

-- bookkeeper: Durable Object, one per set of books, with its own SQLite
current commit · the sandbox · save log
the agent: Pi Durable's storage (conversations, checkpoints, tasks, queued messages)
page data: page_transactions (one row per month) · page_net_worth · page_lists

-- directory: D1 database "directory" (EU jurisdiction)
users           user_id · created_at                                   -- our own ID, never a provider's
identities      provider · sub · user_id · refresh_token               -- unique (provider, sub); apple now, google later
sessions        token_hash · user_id · created_at · expires_at         -- hashes only
books           books_id · owner_user_id · created_at                  -- one per user at first; shared books later
members         books_id · user_id · role                              -- owner, editor, viewer; the owner's row at first
daily_runs      user_id · day · count                                  -- hidden daily cap, from public launch
```

Artifacts is Cloudflare's git server: git clients clone and push with a scoped token, and a Worker can read history and files (`log`, `readFile`) and `fork` a repo. Uploads never go into git, so a books repo stays a few MB (limits: 1 GB per repo, 32 MB per file). User IDs are our own and separate from books IDs, so Google sign-in and shared books need no migration.

Two things may leave the EU: model calls to Anthropic, and the running sandbox, since containers on the new scheduling policy can't yet be pinned to the EU. The privacy policy says both, and container placement must be settled before the public launch.

### Chats

Each chat is a Pi Durable conversation in the bookkeeper's SQLite, with every message, tool step and image; a phone that reconnects catches up from its current state. Summarization is off: near 70% of the model's context the app asks for a new chat, and `memory.md` carries the important facts over. Chats never expire.

## Example: logging a receipt

A user sends a photo of a receipt. r41 and r42 are versions of the books.

```
iPhone             Bookkeeper (pi)         Sandbox                 Claude
  |                     |                      |                       |
  | 1 "log receipt"     |                      |                       |
  |   + photo --------->|                      |                       |
  |                     |-- 2 chat + photo --------------------------->|
  |                     |<- 3 tool call: add_transactions -------------|
  |                     |-- 4 start, clone --->|                       |
  |                     |     r41              |                       |
  |                     |-- 5 write entry ---->|                       |
  |                     |-- 6 tool result ---------------------------->|
  |                     |<- 7 tool call: commit_and_push --------------|
  |                     |-- 8 check, commit -->|                       |
  |                     |<- git push (r42) ----|                       |
  |                     | 9 check commit,      |                       |
  |                     |   store pages        |                       |
  |                     |-- 10 "saved r42" --------------------------->|
  |                     |<- 11 final reply ----------------------------|
  |<- 12 every step, ---|                      |                       |
  |   as it happens     |                      |                       |
```

- The sandbox starts on the first tool call (4) and clones the last save.
- Tools run in the bookkeeper and reach the clone through `ctx.container` (5, 8).
- The push (8) is the only moment the books change; the outbound rule adds the repo token.
- After the push the bookkeeper checks the commit and stores the pages (9); open pages reload when the phone sees "saved r42".
- The phone sees every step live and catches up after a disconnect. If the bookkeeper restarts mid-run, Pi Durable resumes from the last checkpoint.

## How it works

| Part | Called by | Does | Holds or reaches |
| --- | --- | --- | --- |
| worker | the mobile app, with Apple's token or our session token | sign-in, account deletion, the chat connection, uploads, pages | directory, bookkeepers, uploads |
| bookkeeper | the worker | the agent, chats, the sandbox, saves, pages, the outbound rule | the AI Gateway token, the books repo token and `log`, uploads, the container |
| sandbox | the bookkeeper | the agent's commands: files, `bash`, hledger, git, poppler | its clone; through the outbound rule, only its own books repo |

**Sign-in and identity.** The app signs in with `expo-apple-authentication`. The worker verifies Apple's token, exchanges the code for Apple's refresh token, and finds or creates the user by `(provider, sub)`, which is unique; a new user gets `users`, `books` and `members` rows and an empty books repo. The user ID comes only from the session token, and the worker forwards a request for a `books_id` only if `members` lists that user. Deleting the account revokes the Apple token (App Store 5.1.1(v)) and deletes the sessions, the sandbox, the user's books with their repos, snapshots, uploads and bookkeepers, and the user's rows. Cross-user tests in CI check that one user can't reach another's books.

**The sandbox.** It starts on the first tool call (about 0.65 s plus the clone, so 1–2 s) and stops after 10 idle minutes, once anything unsaved is saved. The bookkeeper is a plain Durable Object that drives it through `ctx.container` (start, stop, `exec`, files), with Sandbox SDK 1.0 as a helper library. Its only network access is the outbound rule, the bookkeeper's handler for every request the container makes: it allows only the books repo and adds the repo token.

**The agent.** Pi Durable ([announcement](https://earendil.com/posts/pi-durable/)) is pi's server harness, experimental since 1 October 2026. Each bookkeeper hosts one harness with one conversation per chat and its storage in the bookkeeper's SQLite. After a crash, a deploy or an eviction it resumes from the last checkpoint: an interrupted model call is resent, and an interrupted tool call reruns if it's marked safe to replay, or the model is told it was cut off. Our extension is `pi-extension` ported to Pi Durable: the ledger tools, the prompt sections (`system.md`, plus memory, accounts, payees and tags each turn), the memory guard as a hook, and the built-in skills. The ledger logic stays shared with the desktop.

**Tools.** Pi's file tools and `bash`, plus the ledger tools (`add_transactions`, `query`, `commit_and_push`, `extract_text`, …). They run in the bookkeeper and reach the clone through our execution environment over `ctx.container`; the hledger and git calls that go through `spawnText` on the desktop become `exec` calls. Only commands run in the sandbox, so a tricked `bash` can't change the agent, its prompt or its tools.

**Saving.** As on the desktop, writes land in the working copy at once, and the agent calls `commit_and_push` after a batch of changes and at the end of a turn.

1. `commit_and_push` runs in the sandbox: it commits with git hooks off (`core.hooksPath=/dev/null`), checks `hledger check --strict`, and pushes without `--force`. The push is the save.
2. The bookkeeper sees the push in the outbound rule and checks with `log()` that it follows the last saved commit; a rewritten history is restored from the latest snapshot.
3. It computes the pages from that commit (not the working copy) in the sandbox, checks them (valid JSON, expected shape, size limit) and stores them.
4. It also saves at the end of every run and before stopping an idle sandbox.
5. If the container dies with unsaved changes, the next sandbox starts from the last save, and the bookkeeper tells the agent so it redoes them.

One working copy means saves never conflict. A commit includes every unsaved change, whichever chat made it, and carries the chat ID, so undo is `git revert`. Artifacts can't refuse a push, so the checks run after it, and the daily forks cover a bad one. A tricked `bash` could get around the checks in the sandbox, but only on its own books, as on the desktop; a verifier container that never runs model code comes with shared books.

**The model.** The bookkeeper calls Claude through AI Gateway, with the gateway token as a Worker secret; the gateway holds the Anthropic key and the spend and rate limits. A harness hook counts model calls per set of books for the per-run and daily caps. Gateway logging stays off, because prompts carry users' books.

**Documents.** Photos go to the model directly. PDFs and CSVs go to R2, and the message carries their path. `extract_text` copies the file into the sandbox if needed, then runs `pdftotext -layout`, or returns page images (`pdftoppm`) for scans. Text is several times cheaper than a native PDF, on every later call too, and works with models that can't read PDFs.

**Skills.** Instructions only (`SKILL.md`): the built-in ones ship with the bookkeeper's code, and users' own live in the books repo.

**Calls outside chat.** Chat names, widgets and insights are single model calls from the bookkeeper over page data, with a JSON schema, stored under a hash of their inputs so they run again only when the books change; each picks its own cheap model and counts against the caps. Deeper jobs, such as a monthly review or budget alerts, run as Pi Durable conversations without a chat, started after a save or on an alarm.

**Data changes.** Directory changes are numbered SQL files applied on deploy. The bookkeeper's SQLite migrates itself with numbered steps in its constructor, inside `blockConcurrencyWhile`, so an idle bookkeeper migrates when it next wakes; shipped steps are never edited, and Pi Durable's table changes ship as steps too. Tests run them over real SQLite (`@cloudflare/vitest-pool-workers`). Changes go in two releases, add first and remove later, so a rollback still works. Changes to the books themselves are workspace migrations, run in the sandbox.

**The image.** `cloudflare/debian-trixie` plus git, hledger (pinned, the desktop's version), poppler-utils and `/opt/a24/pages.sh`. No agent, no secrets, no Python, and no tesseract (vision models read scans better).

## Auth

Two rules carry most of the security: the agent never gets a way to name another user or set of books, and every token can be cancelled.

- **Apple sign-in.** The app sends Apple the hash of a one-time nonce and the worker the nonce itself. The worker checks Apple's signature, the nonce, the issuer, our bundle ID as the audience, and the expiry.
- **Session tokens.** Opaque, 90 days, kept in the Keychain (`expo-secure-store`, this device only). The directory stores only the hash, so logout, deletion or a stolen phone cancels a token by deleting its row.
- **The agent can't pick the user or the books.** It lives in one bookkeeper, its tools reach only that bookkeeper's sandbox, the sandbox reaches only its own repo, and the worker checks membership before anything reaches the bookkeeper.
- **No secrets in the sandbox, logs or chats.** The gateway token stays in the bookkeeper, the repo token is added outside the sandbox, and logs carry IDs only.
- **Later:** Apple's server-to-server notifications, and a list of signed-in devices.

## Pages

Pages are computed on every save in the sandbox and stored in the bookkeeper: `page_transactions` (one row per month, so a save rewrites only the months that changed), `page_net_worth` and `page_lists`. The bookkeeper serves them after the worker checks membership, so no page ever starts a container. Pages refetch after a save and when the app returns to the foreground.

| Page | hledger command |
| --- | --- |
| Transactions | `hledger print -O json` |
| Net worth | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers | `hledger accounts`, `payees`, `tags` |

## Planned for the public launch

**Payments.** The TestFlight beta is free. At the public launch:

- RevenueCat on StoreKit 2, with our `user_id` as its app user ID; a paywall and restore purchases.
- A webhook route on the worker that stores `plans (user_id · plan · renews_at · event_at)` and ignores events older than the stored one.
- An active plan is required to open a chat; Family Sharing comes with shared books.

**Export.** A read-only clone URL for the books repo (an expiring read token), or a zip from `git archive`, with uploads and chats. Until then, by hand.

## Infrastructure as code

| Layer | Where | What it defines |
| --- | --- | --- |
| Project | `cloudflare.config.ts`, deployed with `cf deploy` | the worker, the `Bookkeeper` class and its container image, bindings, model settings; dev and prod from one function of the mode |
| Code | the `Bookkeeper` class | EU jurisdiction for every bookkeeper (`jurisdiction("eu")`, in one helper); the outbound rules |
| Account | `infra/bootstrap.ts`, run once per environment, safe to rerun | D1, R2 and the Artifacts namespace in the EU; AI Gateway (Anthropic key, logging off, token, rate limits); secrets; usage notifications |

`cloudflare.config.ts` only refers to resources and has no EU setting, so the bootstrap script creates them. GitHub Actions runs the tests, the directory's migrations and `cf deploy`: dev on every merge, prod on a tag. A rollback restores code, never data. `cf` is in open beta: D1 migrations, single secrets and live logs still go through Wrangler, and if the spike finds the container unsupported in `cloudflare.config.ts`, start on `wrangler.jsonc` and run `cf migrate` later.

## Costs and unit economics

| | Before launch | At launch |
| --- | --- | --- |
| Cloudflare (Workers Paid, objects, Artifacts, R2, D1) | ≈ $5 | ≈ $20–60 |
| Sandboxes (Containers, per use) | usage | measure in the spike |
| RevenueCat, Expo, Sentry, PostHog | $0 | $0–50 |
| **Total** | **≈ $5–10** | **≈ $20–110** + model + sandbox time |

Per subscriber per month, assuming 80 messages with 3 model calls each, 20k tokens of context per call with 75% from cache, 800 output tokens per call, and 2,000 subscribers. Prices include 20% EU VAT; Apple takes 15% of the price after VAT; Claude at Anthropic's list prices, open models at Workers AI's.

```
                               ||     Sonnet 5.5     Sonnet 5.5      Haiku 4.5  GLM-5.3-Flash      Kimi K2.6
                               ||          $9.99         $12.99          $9.99          $9.99          $9.99
===============================++===========================================================================
income:subscription            ||           9.99          12.99           9.99           9.99           9.99
-------------------------------++---------------------------------------------------------------------------
expenses:tax:vat               ||           1.67           2.17           1.67           1.67           1.67
expenses:store:commission      ||           1.25           1.62           1.25           1.25           1.25
expenses:llm:tokens            ||           6.84           6.84           3.42           0.46           2.94
expenses:sandbox               ||           0.06           0.06           0.06           0.06           0.06
expenses:revenuecat            ||           0.09           0.12           0.09           0.09           0.09
expenses:platform:shared       ||           0.03           0.03           0.03           0.03           0.03
expenses:storage               ||           0.01           0.01           0.01           0.01           0.01
-------------------------------++---------------------------------------------------------------------------
                               ||           9.95          10.85           6.53           3.57           6.05
===============================++===========================================================================
Net                            ||           0.04           2.14           3.46           6.42           3.94
Margin (of revenue after VAT)  ||             0%            20%            42%            77%            47%
```

- **Tokens are about 80% of costs.** The levers, in order: shorter chats, better cache hits, fewer calls per message, a cheaper model, the price. The evals measure real token counts, including Sonnet 5.5's newer tokenizer and the savings from `extract_text`.
- **Haiku 4.5** retires in mid-October 2026; its column stands in for Haiku 5.5, not yet priced.
- **GLM-5.3-Flash and Kimi K2.6** run on Workers AI, outside the EU, and must pass the evals. An EU-only Claude route (Bedrock or Vertex EU) costs about 10% more.
- **Sandbox and platform lines** are AWS-era estimates; the spike measures container time and the bookkeeper's billed duration while runs wait on the model.
- **Usage limits.** The beta has none, under a fair-use clause. The public launch adds a hidden daily cap of about 200 messages per user and a spend limit on the Anthropic account.

## Scope

**At launch:** chat with tool steps, a stop button, and runs that finish with the app closed; attachments from the photo library and Files, and files shared from other apps; `@` mentions, the skills sheet, and instruction-only skills made in chat; Transactions and Net worth; export; subscription and account deletion.

**Later, in the product:** Google sign-in with Android or a web app; skill scripts and the plugin marketplace; a History screen with undo; a Memory screen and more charts; dashboard widgets and insights; steering and queued messages (Pi Durable supports both); push notifications; the camera and a document scanner; budget alerts and a monthly review; help pages; shared books with roles and Family Sharing; widgets and Siri; live page updates across devices; long chats with Pi Durable's compaction.

**Later, in the tech:** starting the sandbox when a chat opens; filesystem snapshots as a start-up cache, once Cloudflare says where they're stored; pages for every version, for history and charts; saving after every write (for shared books); a path allowlist on saves; different models for different tasks; per-dollar limits; a separate Cloudflare account for prod; an EU-only model route; an open model on Workers AI if it passes the evals (with tesseract back if it can't read scans); a verifier container (with shared books).

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Pi Durable is experimental** (shipped 1 October 2026). Pin it or vendor it (about 15,000 lines), and keep the ledger logic, prompt building and memory free of pi imports. Phase 0 proves it runs and resumes in a bookkeeper and matches the desktop's eval baseline; the fallback is the desktop's agent host in the sandbox.
- **Cloudflare previews.** The `durable_object` scheduling policy, Sandbox SDK 1.0 (`@next`) and `cf` are betas, and the old `Container` and `Sandbox` classes end on 31 December 2026. Pin them and prove them in the spike, along with the Workers compatibility date.
- **Containers can't be pinned to the EU yet** ([workers-sdk #15995](https://github.com/cloudflare/workers-sdk/issues/15995)). The beta discloses it; settle it with Cloudflare before the public launch.
- **The agent in a Durable Object.** About 128 MB of memory and 2 MB per SQLite row, so the app shrinks photos and the harness keeps only active chats in memory. A run continues with no phone connected because pending model and container calls keep the bookkeeper alive, up to 15 minutes per call, from compatibility date 2026-10-01. Check all three in the spike.
- **Deploys restart Durable Objects.** Runs resume from their checkpoints, so saves must be safe to retry.
- **Confirm with Cloudflare:** Artifacts, R2 and D1 in the EU; container prices and limits; point-in-time recovery for Durable Object storage; Artifacts access, the outbound rule reaching a repo with an injected token, and refusing force pushes.
- **Confirm with Anthropic and Cloudflare:** zero data retention for API calls, AI Gateway passing images unchanged with logging off, and Haiku 5.5's release and price.
- **Commands run as a user that can't change hledger, git or the page script,** so a tricked `bash` can't weaken the save checks.
- **The iOS share extension** (`expo-share-intent`) takes a few days; test it with statements shared from real bank apps.
- **assistant-ui's pi runtime on React Native is unproven** (version 0.0.5, web only so far, reading Pi Durable's `watchEvents()` here). Prototype it first, with `expo/fetch` for streaming.
- **Statements are the priciest messages.** Cap pages and size per upload, and check `pdftotext -layout` on real statements.
- **Measure hledger on a ten-year ledger,** including the size of the Transactions page.
- **hledger and poppler are GPL:** fine on servers, never inside the iOS app.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that revokes the Apple token and reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with Cloudflare, Anthropic, RevenueCat, Sentry, PostHog; a DPIA; where RevenueCat keeps data; privacy label.
- **Security:** cross-user tests that must fail; logs with IDs only; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger, git and poppler run; git hooks off on saves; commands as a restricted user; page data checked before it is stored.
- **Cost control:** the hidden daily cap, a cap on model calls per run, a cap on running sandboxes (the new policy has none of its own), cache-friendly prompt order (context block last), Cloudflare usage notifications, an Anthropic spend limit, and a switch that pauses new runs.
- **Operations:** a tested restore from git history and from a snapshot; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger and poppler GPL).

## Build order

The milestones, their status and what each one taught us live in [BUILD-PLAN.md](BUILD-PLAN.md).

| Phase | Time | Work | Done when |
| --- | --- | --- | --- |
| 0 · Groundwork | ≈ 2 weeks | Eval set and the desktop's baseline; `pi-extension` ported to Pi Durable in its own package, then desktop, website, docs and demos deleted from the fork; dev environment from `cloudflare.config.ts` and the bootstrap script; a spike: Pi Durable in one EU bookkeeper calling AI Gateway, with an execution environment over `ctx.container` and a sandbox that clones and pushes an Artifacts repo; evals on Sonnet and Haiku, with GLM-5.3-Flash and Kimi K2.6 for comparison | the ported tools' tests pass, `cf deploy` works in dev, a run resumes after the bookkeeper restarts, first-reply and save times and the baseline numbers exist |
| 1 · Cloud agent | ≈ 3 weeks | worker and bookkeeper (agent, execution environment, streaming chats, saves with checks, pages, uploads); sign-in and the directory; the sandbox image | evals match the desktop, concurrent chats never lose a change, runs survive a deploy, cross-user tests pass |
| 2 · App on TestFlight | ≈ 4–6 weeks | sign-in, chat, attachments, share extension, Transactions, Net worth, account deletion | you keep your own books on the phone for two weeks |
| 3 · Launch | ≈ 2–3 weeks | payments and export, the daily cap, consent screen, privacy label, legal entity, App Review, prod | live, and the first renewal goes through |

## Decisions for you

1. **Sonnet 5.5 or Haiku?** One Claude model at launch. With EU VAT, Sonnet 5.5 about breaks even at $9.99 (0%); Haiku (42%) or $12.99 (20%) fixes that, if Haiku passes the evals. Haiku 4.5 retires in mid-October 2026, so this means Haiku 5.5 once it ships.
2. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

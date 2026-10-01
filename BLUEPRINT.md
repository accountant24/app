# Accountant24 Mobile Blueprint

How to turn the desktop agent into a paid, closed-source iPhone app on Cloudflare, with the model (Claude), compute and storage included.

## The short version

Keep the ledger logic, the tools, the prompt and hledger. Each set of books gets one Durable Object (the bookkeeper) that runs the agent on Pi Durable, pi's server harness: one conversation per chat, with a checkpoint after every step, so a run survives a crash or a deploy. The agent's commands run in one sandbox per set of books, shared by its chats as every chat on the Mac shares the workspace folder, on a clone of the books repo in Cloudflare Artifacts. Pages are computed at save time, and everything stored stays in Cloudflare's EU jurisdiction. The model is Claude, reached through Cloudflare's AI Gateway; EU-only inference is preferred but not required for the MVP.

| Area | Pick |
| --- | --- |
| Cloud | Cloudflare (Workers, Durable Objects, Containers, Artifacts, R2, D1, AI Gateway), storage in the EU jurisdiction, defined in TypeScript (`cloudflare.config.ts`, `cf` CLI) |
| Books | The books repo: one git repo per set of books in Cloudflare Artifacts; the sandbox clones and pushes it, and a daily fork keeps a snapshot |
| Server | One Worker (the worker): sign-in, the chat connection, uploads and pages |
| State | The bookkeeper, one Durable Object per set of books, with the agent's chats and checkpoints and the page data; the directory (D1) for users, sessions, members and limits |
| Agent | Pi Durable in the bookkeeper, one conversation per chat, with our extension (`pi-extension`, ported) and its storage in the bookkeeper's SQLite |
| Sandboxes | Cloudflare Containers on the `durable_object` scheduling policy: one sandbox per set of books, shared by its chats, where the agent's commands run; the bookkeeper drives it through `ctx.container`, with Sandbox SDK 1.0 as a helper library |
| Model | Claude through Cloudflare's AI Gateway to Anthropic's API, one model as a server setting; open models on Workers AI as the cheaper option the evals may pick later |
| Accounting engine | hledger, one pinned version |
| Uploads | PDFs and CSVs in R2, read by the agent with `extract_text`; photos go to the model directly, as on the desktop |
| Mobile app | Expo, assistant-ui (React Native) with its pi runtime (`@assistant-ui/react-pi`, as on the desktop), fed by Pi Durable's events |
| Sign-in | Sign in with Apple only, no auth vendor: the worker checks Apple's token and issues our own session token |
| Payments | None in the beta; RevenueCat on StoreKit 2 from the public launch (see Planned for the public launch) |

This repo is a closed fork; the open-source desktop app stays in its own repo. Keep the Apache-2.0 license and notice for the forked code.

## Architecture

The bookkeeper holds the agent. Pi Durable runs every chat on the books inside it, keeps the chats and their checkpoints in its SQLite, calls the model and streams each chat to the phones. The sandbox is only where the agent's commands run: one working copy of the books shared by every chat, as every chat on the Mac shares the workspace folder. It holds no agent, no credential and never the only copy, and pages never need it awake. Plain records live in the directory, a D1 database.

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

Artifacts is Cloudflare's git server for agents: ordinary git clients clone and push with a scoped token, and a Worker can read history and files (`log`, `readCommit`, `readFile`) and copy a repo (`fork`) without git. A books repo stays a few MB for years because uploads never go into git (`files/` is git-ignored in the cloud); the limits are 1 GB per repo and 32 MB per file. The user ID is always our own, never Apple's, and users and books have separate IDs, so Google sign-in and shared books need no data migration. Everything is stored in Cloudflare's EU jurisdiction. Model calls go to Anthropic, whose processing may happen outside the EU, and for now so may the sandbox's: containers on the new scheduling policy can't yet be pinned to the EU, so a running sandbox, with its temporary copy of the books, may run elsewhere. The privacy policy says both; an EU-only model route can replace the first later as a server setting, and container placement must be settled before the public launch (see Risks).

### Chat history

Each chat is a Pi Durable conversation in the bookkeeper's SQLite, with every message, tool step and image. The mobile app lists chats and watches one through the bookkeeper; a phone that reconnects catches up from the conversation's current state.

Summarization is off, so a chat always keeps every message. When a chat nears 70% of the model's context, the mobile app asks the user to start a new one, and `memory.md` carries the important facts over. Chats never expire; deleting a chat or the account deletes its rows.

## Example: logging a receipt

What happens when a user sends a photo of a receipt and asks the agent to record it. Time runs from top to bottom, and each arrow is one message between two parts of the system. r41 and r42 are versions of the user's books.

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

1. The user sends a photo of a receipt with a short message over the chat connection.
2. Pi Durable, in the bookkeeper, stores the message and sends the chat and the photo to Claude through AI Gateway.
3. Claude answers with a tool call: add this transaction.
4. The sandbox is asleep, so the bookkeeper starts it, and it clones the books (version r41) from the books repo.
5. `add_transactions` runs in the bookkeeper and writes the journal entry into the sandbox's clone through the execution environment.
6. Pi Durable checkpoints the result and gives it back to Claude.
7. Claude calls `commit_and_push`, as on the desktop.
8. In the sandbox, `commit_and_push` checks the ledger with hledger, commits and pushes. The push passes the outbound rule, which adds the repo token. The push is the only moment the books change.
9. The bookkeeper checks with `log()` that r42 follows the last saved commit, has the sandbox compute the pages from r42, checks their shape and size and stores them.
10. Pi Durable gives "saved r42" back to Claude.
11. Claude writes the final reply.
12. The phone watches the chat the whole time and sees every step as it happens. When it sees "saved r42", open pages reload. If the phone disconnects, the run keeps going, and the phone catches up when it reconnects. If the bookkeeper restarts mid-run, Pi Durable resumes from the last checkpoint.

## How it works

**The worker, the bookkeeper and the directory.** One Worker is the only door in. Records live in the directory, one D1 (SQLite) database with normal tables. Everything live about a set of books goes through its bookkeeper: one Durable Object per set of books with its own SQLite, which Cloudflare runs as exactly one copy, handles requests in order, and puts to sleep when idle. It exists because the books need an agent that runs for minutes, a sandbox and timers, which a table can't hold.

| Part | Called by | Does | Holds or reaches |
| --- | --- | --- | --- |
| worker | the mobile app: Apple's token or our session token | sign-in, logout, account deletion, the chat connection, uploads, pages | directory; bookkeepers; the uploads bucket |
| bookkeeper | the worker | the agent (Pi Durable), chats, the sandbox, saves, pages, the outbound rule | the AI Gateway token, the books repo (its token and `log`), the uploads bucket, the sandbox container |
| sandbox | the bookkeeper | the agent's commands: file reads and writes, `bash`, hledger, git, poppler | its own clone; through the outbound rule, only its books repo |

**Sign-in.** The mobile app signs in with `expo-apple-authentication`. The worker checks Apple's identity token against Apple's public keys and exchanges the authorization code for Apple's refresh token. It finds the user in `identities`, where `(provider, sub)` is unique, so two sign-ins at the same moment still create one user. A new user also gets rows in `users`, `books` and `members` (as owner), and a bookkeeper with an empty books repo and empty page data. The worker then issues a session token (see Auth). Deleting the account revokes the Apple token (App Store rule 5.1.1(v)), deletes the sessions, stops the sandbox, deletes the books the user owns with their books repos, snapshots, uploads and bookkeepers (which hold the chats), and deletes the user's rows.

**Identity.** The user ID comes only from the session token. Every request names a `books_id`, and the worker passes it on only if `members` lists that user for it: when the chat connection opens and on every page or upload request. The agent can't pick a user or books at all: it runs in one set of books' bookkeeper, its tools reach only that bookkeeper's sandbox, and the sandbox's only way out is its own books repo. Cross-user tests in CI check that one user can't reach another's books. Each user has one set of books at first.

**The sandbox.** Opening a chat starts nothing, and neither does a message: the agent starts in the bookkeeper at once, and the sandbox starts on the first tool call while it is asleep. The bookkeeper starts it with `ctx.container.start()` from our image (see The image), and it clones the books; Cloudflare's median container start is about 0.65 seconds, so with the clone that first tool call waits about 1–2 seconds. The bookkeeper is a plain Durable Object, not a subclass of an SDK class: it drives the container through Cloudflare's own `ctx.container` API (start, stop, `exec`, files) and uses Sandbox SDK 1.0 only as a helper library. All chats on the same books share this one sandbox, as on the Mac: a change one chat writes is visible to the others at once. After 10 idle minutes the bookkeeper saves anything unsaved and stops it. Its only network access is the outbound rule, a handler the bookkeeper registers for every HTTP and HTTPS request the container makes: it lets through only the books repo and adds the repo token on the way out. The sandbox holds no agent and no credentials, and a change counts only once it is pushed.

**The agent.** The agent runs on Pi Durable ([announcement](https://earendil.com/posts/pi-durable/), `@earendil-works/pi-durable`), pi's server harness, released with Pi 1.0 on 1 October 2026 and still experimental. Each bookkeeper hosts one harness for its set of books, with one conversation per chat and its storage in the bookkeeper's SQLite. It saves a checkpoint after every step, so a crash, a deploy or an evicted bookkeeper resumes a run where it stopped: an interrupted model call is sent again, and an interrupted tool call reruns if it is marked safe to replay, or the model is told it was cut off. Our extension is `pi-extension` ported to Pi Durable's format: the ledger tools, the prompt sections (`system.md`, plus memory, accounts, payees and tags each turn), the memory guard as a hook, and the built-in skills. The ledger logic itself is shared with the desktop, which keeps pi's coding agent until it moves to Pi Durable too. Stop, queued messages, the model choice and chat names go through the harness.

**Tools.** The same tools as on the desktop: pi's file tools and `bash`, and the ledger tools of `pi-extension` (`add_transactions`, `query`, `commit_and_push`, `extract_text`, …). They run in the bookkeeper and reach the books through our execution environment, which implements file reads, file writes and commands over `ctx.container`; the ledger tools' hledger and git calls, which go through `spawnText` on the desktop, become `exec` calls. Read-only tools are marked safe to replay. Only commands run in the sandbox, so a tricked model's `bash` can't change the agent, its prompt or its tools; at worst it changes the working copy, and only a push makes that count.

**Saving.** Tools and the prompt stay as on the desktop: writes land in the working copy at once, and the agent calls `commit_and_push` after a batch of related changes and at the end of a turn.

1. `commit_and_push` runs in the sandbox: it commits with git hooks turned off (`core.hooksPath=/dev/null`), so a planted hook can't change what is committed, checks that `hledger check --strict` passes, and runs `git push`, never with `--force`. The push is the save.
2. The bookkeeper sees the push in its outbound rule and checks with `log()` that the new commit follows the last saved one. If history was rewritten, it flags the books and restores them from the latest snapshot.
3. It has the sandbox compute the pages from that commit (not the working copy, where another chat may be mid-change), reads them with `readFile`, checks them (valid JSON, the expected shape, a size limit), stores them in its SQLite, and records the new commit.
4. The bookkeeper also runs the same save at the end of every run and before stopping an idle sandbox, so nothing stays unsaved when the agent forgets.
5. If the container dies with unsaved changes, those changes are lost. The next tool call starts a new sandbox from the last save, and the bookkeeper tells the agent that the working copy went back to that save, so it redoes them.

With one working copy there are no stale copies, so saves never conflict. As on the desktop, a commit includes every change not yet saved, whichever chat made it. Commits carry the chat ID, so "undo the last change" reverts that commit with `git revert`. History and restores go through git: `git revert`, or a new commit that brings back an older state. The check after each push catches a rewritten history, and a daily `fork` of the repo, kept for 30 days, covers a bad push. Artifacts has no push checks of its own, so these run after the push, not before.

The save checks run in the sandbox, as on the desktop, and a tricked model could get around them with `bash`, but only on its own books, the same risk the desktop accepts; the snapshots roll a bad push back. A verifier, a second container that never runs model code and checks every save again, comes with shared books, where one person's agent could hurt the books of others.

**The model.** Pi Durable calls Claude at Cloudflare's AI Gateway instead of at Anthropic directly, from the bookkeeper, with the gateway token as a Worker secret, so no key ever reaches the sandbox. The gateway holds the Anthropic key and gives one place for spend and rate limits; a harness hook counts every model call per set of books, which is where the per-run call cap and the daily cap apply. The model is a server setting. Gateway logging stays off, because prompts carry users' books.

**Documents.** As on the desktop. Photos go to the model directly in the message. PDFs and CSVs are uploaded to the worker and stored in R2; the message carries their path (`files/YYYY/MM/…`), and the agent reads them with `extract_text`, which has the bookkeeper copy the file from R2 into the sandbox if it isn't there yet and which runs `pdftotext -layout` for PDFs with text and returns page images (`pdftoppm`) for scans, so the model never gets a whole PDF. Text instead of the native PDF keeps statements several times cheaper, also on every later call that re-sends the chat, and works with models that can't read PDFs.

**Skills.** Skills are instructions only: `SKILL.md` files. The built-in ones ship with the bookkeeper's code, and the ones users create in chat live in the books repo.

**Calls outside chat.** Model calls that don't need the agent, such as chat names, dashboard widgets and short insights, run in the bookkeeper: it calls Claude through AI Gateway with page data in the prompt and a JSON schema for the answer, checks the result, and stores it next to the page data under a hash of its inputs, so a widget calls the model only when its inputs change, not when it is viewed. Each such call names its own model, usually the cheapest that passes, and counts against the same caps. Work that has to dig into the books, such as a monthly review or budget alerts, runs as a Pi Durable conversation without a chat, started by the bookkeeper after a save or on an alarm, with its result stored the same way.

**Data changes.** Directory changes are numbered SQL files applied on deploy. The bookkeeper's own small SQLite migrates itself: numbered steps run in its constructor inside `blockConcurrencyWhile`, before it handles any request, so the code only ever sees the current shape. An idle bookkeeper migrates when it next wakes, even months later, so shipped steps are never edited or removed; tests run them with `@cloudflare/vitest-pool-workers` over real SQLite. Pi Durable's own tables follow its version, so an upgrade that changes them ships as a bookkeeper migration step too. A change that must reach every bookkeeper at once walks the `books` table and wakes each one. New, renamed or deleted object classes are declared in `cloudflare.config.ts`. Changes go in two releases, add first and remove later, so a rollback still works. Changes to the books themselves are workspace migrations, run in the sandbox by the desktop's migration runner.

### The image

Cloudflare's `cloudflare/debian-trixie` image plus:

| Item | What it is |
| --- | --- |
| git | clone, `commit_and_push`, history and undo |
| hledger | one pinned version, the desktop's |
| poppler-utils | `pdftotext` and `pdftoppm` for `extract_text` |
| `/opt/a24/pages.sh` | the page commands of the save step |

The agent, pi and our extension are not in the image; they run in the bookkeeper. Also left out: tesseract and its data (vision models read scans better; it comes back only with a model that can't see), uv and Python (skills have no scripts), and every secret. At start the bookkeeper adds only the clone (`/workspace`).

## Auth

Two rules carry most of the security: the agent never gets a way to name another user or set of books, and every token can be cancelled.

**From the start:**

- **Apple sign-in.** The mobile app sends Apple the hash of a one-time nonce and sends the worker the nonce itself. The worker checks Apple's signature against Apple's public keys, the nonce, the issuer, our bundle ID as the audience, and the expiry.
- **Our session tokens.** An opaque random token that lasts 90 days, kept in the Keychain (`expo-secure-store`, this device only). The directory stores only its hash; the worker looks it up on every request (once per chat connection), so logout, deletion or a stolen phone cancels it by deleting the row. Only our own worker ever checks it, so there are no signing keys, public key sets or audiences to manage.
- **The agent can't pick the user or the books.** It runs in one set of books' bookkeeper, its tools reach only that bookkeeper's sandbox, the sandbox's only way out is its own books repo, and membership is checked by the worker before anything reaches the bookkeeper, so a document that tricks the model still can't reach other books.
- **No secrets in the sandbox, logs or chats.** The gateway token stays in the bookkeeper, and the outbound rule adds the repo token outside the sandbox; logs carry IDs only, never content.

**Later, before the public launch or shared books:**

- **Apple's server-to-server notifications,** to catch users who disconnect the mobile app from their Apple ID.
- **A list of signed-in devices** with a sign-out button for each.

## Pages

Pages are computed on every save in the sandbox, checked by the bookkeeper, and stored in the bookkeeper's SQLite as page data: `page_transactions` with one row per month, `page_net_worth` and `page_lists`. A save rewrites only the months whose JSON changed, usually one or two, so a ten-year ledger is about 120 rows and a save writes only a few; a date range reads its months and filters inside them. New books start with empty page data. To serve a page, the worker checks the session token and membership, and the bookkeeper returns the latest pages for the range asked. Pages always show the latest save, and no page ever starts a container.

| Page | hledger command |
| --- | --- |
| Transactions | `hledger print -O json` |
| Net worth | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers | `hledger accounts`, `payees`, `tags` |

Pages refetch when the chat reports a save and when the mobile app returns to the foreground.

## Planned for the public launch

Left out of the beta to keep it small, and planned like this:

**Payments.** TestFlight and the invite-only beta are free, so the beta has no paywall, no RevenueCat and no webhook. At the public launch:

- RevenueCat on StoreKit 2, with our `user_id` as RevenueCat's app user ID, so a subscription follows the user to other platforms later.
- A paywall and restore purchases in the mobile app.
- A webhook route on the worker. RevenueCat sends a secret header; later the worker also checks RevenueCat's signature and reads the subscription back from RevenueCat's API after each event.
- A directory table `plans`: `user_id · plan · renews_at · event_at`. The webhook stores the plan with the time of the event that set it and ignores older events, so a repeated event changes nothing and no event log is needed.
- Opening a chat connection also requires an active plan.
- Family Sharing on the subscription comes with shared books.

**Export.** The beta has none; data requests are handled by hand until then. At the public launch the worker gives the user a read-only clone URL for the books repo (a read token with an expiry), or a zip made with `git archive` in the sandbox, with the uploads and chats added.

## Infrastructure as code

Everything on Cloudflare is defined in TypeScript in the repo, on Cloudflare's new `cf` CLI. There is no network to set up. It comes in three layers:

| Layer | Where | What it defines |
| --- | --- | --- |
| Project | `cloudflare.config.ts`, deployed with `cf deploy` on every release | the worker and its routes; the `Bookkeeper` object class and its sandbox container image; bindings to the `directory` database, the `uploads` bucket and the `books-repo` namespace; the model and gateway settings. Dev and prod come from one function of the mode, not repeated blocks |
| Code | the `Bookkeeper` class | the EU jurisdiction of every bookkeeper (`jurisdiction("eu")`, in one helper); the outbound rules |
| Account | `infra/bootstrap.ts`, run once per environment and safe to run again | the `directory` database, the `uploads` bucket and the `books-repo` namespace in the EU jurisdiction; one AI Gateway with the Anthropic key, logging off, a gateway token for the bookkeeper, and rate limits; the secrets; usage notifications |

`cloudflare.config.ts` only refers to resources, it doesn't create them, and it has no EU setting, so the account layer creates them with their jurisdiction. GitHub Actions runs the tests, applies the directory's migrations and runs `cf deploy` with a scoped API token: dev on every merge, prod on a tag. A rollback restores code, never data.

`cf` and `cloudflare.config.ts` are in open beta, and Wrangler gets 18 months of maintenance after the beta ends. Until `cf` covers them, the directory's migrations, single secrets and live logs go through Wrangler (`wrangler d1 migrations apply`, `wrangler secret put`, `wrangler tail`). If the Phase 0 spike finds the bookkeeper's container or its SQLite class unsupported in `cloudflare.config.ts`, the project starts on `wrangler.jsonc` and moves with `cf migrate` later.

## Costs and unit economics

| | Before launch | At launch |
| --- | --- | --- |
| Cloudflare (Workers Paid, objects, Artifacts, R2, D1) | ≈ $5 | ≈ $20–60 |
| Sandboxes (Containers, per use) | usage | measure in the spike |
| RevenueCat, Expo, Sentry, PostHog | $0 | $0–50 |
| **Total** | **≈ $5–10** | **≈ $20–110** + model + sandbox time |

The unit economics below are per subscriber per month. They assume 80 messages with 3 model calls each, 20k tokens of context per call with 75% served from cache, 800 output tokens per call, and 2,000 subscribers. Prices include 20% EU VAT; Apple takes 15% of the price after VAT; Claude is at Anthropic's list prices, and the open models at Workers AI's.

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

- **Haiku 4.5** is due to retire in mid-October 2026; Haiku 5.5 is announced without a price yet, so the Haiku column stands in for it.
- **GLM-5.3-Flash and Kimi K2.6** are open models on Cloudflare's Workers AI, both able to read images, with published cache prices. They are the cheaper option for later, if they pass the evals; Workers AI can't yet keep processing in the EU.
- **An EU-only route** costs about 10% more for Claude (Bedrock's or Vertex's EU endpoints), or moves to an EU host for open models (Mistral's EU endpoint, Scaleway, OVHcloud).
- Every column assumes the same token counts and calls per message. Tokenizers differ, and the open models' tool calling is unproven, so the evals decide.

Sonnet 5.5 may do better than its column: reports say it needs up to 30% fewer tokens per task, which would lift its margin at $9.99 to about 25%. It may also do worse: its newer tokenizer turns the same text into about 30% more tokens than Haiku 4.5's. The evals should measure real token counts. Statements read as text through `extract_text` rather than as native PDFs should also lower the token line; the evals measure that too.

The sandbox, platform and storage lines were estimated for AWS. Cloudflare's list prices for containers are lower, and the sandbox runs only while tools run, plus 10 idle minutes; the bookkeeper is billed for duration while a run waits on the model. The spike measures both.

Tokens are about 80% of all costs. The levers, in order: shorter chats, better cache hits, fewer calls per message, a cheaper model, and the price.

TestFlight and the invite-only beta run with no usage limit, under a fair-use clause. Before the public launch, add a hidden daily cap of about 200 messages per user and a spend limit on the Anthropic account.

## Scope

**At launch:**

- Chat with tool steps, a stop button, and runs that finish with the mobile app closed
- Attachments from the photo library and Files, plus files shared from other apps (a bank statement straight into a new chat)
- `@` mentions, the skills sheet, and instruction-only skills made in chat
- Transactions and Net worth
- Export as a zip or git repo
- Subscription and account deletion

**Later, in the product:**

- Sign in with Google, with Android or a web app
- Skill scripts and the plugin marketplace
- A History screen with an undo button (until then, undo is asking the agent)
- A Memory screen and more charts
- Dashboard widgets and insights (see Calls outside chat)
- Steering and queueing messages while the agent works (Pi Durable supports both)
- Push notifications
- The camera and a document scanner
- Budget alerts and a monthly review
- App help pages
- Shared books: invite links that add a `members` row, roles, Family Sharing on the subscription
- Widgets and Siri
- Live page updates across devices, pushed by the bookkeeper over WebSockets
- Long chats with Pi Durable's compaction

**Later, in the tech, when needed:**

- Starting the sandbox when a chat opens, so the first tool call doesn't wait
- Filesystem snapshots of an idle sandbox (`/workspace`) to start from instead of cloning, as a cache only, once Cloudflare confirms where snapshots are stored
- Pages for every version on a separate `pages` branch of the books repo, for a History screen and charts over time
- Saving after every write, so each commit belongs to one chat (for shared books)
- A path allowlist on saves
- Different models for different tasks
- A monthly limit or per-dollar metering
- A separate Cloudflare account for prod
- An EU-only model route: Claude on Bedrock's or Vertex's EU endpoints, or an open model on an EU host
- An open model on Workers AI (GLM-5.3-Flash, Kimi K2.6) if it passes the evals, with tesseract back in the image if it can't read scans
- A verifier: a container that never runs model code and checks every save again (with shared books)

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Pi Durable is experimental.** It shipped on 1 October 2026 and its API may change. Pin it (it's about 15,000 lines, so vendoring is realistic), and keep the ledger logic, the prompt building and memory free of pi imports, with the tools as thin wrappers. Prove in Phase 0 that it runs in a bookkeeper, resumes from its checkpoints in the bookkeeper's SQLite, and matches the desktop's eval baseline. The fallback is the desktop's agent host (pi's coding agent) in the sandbox, with the bookkeeper storing its session files and relaying its events.
- **Cloudflare's new container setup and Sandbox SDK 1.0 are previews.** The `durable_object` scheduling policy launched in public beta on 30 September 2026, Sandbox SDK 1.0 is on its `@next` line, and the older `Container` and `Sandbox` classes get updates only until 31 December 2026. Build on `ctx.container` in a plain Durable Object, pin the SDK, and prove it in the Phase 0 spike.
- **Containers can't yet be pinned to the EU.** Under the new scheduling policy placement constraints are rejected, and a Durable Object's EU jurisdiction doesn't place its container ([workers-sdk #15995](https://github.com/cloudflare/workers-sdk/issues/15995)). The invite-only beta discloses it; before the public launch, get EU placement from Cloudflare or move to a policy that has it.
- **Confirm with Cloudflare** when containers under the new setup can be placed in the EU, and that Artifacts, R2 and D1 all run in the EU jurisdiction (the directory holds all user records); container prices and limits; point-in-time recovery for Durable Object storage; and, for Artifacts, beta access on our account, that a sandbox outbound rule can reach a repo with an injected token, and whether force pushes can be refused.
- **Confirm with Anthropic and Cloudflare** Anthropic's data retention for API calls (ask for zero retention), that AI Gateway passes images through unchanged with logging off, and Haiku 5.5's release and price.
- **The agent in a Durable Object.** A bookkeeper has about 128 MB of memory and SQLite rows of at most 2 MB, so the mobile app shrinks photos before sending and the harness keeps only active chats in memory. A run goes on with no phone connected only while the bookkeeper stays alive, which pending model and container calls ensure from compatibility date 2026-10-01, for up to 15 minutes per pending call. Check all three in the spike.
- **Pin versions.** Pi Durable is pinned with the bookkeeper's code, and hledger and poppler in the sandbox image; hledger is GPL, which is fine on servers but rules it out inside the iOS app. Pin the Workers compatibility date and the `cf` version; its config format may change before the beta ends.
- **Run commands as a user that can't change hledger, git or the page script,** so a tricked `bash` can't weaken the save checks. Check in the spike.
- **Deploys restart Durable Objects.** Pi Durable resumes each run from its last checkpoint; make saves safe to retry, since a save cut off mid-way is rerun or reported to the model.
- **Receiving shared files needs an iOS share extension** (`expo-share-intent`). Budget a few days and test with statements shared from real bank apps.
- **assistant-ui's pi runtime on React Native is unproven.** It runs the desktop's chat, but at version 0.0.5 and on the web, and here it reads Pi Durable's events (`watchEvents()` gives pi's usual ones). Prototype it first, using `expo/fetch` for streaming.
- **Statements are the priciest messages.** Cap pages and size per upload, and check that `pdftotext -layout` keeps real banks' statements readable.
- **Measure hledger on a ten-year ledger**, including the size of the Transactions page JSON.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that revokes the Apple token and reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with Cloudflare, Anthropic, RevenueCat, Sentry, PostHog; a DPIA; check where RevenueCat keeps data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger, git and poppler run; git hooks off on saves; commands as a user that can't change hledger, git or the page script; page data checked before it is stored.
- **Cost control:** hidden daily cap per user, cap on model calls per run in a harness hook, a cap on running sandboxes in the bookkeeper (the new policy has no instance limit of its own), cache-friendly prompt order (context block last), Cloudflare usage notifications, a spend limit on the Anthropic account, and a switch that pauses new runs.
- **Operations:** a tested restore, from git history and from a snapshot; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL, poppler GPL).

## Build order

| Phase | Time | Work | Done when |
| --- | --- | --- | --- |
| 0 · Groundwork | ≈ 2 weeks | Eval set and the desktop's baseline; port `pi-extension` to Pi Durable in its own package, then delete desktop, website, docs, demos from the fork; Cloudflare dev environment from `cloudflare.config.ts` and the bootstrap script; a spike: Pi Durable in one bookkeeper in the EU jurisdiction, with its storage in the bookkeeper's SQLite, calling AI Gateway, and an execution environment over `ctx.container` whose sandbox clones from and pushes to an Artifacts repo through the outbound rule; run the evals on Sonnet and Haiku, with GLM-5.3-Flash and Kimi K2.6 on Workers AI for comparison | the ported tools' tests pass, `cf deploy` works in dev with the container and the bookkeeper's SQLite class, a run resumes from its checkpoint after the bookkeeper restarts, the spike's first-reply and save times and the baseline numbers exist |
| 1 · Cloud agent | ≈ 3 weeks | worker and bookkeeper (Pi Durable with our extension, the execution environment, streaming chats, saves with checks, pages, uploads); sign-in and the directory tables; sandbox image | Evals match the desktop, concurrent chats never lose a change, runs survive a deploy, cross-user tests pass |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, share extension, Transactions, Net worth, delete account | You keep your own books on the phone for two weeks |
| 3 · Launch | ≈ 2–3 weeks | payments and export as planned above, the daily cap in the directory, consent screen, privacy label, legal entity, App Review, prod environment | Live, first renewal goes through |

## Decisions for you

1. **Sonnet 5.5 or Haiku?** One Claude model for everything at launch. With EU VAT, Sonnet 5.5 about breaks even at $9.99 (0%); Haiku (42%) or $12.99 (20%) fixes it, if Haiku passes the evals against the desktop's baseline. Haiku 4.5 retires in mid-October 2026, so this means Haiku 5.5 once it ships.
2. **Which legal entity publishes the mobile app?** Apple and every processor agreement need a company.

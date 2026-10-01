# Accountant24 Mobile Blueprint

How to turn the desktop agent into a paid, closed-source iPhone app on Cloudflare, with the model (Claude), compute and storage included.

## The short version

Keep the ledger logic, the prompt and hledger. Store each ledger's books as a git repo in Cloudflare Artifacts, give each ledger one Durable Object that owns it and runs its tool calls one at a time, run every tool in one sandbox per ledger shared by its chats (like the desktop's workspace folder), serve pages computed at save time, and keep everything stored in Cloudflare's EU jurisdiction. The model is Claude, reached through Cloudflare's AI Gateway; EU-only inference is preferred but not required for the MVP.

| Area              | Pick                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cloud             | Cloudflare (Workers, Durable Objects, Containers, Artifacts, D1, AI Gateway), storage in the EU jurisdiction, defined in wrangler config                           |
| Books             | A git repo per ledger in Cloudflare Artifacts; the sandbox clones and pushes it, and a daily fork keeps a snapshot                                                 |
| Server            | Two Workers: API (tools, saves, pages) and Auth (sign-in and tokens)                                                                                               |
| State             | One Durable Object per ledger; D1 for users, sign-in, members and limits                                                                                           |
| Agent             | deepagents (TypeScript) on LangSmith, EU: Serverless for the beta, Dedicated from launch                                                                           |
| Sandboxes         | Cloudflare's Sandbox SDK: the ledger's Durable Object extends its class and runs one container per ledger, shared by its chats                                     |
| Model             | Claude through Cloudflare's AI Gateway to Anthropic's API, one model as a server setting; open models on Workers AI as the cheaper option the evals may pick later |
| Accounting engine | hledger, one pinned version                                                                                                                                        |
| App               | Expo, assistant-ui (React Native + LangGraph runtime)                                                                                                              |
| Sign-in           | Sign in with Apple only, no auth vendor: the Auth Worker checks Apple's token and issues our own JWT                                                               |
| Payments          | None in the beta; RevenueCat on StoreKit 2 from the public launch (see Planned for the public launch)                                                              |

This repo is a closed fork; the open-source desktop app stays in its own repo. Keep the Apache-2.0 license and notice for the forked code.

## Architecture

The books are git, so the agent works on real files exactly as on the Mac, and history and undo are plain git. Each ledger gets one throwaway sandbox with a clone, shared by all its chats the way every chat on the Mac shares the workspace folder; the sandbox never holds the only copy, and pages never need a sandbox awake. One Durable Object per ledger coordinates everything live about that ledger, so tool calls and saves run one at a time without locks or conditional writes; plain records live in D1 tables.

```
                        +-----------------------------------+ token +---------------+
                        | iOS APP (Expo, React Native)      | <---- | Sign in with  |
                        | chat with tool steps              |       | Apple         |
                        | Transactions, Net worth           |       +---------------+
                        | photos, Files, share sheet        |
                        +-----------------------------------+
                            |               |           |
                            |               |           |
                            | chat          |           |
                            v               |           |
              +--------------------------+  | pages     | sign-in, refresh,
              | AGENT SERVER             |  |           | logout, delete
              | LangSmith, EU            |  |           |
              | deepagents, our JWT      |  |           |
              | chats, runs, traces      |  |           |
              +--------------------------+  |           |
                  | prompts         |       |           |
                  v                 |       |           |
            +---------------------+ | tool  |           |
            | CLAUDE (Anthropic)  | | calls |           |
            | via AI Gateway      | |       |           |
            +---------------------+ |       |           |
+-----------------------------------|-------|-----------|----------------------------------------+
|                                   |       |           |                                        |
|                                   v       v           v                                        |
|  +-----------------------------------------------+  +----------------------------+             |
|  | API WORKER                                    |  | AUTH WORKER                |             |
|  | tools, saves, pages,                          |  | sign-in, refresh, logout,  |             |
|  | the check before a run                        |  | account deletion, JWKS     |             |
|  +----------------|----------------------------|-+  +---------------|------------+             |
|                   |                            |                    |                          |
|                   |                            |                    |                          |
|                   v                            v                    v                          |
|  +------------------------------------------+ +---------------------------------------------+  |
|  | LEDGER (Durable Object, one per ledger)  | | D1 (SQLite)                                 |  |
|  | extends Cloudflare's Sandbox class;      | | users, identities, refresh_tokens,          |  |
|  | current commit, tool-call queue,         | | ledgers, members, daily_runs                |  |
|  | the container, pages, save log           | +---------------------------------------------+  |
|  +------------------------------------------+                                                  |
|        |                        |                                                              |
|        v                        v                                                              |
| +---------------+           +-----------------+                                                |
| | SANDBOX       |   clone   | ARTIFACTS       |                                                |
| | one container |-- push -->| one git repo    |                                                |
| | per ledger;   |           | per ledger,     |                                                |
| | reaches only  |           | full history    |                                                |
| | its repo;     |           +-----------------+                                                |
| | hledger, git  |                                                                              |
| +---------------+                                                                              |
+-- Cloudflare, EU jurisdiction; one image: Cloudflare sandbox + git, hledger, ledger CLI -------+
```

### Storage

```
-- Artifacts namespace "a24-books" (EU jurisdiction)
<ledger_id>                 -- one git repo per ledger: the books with their full history
<ledger_id>-snap-<date>     -- a daily fork as a snapshot, kept for 30 days

-- Ledger Durable Object, one per ledger, with its own SQLite
current commit · tool-call queue · the container · save log
pages: transactions (one row per month) · net worth · accounts, payees, tags

-- D1 "a24" (EU jurisdiction)
users           user_id · created_at                                   -- our own ID, never a provider's
identities      provider · sub · user_id · refresh_token               -- unique (provider, sub); apple now, google later
refresh_tokens  token_hash · user_id · family_id · used · expires_at   -- hashes only; each works once
ledgers         ledger_id · owner_user_id · created_at                 -- one per user at first; shared ledgers later
members         ledger_id · user_id · role                             -- owner, editor, viewer; the owner's row at first
daily_runs      user_id · day · count                                  -- hidden daily cap, from public launch
```

Artifacts is Cloudflare's git server for agents: ordinary git clients clone and push with a scoped token, and a Worker can read history and files (`log`, `readCommit`, `readFile`) and copy a repo (`fork`) without git. A ledger's repo stays a few MB for years because uploads never go into git; the limits are 1 GB per repo and 32 MB per file. The user ID is always our own, never Apple's, and user and ledger are separate IDs, so Google sign-in and shared ledgers need no data migration. Chats and traces live in LangSmith in the Netherlands, and everything else is stored in Cloudflare's EU jurisdiction. Model calls go to Anthropic, whose processing may happen outside the EU; the privacy policy says so, and an EU-only route can replace it later as a server setting.

### Chat history

Each chat is a LangSmith thread with its messages, tool steps and images. The app lists a user's threads through a thin adapter, so moving off LangSmith later only changes that adapter.

Summarization is off, so a thread always keeps every message. When a chat nears 70% of the model's context, the app asks the user to start a new one, and `memory.md` carries the important facts over. Threads never expire, unlike traces, which last 14 days. Keep thread TTL off, and delete a user's threads when they delete a chat or their account.

## Example: logging a receipt

What happens when a user sends a photo of a receipt and asks the agent to record it. Time runs from top to bottom, and each arrow is one message between two parts of the system. r41 and r42 are versions of the user's books.

```
iPhone           Agent server          Sandbox              Ledger, Artifacts    Claude
  |                   |                   |                      |                   |
  | 1 "log receipt"   |                   |                      |                   |
  |   + photo ------->|                   |                      |                   |
  |                   |-- 2 chat + photo ------------------------------------------->|
  |                   |<- 3 tool call: "add_transactions" ---------------------------|
  |                   |-- 4 run add_transactions --------------->|                   |
  |                   |                   |<- 5 start sandbox ---|                   |
  |                   |                   |   + books (r41)      |                   |
  |                   |                   | 6 write entry,       |                   |
  |                   |                   |   hledger check,     |                   |
  |                   |                   |   git commit         |                   |
  |                   |                   |---- 7 git push ----->|                   |
  |                   |                   |                      | 8 check commit,   |
  |                   |                   |                      |   store pages     |
  |                   |<- 9 "saved r42" -------------------------|                   |
  |                   |-- 10 tool result ------------------------------------------->|
  |                   |<- 11 final reply --------------------------------------------|
  |<- 12 reply -------|                   |                      |                   |
```

1. The user sends a photo of a receipt with a short message.
2. The agent server sends the chat and the photo to Claude, through AI Gateway.
3. Claude answers with a tool call: add this transaction.
4. The agent server asks the API Worker to run that tool, and the API Worker passes it to the ledger's Durable Object.
5. The ledger's sandbox is asleep, so the Ledger starts it, and the sandbox clones the books (version r41) from the ledger's Artifacts repo.
6. In the sandbox, the tool writes the journal entry. The agent then calls `commit_and_push`, as on the desktop, which checks the ledger with hledger and commits it with git.
7. The sandbox pushes the commit to the repo. Its only network access is that repo, and the token is added outside the sandbox. The push is the only moment the books change.
8. The Ledger checks with `log()` that the new commit (r42) follows the last saved one, then stores the pages the sandbox computed, after checking their shape and size.
9. The Ledger tells the agent server the save worked.
10. The agent server gives the tool's result back to Claude.
11. Claude writes the final reply.
12. The phone shows the reply.

The phone sees each step as it happens, so the user watches the progress. When the phone sees "saved r42", open pages reload. If the phone disconnects, the run keeps going and the phone picks the stream back up.

## How it works

**Workers, the Ledger and D1.** Two Workers are the only doors in. Records live in D1, one SQLite database with normal tables. Live work on a ledger goes through its Durable Object: one small program per ledger with its own SQLite, which Cloudflare runs as exactly one copy, handles requests in order, and puts to sleep when idle. It exists because a ledger needs a queue for tool calls, a running container and timers, which a table can't hold. The Ledger class lives in the API Worker; the Auth Worker reaches it through a binding.

| Part          | Called by                                                                                        | Does                                                                        | Holds or reaches                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth Worker   | the phone: Apple's token, a refresh token, or our JWT                                            | sign-in, refresh, logout, account deletion, the public keys (JWKS)          | the private signing key; D1 `users`, `identities`, `refresh_tokens`, `ledgers`, `members`; creates and deletes Ledger objects; a LangSmith key to delete threads |
| API Worker    | the phone with our JWT; the agent server with a service secret                                   | pages, tools and saves, the check before a run                              | Ledger objects; D1 `members`, `daily_runs`; the service secret; Auth's public keys                                                                               |
| Ledger object | the API and Auth Workers                                                                         | the current commit, tool calls and saves one at a time, the sandbox, pages  | the ledger's Artifacts repo (its token and `log`), the sandbox container, D1 `members`                                                                           |

Only the ledger's sandbox pushes to its repo, with a token the Ledger adds on the way out; nothing else writes the books. Before a run, the agent server's custom auth asks the API Worker whether the user may run: D1 has the membership and, from the public launch, the daily count; the plan joins this check with payments. On every tool call the Ledger checks `members` in D1 that the user belongs to it, and only owners and editors can save.

**Sign-in.** The app signs in with `expo-apple-authentication`. The Auth Worker checks Apple's identity token against Apple's public keys and exchanges the authorization code for Apple's refresh token. It finds the user in `identities`, where `(provider, sub)` is unique, so two sign-ins at the same moment still create one user. A new user also gets rows in `users`, `ledgers` and `members` (as owner), and a Ledger object with an empty repo and empty pages. Auth then issues a one-hour JWT and a refresh token (see Auth); the agent server's custom auth and the API Worker verify that JWT. Deleting the account revokes the Apple token (App Store rule 5.1.1(v)), cancels the refresh tokens, stops the sandbox, deletes the ledgers the user owns with their repos, snapshots and objects, their threads, and their rows.

**Identity.** The user ID comes only from our verified JWT, never from the request or the model. Every request names a ledger, and the Ledger serves it only if `members` lists that user for it; every storage path is built from that ledger ID. Cross-user tests in CI check that one user can't reach another's ledger. Each user has one ledger at first.

**The sandbox.** Opening a chat starts nothing. On the first tool call while the ledger's sandbox is asleep, the Ledger starts it from our image: Cloudflare's sandbox image plus hledger, git and the ledger program. Its only network access is the ledger's Artifacts repo: a Sandbox SDK outbound rule lets just that host through and adds the repo token, so the sandbox never holds it. The Ledger is a Durable Object that extends the Sandbox class from Cloudflare's Sandbox SDK, so starting, stopping and sleeping the container, running a program in it (`exec`) and reading and writing its files (`readFile`, `writeFile`) come ready-made; we add membership checks, the queue, saving and pages. Cloudflare's median start is about 0.65 seconds; with `git clone` from Artifacts, that tool waits about 1–2 seconds. All the ledger's chats share this one working copy, as every chat on the Mac shares the workspace folder: a change one chat writes is visible to the others at once, and the Ledger runs their tool calls one at a time. Later tools reuse the container; after 10 idle minutes the Ledger saves anything unsaved and stops it. The sandbox is only a working copy, it holds no credentials, and a change counts only once it is pushed.

**Tools.** The agent loop runs on LangSmith, and every tool runs in the sandbox. Our deepagents connector turns the file tools and `execute` into three calls to the API Worker: run a command, write a file, read a file. The API Worker forwards each to the Ledger, which runs it in the sandbox with `exec`, `writeFile` or `readFile`. Ledger tools are thin wrappers that call `exec(["ledger", "<tool>", <arguments as JSON>])`, so their arguments go in directly, with no files and no shell.

**Saving.** The sandbox pushes to Artifacts, and the Ledger checks what arrived. Tools and the prompt stay as on the desktop: writes land in the working copy at once, and the agent calls `commit_and_push` after a batch of related changes and at the end of a turn.

1. `commit_and_push` asks the API Worker to save. In the sandbox, the Ledger runs `git add -A` and `git commit` with git hooks turned off (`core.hooksPath=/dev/null`), so a planted hook can't change what is committed.
2. Still in the sandbox, it checks that `hledger check --strict` passes, runs the page commands, and runs `git push`, never with `--force`. The push is the save.
3. The Ledger checks with `log()` that the new commit follows the last saved one. If history was rewritten, it flags the ledger and restores it from the latest snapshot.
4. It reads the pages out with `readFile`, checks them (valid JSON, the expected shape, a size limit), stores them in its SQLite, and records the new commit.
5. The Ledger also saves on its own at the end of every run and before stopping an idle sandbox, so nothing stays unsaved when the agent forgets. If the container dies with unsaved changes, those changes are lost and the agent redoes them.

With one working copy there are no stale copies, so saves never conflict. As on the desktop, a commit includes every change not yet saved, whichever chat made it. Commits carry the chat and run IDs of the save, so "undo the last change" reverts that commit with `git revert`. History and restores go through git: `git revert`, or a new commit that brings back an older state. The check after each push catches a rewritten history, and a daily `fork` of the repo, kept for 30 days, covers a bad push. Artifacts has no push checks of its own, so these run after the push, not before.

These checks run in the sandbox, as on the desktop. A model tricked into misusing `execute` (the desktop's `bash`) could get around them, but only on its own ledger, the same risk the desktop accepts; the snapshots roll a bad push back. A checker, a second container that never runs model code and checks every save again, comes with shared ledgers, where one person's agent could hurt the books of others.

**The model.** The agent server calls Claude at Cloudflare's AI Gateway instead of at Anthropic directly: the gateway holds the Anthropic key, needs its own gateway token, and passes each call on. It gives one place for model keys, spend and rate limits, and lets the model or the provider change as a server setting. Gateway logging stays off, because prompts carry users' books.

**Documents.** Photos and PDFs go straight to Claude in the message; Claude reads PDFs natively. CSV and other text files go in as plain text. Files never reach the sandbox, and only the chat history keeps them.

**Skills.** Skills are instructions only: `SKILL.md` files in the books repo. The built-in ones ship with the app, and users can create their own in chat.

**Data changes.** D1 changes are numbered SQL files applied with `wrangler d1 migrations` on deploy. The Ledger's own small SQLite migrates itself: numbered steps run in its constructor inside `blockConcurrencyWhile`, before it handles any request, so the code only ever sees the current shape. An idle Ledger migrates when it next wakes, even months later, so shipped steps are never edited or removed; tests run them with `@cloudflare/vitest-pool-workers` over real SQLite. A change that must reach every Ledger at once walks the `ledgers` table and wakes each one. New, renamed or deleted object classes are declared in the wrangler config. Changes go in two releases, add first and remove later, so a rollback still works. Changes to the books themselves reuse the desktop workspace migrations, run in the sandbox.

## Auth

Two rules carry most of the security: the model never picks the user or the ledger, and every token either expires soon or can be cancelled.

**From the start:**

- **Apple sign-in.** The app sends Apple the hash of a one-time nonce and sends Auth the nonce itself. Auth checks Apple's signature against Apple's public keys, the nonce, the issuer, our bundle ID as the audience, and the expiry.
- **Our tokens.** A login JWT that lasts one hour, and an opaque refresh token that lasts 90 days and works once. A JWT can't be taken back, so it stays short; the refresh token is checked against `refresh_tokens` on every use (`UPDATE ... WHERE used = 0`, so exactly one request wins), so logout, deletion or a stolen phone cancels it. The app keeps the JWT in memory and the refresh token in the Keychain (`expo-secure-store`, this device only). A refresh token used twice cancels all of that user's refresh tokens.
- **One signing key pair (ES256).** Auth signs with the private key, kept as a secret of the Auth Worker only. Everyone else gets only the public key from Auth's JWKS (the API Worker through a service binding, LangSmith over HTTPS), caches it, and refetches when a token names a key it doesn't know, so they can check tokens but never make them. Every key has a `kid` from day one.
- **Audience.** Each JWT names the one service it's for, and every service rejects the others'.
- **The model never picks the user or the ledger.** Tools take them from the user the agent server's custom auth verified (`langgraph_auth_user`), never from tool arguments, so a document that tricks the model still can't reach another ledger.
- **Agent server to API Worker.** A long random service secret, kept as a Worker secret and in LangSmith's secrets, sent as a header.
- **No secrets in logs or traces.** Tokens never go into graph state, tool arguments or the sandbox, and LangSmith hides them from traces.

**Later, before the public launch or shared ledgers:**

- **A run token.** Before a run, the API Worker checks the user's JWT, plan, cap and membership, and returns a JWT bound to that user, ledger and chat for about an hour. Tool calls carry it, and the Ledger takes the user and ledger only from it, so a leaked service secret alone opens nothing.
- **Signed requests** from the agent server, with a timestamp, instead of the fixed secret, and a check against LangSmith's EU outbound IPs.
- **A routine for rotating the signing key.**
- **Apple's server-to-server notifications,** to catch users who disconnect the app from their Apple ID.

## Pages

Pages are computed on every save in the sandbox, checked by the Ledger, and stored in the Ledger's SQLite, with Transactions as one row per month. A save rewrites only the months whose JSON changed, usually one or two, so a ten-year ledger is about 120 rows and a save writes only a few; a date range reads its months and filters inside them. A new ledger starts with empty pages. To serve a page, the API Worker checks the token, and the Ledger checks membership and returns the latest pages for the range asked. Pages always show the latest save, and no page ever starts a container.

| Page                 | hledger command                                         |
| -------------------- | ------------------------------------------------------- |
| Transactions         | `hledger print -O json`                                 |
| Net worth            | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers    | `hledger accounts`, `payees`, `tags`                    |

Pages refetch when the chat reports a save and when the app returns to the foreground.

## Planned for the public launch

Left out of the beta to keep it small, and planned like this:

**Payments.** TestFlight and the invite-only beta are free, so the beta has no paywall, no RevenueCat and no webhook. At the public launch:

- RevenueCat on StoreKit 2, with our `user_id` as RevenueCat's app user ID, so a subscription follows the user to other platforms later.
- A paywall and restore purchases in the app.
- A webhook route on the API Worker. RevenueCat sends a secret header; later the API Worker also checks RevenueCat's signature and reads the subscription back from RevenueCat's API after each event.
- A D1 table `plans`: `user_id · plan · renews_at · event_at`. The webhook stores the plan with the time of the event that set it and ignores older events, so a repeated event changes nothing and no event log is needed.
- The check before a run also requires an active plan.
- Family Sharing on the subscription comes with shared ledgers.

**Export.** The beta has none; data requests are handled by hand until then. At the public launch the API Worker gives the user a read-only clone URL for the repo (a read token with an expiry), or a zip made with `git archive` in the sandbox.

## Infrastructure as code

Everything on Cloudflare is declared in wrangler config in the repo, one `wrangler.jsonc` per Worker, with dev and prod environments. GitHub Actions deploys with `wrangler deploy` and a scoped API token. There is no network to set up.

| Piece       | What it declares                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Worker  | routes; the Ledger object class; the Artifacts namespace; the D1 database and its migrations; the container image (Cloudflare's sandbox image plus our tools, outbound only to Artifacts); the service secret                   |
| Auth Worker | routes; a binding to the Ledger class; the D1 database; the private signing key as a secret                                                                                                                                     |
| Storage     | the Artifacts namespace and D1 database in the EU jurisdiction                                                                                                                                                                  |
| AI Gateway  | one gateway with the Anthropic key, logging off, a gateway token for the agent server, and rate limits                                                                                                                          |

## Costs and unit economics

|                                                   | Before launch                   | At launch                             |
| ------------------------------------------------- | ------------------------------- | ------------------------------------- |
| LangSmith (agent server)                          | $39 (Serverless, beta included) | ≈ $430 (Dedicated)                    |
| Cloudflare (Workers Paid, objects, Artifacts, D1) | ≈ $5                            | ≈ $20–60                              |
| Sandboxes (Containers, per use)                   | usage                           | measure in the spike                  |
| RevenueCat, Expo, Sentry, PostHog                 | $0                              | $0–50                                 |
| **Total**                                         | **≈ $45–50**                    | **≈ $450–550** + model + sandbox time |

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
expenses:platform:shared       ||           0.24           0.24           0.24           0.24           0.24
expenses:storage               ||           0.01           0.01           0.01           0.01           0.01
-------------------------------++---------------------------------------------------------------------------
                               ||          10.16          11.06           6.74           3.78           6.26
===============================++===========================================================================
Net                            ||          -0.17           1.93           3.25           6.21           3.73
Margin (of revenue after VAT)  ||            -2%            18%            39%            75%            45%
```

- **Haiku 4.5** is due to retire in mid-October 2026; Haiku 5.5 is announced without a price yet, so the Haiku column stands in for it.
- **GLM-5.3-Flash and Kimi K2.6** are open models on Cloudflare's Workers AI, both able to read images, with published cache prices. They are the cheaper option for later, if they pass the evals; Workers AI can't yet keep processing in the EU.
- **An EU-only route** costs about 10% more for Claude (Bedrock's or Vertex's EU endpoints), or moves to an EU host for open models (Mistral's EU endpoint, Scaleway, OVHcloud).
- Every column assumes the same token counts and calls per message. Tokenizers differ, and the open models' tool calling is unproven, so the evals decide.

Sonnet 5.5 may do better than its column: reports say it needs up to 30% fewer tokens per task, which would lift its margin at $9.99 to about 23%. It may also do worse: its newer tokenizer turns the same text into about 30% more tokens than Haiku 4.5's. The evals should measure real token counts.

The sandbox, platform and storage lines were estimated for AWS; Cloudflare's list prices for containers are lower, so they are an upper bound until the spike measures real usage.

Tokens are about 80% of all costs. The levers, in order: shorter chats, better cache hits, fewer calls per message, a cheaper model, and the price.

TestFlight and the invite-only beta run with no usage limit, under a fair-use clause. Before the public launch, add a hidden daily cap of about 200 messages per user and a spend limit on the Anthropic account.

## Scope

**At launch:**

- Chat with tool steps, a stop button, and runs that finish with the app closed
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
- Steering and queueing messages while the agent works
- Push notifications
- The camera and a document scanner
- Budget alerts and a monthly review
- App help pages
- Shared ledgers: invite links that add a `members` row, roles, Family Sharing on the subscription
- Widgets and Siri
- Live page updates across devices, pushed by the Ledger over WebSockets
- Long chats with summarization, plus a separate `ui_messages` display copy

**Later, in the tech, when needed:**

- Starting the sandbox when a chat opens
- Pages for every version on a separate `pages` branch of the repo, for a History screen and charts over time
- Saving after every write, so each commit belongs to one chat (for shared ledgers)
- A path allowlist on saves
- A `pdftotext` path for cheaper statements
- Different models for different tasks
- A monthly limit or per-dollar metering
- A separate Cloudflare account for prod
- An EU-only model route: Claude on Bedrock's or Vertex's EU endpoints, or an open model on an EU host
- An open model on Workers AI (GLM-5.3-Flash, Kimi K2.6) if it passes the evals, with a text-extraction or page-image step for PDFs
- A checker container that never runs model code and checks every save again (with shared ledgers)
- The agent loop in a Durable Object (Cloudflare Agents SDK) instead of LangSmith, which would also remove the service secret and run tokens

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Switching from pi to deepagents is the biggest risk.** The prompt was tuned on pi, so build the eval set and record pi's baseline first.
- **Cloudflare's new container setup and Sandbox SDK 1.0 are previews.** The `durable_object` scheduling policy launched on 30 September 2026, Sandbox SDK 1.0 is on its `@next` line, and the older Container and Sandbox classes get updates only until 31 December 2026. Build on the new API, pin the SDK and its image to the same version, and prove it in the Phase 0 spike.
- **Confirm with Cloudflare** that containers under the new setup, Artifacts and D1 all run in the EU jurisdiction (D1 holds all user records); container prices and limits; point-in-time recovery for Durable Object storage; and, for Artifacts, beta access on our account, that a sandbox outbound rule can reach a repo with an injected token, and whether force pushes can be refused.
- **Confirm with Anthropic and Cloudflare** Anthropic's data retention for API calls (ask for zero retention), the PDF size limit, that AI Gateway passes PDFs and images through unchanged with logging off, and Haiku 5.5's release and price.
- **Confirm with LangSmith** that the Serverless deployment is enough for the beta and runs in the EU. Dedicated, for launch, is a new deployment.
- **Pin versions.** deepagents ships almost weekly. hledger is pinned in the sandbox image; it's GPL, which is fine on servers but rules it out inside the iOS app. Pin the Workers compatibility date.
- **Run `execute` as a user that can't change our ledger program or hledger,** if the Sandbox SDK allows a separate user; check in the spike.
- **Deploys restart Durable Objects,** and a request in flight can fail. Make tool calls and saves safe to retry.
- **Receiving shared files needs an iOS share extension** (`expo-share-intent`). Budget a few days and test with statements shared from real bank apps.
- **assistant-ui React Native with the LangGraph runtime is undocumented.** Prototype it first, using `expo/fetch` for streaming.
- **LangSmith traces are full copies of users' books.** Sample them, keep retention short, and keep the workspace to one person.
- **Statements are the priciest messages.** A 10-page PDF is about 20–30k input tokens, so cap pages and size per upload.
- **Measure hledger on a ten-year ledger**, including the size of the Transactions page JSON.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that revokes the Apple token and reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with Cloudflare, Anthropic, LangSmith, RevenueCat, Sentry, PostHog; a DPIA; check where RevenueCat keeps data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger and git run; git hooks off on saves; page data checked before it is stored.
- **Cost control:** hidden daily cap per user, cap on model calls per run, cache-friendly prompt order (context block last), Cloudflare usage notifications, a spend limit on the Anthropic account, and a switch that pauses new runs.
- **Operations:** a tested restore, from git history and from a snapshot fork; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL).

## Build order

| Phase                 | Time        | Work                                                                                                                                                                                                                                                                                                                                                                                         | Done when                                                                                                                       |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 0 · Groundwork        | ≈ 2 weeks   | Eval set and pi baseline; delete desktop, website, docs, demos from the fork; ledger code as a command-line program; Cloudflare dev environment; a spike: one Ledger object with a sandbox in the EU jurisdiction, cloning from and pushing to an Artifacts repo through the outbound rule; run the evals on Sonnet and Haiku, with GLM-5.3-Flash and Kimi K2.6 on Workers AI for comparison | Ledger program tests pass, `wrangler deploy` works in dev, the spike's first-tool and save times and the baseline numbers exist |
| 1 · Cloud agent       | ≈ 3–4 weeks | API Worker and Ledger object (tools, saves with checks, pages); Auth Worker and the D1 tables; sandbox image, connector; deepagents graph on LangSmith with ledger tools                                                                                                                                                                                                                     | Evals match pi, concurrent saves never lose a change, cross-user tests pass                                                     |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, share extension, Transactions, Net worth, delete account                                                                                                                                                                                                                                                                                                         | You keep your own books on the phone for two weeks                                                                              |
| 3 · Launch            | ≈ 2–3 weeks | Dedicated LangSmith deployment, payments and export as planned above, the daily cap in D1, consent screen, privacy label, legal entity, App Review, prod environment                                                                                                                                                                                                                         | Live, first renewal goes through                                                                                                |

## Decisions for you

1. **Sonnet 5.5 or Haiku?** One Claude model for everything at launch. With EU VAT, Sonnet 5.5 loses a little at $9.99 (−2%); Haiku (39%) or $12.99 (18%) fixes it, if Haiku passes the evals against the pi baseline. Haiku 4.5 retires in mid-October 2026, so this means Haiku 5.5 once it ships.
2. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

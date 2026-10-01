# Accountant24 Mobile Blueprint

How to turn the desktop agent into a paid, closed-source iPhone app on Cloudflare, with the model (on AWS Bedrock), compute and storage included.

## The short version

Keep the ledger logic, the prompt and hledger. Store the books as git in R2, give each ledger one Durable Object that owns it and runs its saves one at a time, run every tool in a sandbox per chat, serve pages computed at save time, and keep it all in Cloudflare's EU jurisdiction. The model stays on Bedrock in the EU.

| Area              | Pick                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Cloud             | Cloudflare (Workers, Durable Objects, Containers, R2, D1) in the EU jurisdiction, defined in wrangler config; AWS only for Bedrock |
| Books             | A git repo per ledger, one bundle file per version in R2; the ledger's Durable Object points to the current one                    |
| Server            | Two Workers: API (tools, saves, pages, webhooks) and Auth (sign-in and tokens)                                                     |
| State             | One Durable Object per ledger; D1 for users, sign-in, members, plans and limits                                                    |
| Agent             | deepagents (TypeScript) on LangSmith, EU: Serverless for the beta, Dedicated from launch                                           |
| Sandboxes         | Cloudflare Containers owned by the ledger's Durable Object: one per chat, plus a checker from the same image                       |
| Model             | Claude on Bedrock (EU inference profile), one model as a server setting; Anthropic's API directly if EU residency stops mattering  |
| Accounting engine | hledger, one pinned version                                                                                                        |
| App               | Expo, assistant-ui (React Native + LangGraph runtime)                                                                              |
| Sign-in           | Sign in with Apple only, no auth vendor: the Auth Worker checks Apple's token and issues our own JWT                               |
| Payments          | RevenueCat on StoreKit 2                                                                                                           |

This repo is a closed fork; the open-source desktop app stays in its own repo. Keep the Apache-2.0 license and notice for the forked code.

## Architecture

The books are git, so the agent works on real files exactly as on the Mac, and history and undo are plain git. Each chat gets a throwaway sandbox with a clone; the sandbox never holds the only copy, and pages never need a sandbox awake. One Durable Object per ledger coordinates everything live about that ledger, so saves run one at a time without locks or conditional writes; plain records live in D1 tables.

```
+-----------------+     +-----------------------------------+ token +---------------+
| RevenueCat      |     | iOS APP (Expo, React Native)      | <---- | Sign in with  |
| StoreKit 2      |     | chat with tool steps              |       | Apple         |
+-----------------+     | Transactions, Net worth, export   |       +---------------+
         |              | photos, Files, share sheet        |
         | webhook      | paywall                           |
         |              +-----------------------------------+
         |                  |               |           |
         |                  | chat          |           |
         |                  v               |           |
         |    +--------------------------+  | pages,    | sign-in, refresh,
         |    | AGENT SERVER             |  | export,   | logout, delete
         |    | LangSmith, EU            |  | invites   |
         |    | deepagents, our JWT      |  |           |
         |    | chats, runs, traces      |  |           |
         |    +--------------------------+  |           |
         |        | prompts         |       |           |
         |        v                 |       |           |
         |  +---------------------+ | tool  |           |
         |  | Bedrock (AWS, EU)   | | calls |           |
         |  | Claude              | |       |           |
         |  +---------------------+ |       |           |
+--------|--------------------------|-------|-----------|----------------------------------------+
|        |                          |       |           |                                        |
|        v                          v       v           v                                        |
|  +-----------------------------------------------+  +----------------------------+             |
|  | API WORKER                                    |  | AUTH WORKER                |             |
|  | tools, saves, pages, export, invites,         |  | sign-in, refresh, logout,  |             |
|  | webhooks, the check before a run              |  | account deletion, JWKS     |             |
|  +----------------|----------------------------|-+  +---------------|------------+             |
|                   |                            |                    |                          |
|                   |                            |                    |                          |
|                   v                            v                    v                          |
|  +------------------------------------------+ +---------------------------------------------+  |
|  | LEDGER (Durable Object, one per ledger)  | | D1 (SQLite)                                 |  |
|  | current version, save queue,             | | users, identities, refresh_tokens,          |  |
|  | sandboxes, cached pages, save log        | | ledgers, members, plans, daily_runs,        |  |
|  +------------------------------------------+ | webhook_events                              |  |
|        |                |              |      +---------------------------------------------+  |
|        v                v              v                                                       |
| +--------------+ +--------------+ +-----------+                                                |
| | SANDBOX      | | CHECKER      | | R2        |                                                |
| | container,   | | same image,  | | bundle,   |                                                |
| | one per chat | | no AI code,  | | pages per |                                                |
| | no internet  | | hledger, git | | version   |                                                |
| +--------------+ +--------------+ +-----------+                                                |
+-- Cloudflare, EU jurisdiction; one container image (git, hledger, ledger CLI) -----------------+
```

### Storage

```
-- R2 bucket "a24-books" (EU jurisdiction)
ledgers/<ledger_id>/versions/<n>.bundle   -- the whole git repo at version n; written once, never changed
ledgers/<ledger_id>/versions/<n>/pages/   -- Transactions, Net worth and pickers as JSON for version n
                                          -- versions older than 30 days are deleted, never the current one

-- Ledger Durable Object, one per ledger, with its own SQLite
current version · save queue · running sandboxes · save log

-- D1 "a24" (EU jurisdiction)
users           user_id · created_at                                   -- our own ID, never a provider's
identities      provider · sub · user_id · refresh_token               -- unique (provider, sub); apple now, google later
refresh_tokens  token_hash · user_id · family_id · used · expires_at   -- hashes only; each works once
ledgers         ledger_id · owner_user_id · created_at                 -- one per user at first; shared ledgers later
members         ledger_id · user_id · role                             -- owner, editor, viewer; the owner's row at first
plans           user_id · plan · renews_at                             -- from RevenueCat, from public launch
daily_runs      user_id · day · count                                  -- hidden daily cap, from public launch
webhook_events  event_id · received_at                                 -- RevenueCat events already handled, from public launch
```

A git bundle is the whole repo, history included, in one file. It stays a few MB for years because uploads never go into git. The user ID is always our own, never Apple's, and user and ledger are separate IDs, so Google sign-in and shared ledgers need no data migration. Chats and traces live in LangSmith in the Netherlands; the model runs on Bedrock in the EU; everything else stays in Cloudflare's EU jurisdiction.

### Chat history

Each chat is a LangSmith thread with its messages, tool steps and images. The app lists a user's threads through a thin adapter, so moving off LangSmith later only changes that adapter.

Summarization is off, so a thread always keeps every message. When a chat nears 70% of the model's context, the app asks the user to start a new one, and `memory.md` carries the important facts over. Threads never expire, unlike traces, which last 14 days. Keep thread TTL off, and delete a user's threads when they delete a chat or their account.

## Example: logging a receipt

What happens when a user sends a photo of a receipt and asks the agent to record it. Time runs from top to bottom, and each arrow is one message between two parts of the system. r41 and r42 are versions of the user's books.

```
iPhone           Agent server          Sandbox              Ledger               Bedrock
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
  |                   |                   |<-- 7 read the repo --|                   |
  |                   |                   |                      | 8 checker checks, |
  |                   |                   |                      |   save r42 to R2  |
  |                   |<- 9 "saved r42" -------------------------|                   |
  |                   |-- 10 tool result ------------------------------------------->|
  |                   |<- 11 final reply --------------------------------------------|
  |<- 12 reply -------|                   |                      |                   |
```

1. The user sends a photo of a receipt with a short message.
2. The agent server sends the chat and the photo to Claude on Bedrock.
3. Claude answers with a tool call: add this transaction.
4. The agent server asks the API Worker to run that tool, and the API Worker passes it to the ledger's Durable Object.
5. It's the chat's first tool, so the Ledger starts a sandbox and copies the books into it (version r41).
6. In the sandbox, the tool writes the journal entry, checks the ledger with hledger, and commits it with git.
7. The Ledger reads the packed repo out of the sandbox. The sandbox can't send anything itself: it has no internet.
8. The checker, a second container that never runs model code, checks the repo again and computes the pages. The Ledger writes version r42 to R2 and points to it. This is the only moment the books change.
9. The Ledger tells the agent server the save worked.
10. The agent server gives the tool's result back to Claude.
11. Claude writes the final reply.
12. The phone shows the reply.

The phone sees each step as it happens, so the user watches the progress. When the phone sees "saved r42", open pages reload. If the phone disconnects, the run keeps going and the phone picks the stream back up.

## How it works

**Workers, the Ledger and D1.** Two Workers are the only doors in. Records live in D1, one SQLite database with normal tables. Live work on a ledger goes through its Durable Object: one small program per ledger with its own SQLite, which Cloudflare runs as exactly one copy, handles requests in order, and puts to sleep when idle. It exists because a ledger needs a save queue, running sandboxes and timers, which a table can't hold. The Ledger class lives in the API Worker; the Auth Worker reaches it through a binding.

| Part          | Called by                                                                                        | Does                                                                | Holds or reaches                                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth Worker   | the phone: Apple's token, a refresh token, or our JWT                                            | sign-in, refresh, logout, account deletion, the public keys (JWKS)  | the private signing key; D1 `users`, `identities`, `refresh_tokens`, `ledgers`, `members`; creates and deletes Ledger objects; a LangSmith key to delete threads |
| API Worker    | the phone with our JWT; the agent server with a service secret; RevenueCat with a webhook secret | pages, export, tools and saves, the check before a run, webhooks    | Ledger objects; D1 `members`, `plans`, `daily_runs`, `webhook_events`; the service and webhook secrets; Auth's public keys                                       |
| Ledger object | the API and Auth Workers                                                                         | the current version, saves one at a time, the chat sandboxes, pages | R2, the sandbox and checker containers, D1 `members`                                                                                                             |

Only the Ledger writes books to R2. Before a run, the agent server's custom auth asks the API Worker whether the user may run: D1 has the plan (from launch), the daily count and the membership. On every tool call the Ledger checks `members` in D1 that the user belongs to it, and only owners and editors can save.

**Sign-in.** The app signs in with `expo-apple-authentication`. The Auth Worker checks Apple's identity token against Apple's public keys and exchanges the authorization code for Apple's refresh token. It finds the user in `identities`, where `(provider, sub)` is unique, so two sign-ins at the same moment still create one user. A new user also gets rows in `users`, `ledgers` and `members` (as owner), and a Ledger object. Auth then issues a one-hour JWT and a refresh token (see Auth); the agent server's custom auth and the API Worker verify that JWT. Deleting the account revokes the Apple token (App Store rule 5.1.1(v)), cancels the refresh tokens, stops the sandboxes, deletes the ledgers the user owns with their R2 files and objects, their threads, and their rows.

**Identity.** The user ID comes only from our verified JWT, never from the request or the model. Every request names a ledger, and the Ledger serves it only if `members` lists that user for it; every storage path is built from that ledger ID. Cross-user tests in CI check that one user can't reach another's ledger. Each user has one ledger at first.

**The sandbox.** Opening a chat starts nothing. On the agent's first tool call, the Ledger starts a container for that chat from our image: hledger, git and the ledger program, with internet off. Cloudflare's median start is about 0.65 seconds; with copying the current bundle in and `git clone`, the first tool waits about 1–2 seconds. Later tools reuse the container; the Ledger stops it after 10 idle minutes. The sandbox is only a working copy, it holds no credentials, and a change counts only once the Ledger has saved it.

**Tools.** The agent loop runs on LangSmith, and every tool runs in the sandbox. Our deepagents connector turns the file tools and `execute` into three calls to the API Worker: run a command, upload a file, download a file. The API Worker forwards each to the Ledger, which runs it in the chat's container. Ledger tools are thin wrappers around the ledger program.

**Saving.** The Ledger saves; the sandbox never writes to R2. Saves for one ledger wait in the Ledger's queue and run one at a time.

1. `commit_and_push` asks the API Worker to save. The Ledger runs `git commit` and `git bundle create books.bundle --all` in the sandbox and reads the bundle out.
2. The checker (started if asleep) runs two checks. The current version's commit must be an ancestor of the new `main`. And `hledger check --strict` must pass. The sandbox already ran the same check, but it runs model-written code, so a container that never does checks again.
3. The checker runs the page commands on the new version.
4. The Ledger writes the bundle and the pages to R2 as version r42, then moves its pointer to r42. Moving the pointer is the save.
5. If another chat saved since this sandbox copied the books, the ancestry check fails and the save returns "the books changed in another chat". The Ledger copies the latest books into the sandbox, and the agent redoes its change.

Commits carry the chat and run IDs, so "undo the last change" reverts exactly that run with `git revert`. A daily alarm in the Ledger deletes versions older than 30 days, never the current one; restoring an older version is moving the pointer back.

**Documents.** Photos and PDFs go straight to Claude in the message; Claude reads PDFs natively. CSV and other text files go in as plain text. Files never reach the sandbox, and only the chat history keeps them.

**Skills.** Skills are instructions only: `SKILL.md` files in the books repo. The built-in ones ship with the app, and users can create their own in chat.

**Data changes.** D1 changes are numbered SQL files applied with `wrangler d1 migrations` on deploy. The Ledger's own small SQLite migrates itself: numbered steps run in its constructor inside `blockConcurrencyWhile`, before it handles any request, so the code only ever sees the current shape. An idle Ledger migrates when it next wakes, even months later, so shipped steps are never edited or removed; tests run them with `@cloudflare/vitest-pool-workers` over real SQLite. A change that must reach every Ledger at once walks the `ledgers` table and wakes each one. New, renamed or deleted object classes are declared in the wrangler config. Changes go in two releases, add first and remove later, so a rollback still works. Changes to the books themselves reuse the desktop workspace migrations, run by the checker.

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
- **Webhooks, from the public launch.** RevenueCat sends a secret header, and the webhook skips events already in `webhook_events`.

**Later, before the public launch or shared ledgers:**

- **A run token.** Before a run, the API Worker checks the user's JWT, plan, cap and membership, and returns a JWT bound to that user, ledger and chat for about an hour. Tool calls carry it, and the Ledger takes the user and ledger only from it, so a leaked service secret alone opens nothing.
- **Signed requests** from the agent server, with a timestamp, instead of the fixed secret, and a check against LangSmith's EU outbound IPs.
- **A routine for rotating the signing key.**
- **Apple's server-to-server notifications,** to catch users who disconnect the app from their Apple ID.
- **RevenueCat's signature check,** and reading the subscription from RevenueCat's API after each event.

## Pages

Pages are computed once per version, when the checker saves it, and stored in R2 next to the bundle. To serve a page, the API Worker checks the token, the Ledger checks membership and returns the pages of its current version, and the API Worker filters Transactions by date range. Pages always show the latest save, and no page ever starts a container.

| Page                 | hledger command                                         |
| -------------------- | ------------------------------------------------------- |
| Transactions         | `hledger print -O json`                                 |
| Net worth            | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers    | `hledger accounts`, `payees`, `tags`                    |

Export returns the current bundle as a git repo, or a zip the checker makes with `git archive`. Pages refetch when the chat reports a save and when the app returns to the foreground.

## Infrastructure as code

Everything on Cloudflare is declared in wrangler config in the repo, one `wrangler.jsonc` per Worker, with dev and prod environments. GitHub Actions deploys with `wrangler deploy` and a scoped API token. There is no network to set up.

| Piece       | What it declares                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API Worker  | routes; the Ledger object class; the R2 bucket; the D1 database and its migrations; the container image (sandbox and checker, `durable_object` scheduling, internet off); the service and webhook secrets                       |
| Auth Worker | routes; a binding to the Ledger class; the D1 database; the private signing key as a secret                                                                                                                                     |
| Storage     | the R2 bucket and D1 database in the EU jurisdiction                                                                                                                                                                            |
| AWS         | Bedrock model access, a Bedrock API key for LangSmith limited to the chosen model, and a budget alarm                                                                                                                           |

## Costs and unit economics

|                                            | Before launch                   | At launch                             |
| ------------------------------------------ | ------------------------------- | ------------------------------------- |
| LangSmith (agent server)                   | $39 (Serverless, beta included) | ≈ $430 (Dedicated)                    |
| Cloudflare (Workers Paid, objects, R2, D1) | ≈ $5                            | ≈ $20–60                              |
| Sandboxes (Containers, per use)            | usage                           | measure in the spike                  |
| RevenueCat, Expo, Sentry, PostHog          | $0                              | $0–50                                 |
| **Total**                                  | **≈ $45–50**                    | **≈ $450–550** + model + sandbox time |

The unit economics below are per subscriber per month. They assume 80 messages with 3 model calls each, 20k tokens of context per call with 75% served from cache, 800 output tokens per call, and 2,000 subscribers. Prices include 20% EU VAT; Apple takes 15% of the price after VAT; model prices are each model's EU route, 10–20% above its global or US price: Claude, Nova, Qwen and Kimi on Bedrock, GPT on OpenAI's EU API, Gemini on Vertex's EU endpoint. Qwen and Kimi have no prompt caching on Bedrock, so they pay full price for the whole context.

```
                               ||   Sonnet 5.5   Sonnet 5.5    Haiku 4.5  GPT-6.1 Sol   GPT-6 Luna Gemini Flash  Nova 2 Lite     Qwen3 VL    Kimi K2.5
                               ||        $9.99       $12.99        $9.99        $9.99        $9.99        $9.99        $9.99        $9.99        $9.99
===============================++=====================================================================================================================
income:subscription            ||         9.99        12.99         9.99         9.99         9.99         9.99         9.99         9.99         9.99
-------------------------------++---------------------------------------------------------------------------------------------------------------------
expenses:tax:vat               ||         1.67         2.17         1.67         1.67         1.67         1.67         1.67         1.67         1.67
expenses:store:commission      ||         1.25         1.62         1.25         1.25         1.25         1.25         1.25         1.25         1.25
expenses:llm:tokens            ||         7.52         7.52         3.76         7.13         0.38         2.48         1.57         3.87         4.49
expenses:sandbox               ||         0.06         0.06         0.06         0.06         0.06         0.06         0.06         0.06         0.06
expenses:revenuecat            ||         0.09         0.12         0.09         0.09         0.09         0.09         0.09         0.09         0.09
expenses:platform:shared       ||         0.24         0.24         0.24         0.24         0.24         0.24         0.24         0.24         0.24
expenses:storage               ||         0.01         0.01         0.01         0.01         0.01         0.01         0.01         0.01         0.01
-------------------------------++---------------------------------------------------------------------------------------------------------------------
                               ||        10.84        11.74         7.08        10.45         3.70         5.80         4.89         7.19         7.81
===============================++=====================================================================================================================
Net                            ||        -0.85         1.25         2.91        -0.46         6.29         4.19         5.10         2.80         2.18
Margin (of revenue after VAT)  ||         -10%          12%          35%          -6%          76%          50%          61%          34%          26%
```

The alternatives, all with image input for receipts:

- **GPT-6.1 Sol and GPT-6 Luna** run in the EU only through OpenAI's API (`eu.api.openai.com`), which needs sales approval, and images there need enhanced zero data retention. On Bedrock, GPT models are global only.
- **Gemini Flash** is Gemini 3.8 Flash on Vertex's EU endpoint, at an introductory price that doubles on 1 January 2027 (tokens $4.95, margin 21%).
- **Nova 2 Lite** is on Bedrock's EU profile, **Qwen3 VL** (235B) in Ireland, and **Kimi K2.5** in Stockholm.
- **Left out:** Sonnet 5 on the EU profile costs the same as the Sonnet 5.5 column. Opus 5.5 ($14.26 of tokens) and GPT-6 Astra ($37.62) lose money at these prices. Text-only models (gpt-oss, DeepSeek, MiniMax, GLM) can't read receipt photos. Haiku 5.5 has no price yet.
- Every column assumes the same token counts and calls per message. Tokenizers differ, and the cheaper models' tool calling is unproven, so the evals decide.

Sonnet 5.5 may do better than its column: reports say it needs up to 30% fewer tokens per task, which would lift its margin at $9.99 to about 17%. It may also do worse: its newer tokenizer turns the same text into about 30% more tokens than Haiku 4.5's. The evals should measure real token counts.

The sandbox, platform and storage lines were estimated for AWS; Cloudflare's list prices for containers are lower, so they are an upper bound until the spike measures real usage.

Tokens are about 80% of all costs. The levers, in order: shorter chats, better cache hits, fewer calls per message, a cheaper model, and the price.

TestFlight and the invite-only beta run with no usage limit, under a fair-use clause. Before the public launch, add a hidden daily cap of about 200 messages per user and the Bedrock budget alarm.

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
- Automatic rebase for parallel saves
- A path allowlist on saves
- A `pdftotext` path for cheaper statements
- Different models for different tasks
- A monthly limit or per-dollar metering
- A separate Cloudflare account for prod
- The agent loop in a Durable Object (Cloudflare Agents SDK) instead of LangSmith, which would also remove the service secret and run tokens

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Switching from pi to deepagents is the biggest risk.** The prompt was tuned on pi, so build the eval set and record pi's baseline first.
- **Cloudflare's new container setup is a public beta.** The `durable_object` scheduling policy launched on 30 September 2026, and the older Container and Sandbox classes get updates only until 31 December 2026. Build on the new API, and prove it in the Phase 0 spike.
- **Confirm with Cloudflare** that containers under the new setup, R2 and D1 all run in the EU jurisdiction (D1 holds all user records); container prices and limits; how files move in and out of a container and how large they may be; and point-in-time recovery for Durable Object storage.
- **Confirm with AWS** that Sonnet 5.5 and Haiku 4.5 are on the EU profile from Ireland, and Bedrock's size limit for PDFs.
- **Confirm with LangSmith** that the Serverless deployment is enough for the beta and runs in the EU. Dedicated, for launch, is a new deployment.
- **Pin versions.** deepagents ships almost weekly. hledger is pinned in the one image the sandbox and checker share; it's GPL, which is fine on servers but rules it out inside the iOS app. Pin the Workers compatibility date.
- **Every save starts or wakes the checker.** Measure save time in the spike; keep the checker warm while a ledger has active chats if it's slow.
- **Deploys restart Durable Objects,** and a request in flight can fail. Make tool calls and saves safe to retry.
- **Receiving shared files needs an iOS share extension** (`expo-share-intent`). Budget a few days and test with statements shared from real bank apps.
- **assistant-ui React Native with the LangGraph runtime is undocumented.** Prototype it first, using `expo/fetch` for streaming.
- **LangSmith traces are full copies of users' books.** Sample them, keep retention short, and keep the workspace to one person.
- **Statements are the priciest messages.** A 10-page PDF is about 20–30k input tokens, so cap pages and size per upload.
- **Measure hledger on a ten-year ledger**, including the size of the Transactions page JSON.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that revokes the Apple token and reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with Cloudflare, AWS, LangSmith, RevenueCat, Sentry, PostHog; a DPIA; check where RevenueCat keeps data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger and git run.
- **Cost control:** hidden daily cap per user, cap on model calls per run, cache-friendly prompt order (context block last), Cloudflare usage notifications, the Bedrock budget alarm, and a switch that pauses new runs.
- **Operations:** a tested restore by moving a ledger back to an older version; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL).

## Build order

| Phase                 | Time        | Work                                                                                                                                                                                                                                                         | Done when                                                                                                                       |
| --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 0 · Groundwork        | ≈ 2 weeks   | Eval set and pi baseline; delete desktop, website, docs, demos from the fork; ledger code as a command-line program; Cloudflare dev environment; a spike: one Ledger object with a sandbox and the checker in the EU jurisdiction; pick one model on Bedrock | Ledger program tests pass, `wrangler deploy` works in dev, the spike's first-tool and save times and the baseline numbers exist |
| 1 · Cloud agent       | ≈ 3–4 weeks | API Worker and Ledger object (tools, saves with checks, pages); Auth Worker and the D1 tables; sandbox image, connector; deepagents graph on LangSmith with ledger tools                                                                                     | Evals match pi, concurrent saves never lose a change, cross-user tests pass                                                     |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, share extension, Transactions, Net worth, export, delete account                                                                                                                                                                 | You keep your own books on the phone for two weeks                                                                              |
| 3 · Launch            | ≈ 2–3 weeks | Dedicated LangSmith deployment, plans and the daily cap in D1, RevenueCat and its webhook, paywall, consent screen, privacy label, legal entity, App Review, prod environment                                                                                | Live, first renewal goes through                                                                                                |

## Decisions for you

1. **Sonnet 5.5 or Haiku 4.5?** One model for everything at launch. With EU VAT, Sonnet 5.5 loses money at $9.99; Haiku 4.5 (35%) or $12.99 (12%) fixes it, if it passes the evals against the pi baseline.
2. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

# Accountant24 Mobile Blueprint

How to turn the desktop agent into a paid, closed-source iPhone app on AWS, with the model, compute and storage included.

## The short version

Keep the ledger logic, the prompt and hledger. Store the books as git in S3, run every tool in a sandbox per chat, read pages straight from the books, and run it all in one EU region of AWS.

| Area              | Pick                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cloud             | AWS, Ireland (eu-west-1), defined in CDK                                                                                          |
| Books             | A git repo per ledger, one bundle file in a versioned S3 bucket, replaced with a conditional write                                |
| Server            | The API service: three stateless Lambda functions (App API, Agent API, webhooks) from one container image with Node, git, hledger |
| Accounts          | DynamoDB: users, sign-in methods, ledgers and members from the beta; plans and the daily cap from the public launch               |
| Agent             | deepagents (TypeScript) on LangSmith, EU: Serverless for the beta, Dedicated from launch                                          |
| Sandboxes         | AgentCore Runtime, one session per chat, with a connector we write                                                                |
| Model             | Claude on Bedrock (EU inference profile), one model as a server setting; Anthropic's API directly if EU residency stops mattering |
| Accounting engine | hledger, one pinned version                                                                                                       |
| App               | Expo, assistant-ui (React Native + LangGraph runtime)                                                                             |
| Sign-in           | Sign in with Apple only, no auth vendor: the App API checks Apple's token and issues our own JWT                                  |
| Payments          | RevenueCat on StoreKit 2                                                                                                          |

This repo is a closed fork; the open-source desktop app stays in its own repo. Keep the Apache-2.0 license and notice for the forked code.

## Architecture

The books are git, so the agent works on real files exactly as on the Mac, and history and undo are plain git. Each chat gets a throwaway sandbox with a clone; the sandbox never holds the only copy, and pages never need a sandbox awake.

```
+------------------+ token +--------------------------------+            +-------------------+
| Sign in with     | ----> | iOS APP (Expo, React Native)   |            | RevenueCat        |
| Apple            |       | chat with tool steps           |            | StoreKit 2        |
+------------------+       | Transactions, Net worth        |            +-------------------+
                           | export                         |                       |
                           | photos, Files, share sheet     |                       |
                           | paywall                        |                       |
                           +--------------------------------+                       |
                                | chat                   | sign-in, pages,          |
                                v                        | export, account          |
   +---------------------------------+                   |                          |
   | AGENT SERVER, LangSmith, EU     |                   |                          |
   | custom auth: our JWT            |                   |                          |
   | deepagents: system.md, skills,  |                   |                          |
   |   memory.md                     |                   |                          |
   | ledger tools: thin wrappers     |                   |                          |
   | chats, runs, rejoin, traces     |                   |                          |
   +---------------------------------+                   |                          | webhook
         |                    |                          |                          |
 prompts |         tool calls |                          |                          |
+--------|--------------------|--------------------------|--------------------------|----------+
|        v                    v                          v                          v          |
| +---------------------+  +-----------------------+  +--------------------+  +--------------+ |
| | Bedrock, EU profile |  | AGENT API (Lambda)    |  | APP API (Lambda)   |  | WEBHOOKS     | |
| | Claude Sonnet 5.5   |  | runs tools in the     |  | sign-in: Apple     |  | (Lambda)     | |
| | or Haiku 4.5        |  |   sandbox             |  |   token to our JWT |  | RevenueCat,  | |
| +---------------------+  | saves: ancestor +     |  | pages: hledger     |  | from launch  | |
|                          |   hledger check       |  | export, invites    |  |              | |
|                          | run check: plan, cap  |  | account deletion   |  |              | |
|                          +-----------------------+  +--------------------+  +--------------+ |
|                             | tools   ^ bundle |              |                     |        |
|                             v         v        |              |                     |        |
|                 +--------------------------+   |              |                     |        |
|                 | SANDBOX (AgentCore)      |   |              |                     |        |
|                 | one microVM per chat     |   |              |                     |        |
|                 | clone of the books       |   |              |                     |        |
|                 | hledger, git, ledger CLI |   |              |                     |        |
|                 | no internet, no keys     |   |              |                     |        |
|                 | stops after 10 idle min  |   +--------------+-------+             |        |
|                 +--------------------------+         |                |             |        |
|                                                      v                v             v        |
|                                              +------------------+  +-----------------------+ |
|                                              | S3, versioned    |  | DynamoDB              | |
|                                              | books.bundle     |  | users, ledgers,       | |
|                                              | per ledger       |  | members; later:       | |
|                                              |                  |  | plans, daily_runs     | |
|                                              +------------------+  +-----------------------+ |
+-- AWS, eu-west-1 (Ireland), in CDK; the three APIs share one image (Node, git, hledger) -----+
```

### Storage

```
-- S3 bucket "a24-books" (eu-west-1, versioning on)
ledgers/<ledger_id>/books.bundle   -- the whole git repo at the latest commit
                                   -- metadata: commit=<sha>; replaced only with If-Match
                                   -- older versions expire 30 days after they are replaced

-- DynamoDB, on-demand
users           user_id · created_at                                   -- our own ID, never a provider's
identities      provider#sub · user_id · refresh_token                 -- one row per sign-in method: apple now, google later
ledgers         ledger_id · owner_user_id · created_at                 -- one per user at first; shared ledgers later
members         ledger_id · user_id · role                             -- owner, editor, viewer; the owner's row at first
plans           user_id · plan · renews_at                             -- from RevenueCat, from public launch
daily_runs      user_id · day · count                                  -- hidden daily cap, from public launch
refresh_tokens  token_hash · user_id · family_id · used · expires_at   -- hashes only; each works once
webhook_events  event_id · received_at                                 -- RevenueCat events already handled, from public launch
```

A git bundle is the whole repo, history included, in one file. It stays a few MB for years because uploads never go into git. Chats and traces live in LangSmith in the Netherlands; everything else stays in Ireland.

### Chat history

Each chat is a LangSmith thread with its messages, tool steps and images. The app lists a user's threads through a thin adapter, so moving off LangSmith later only changes that adapter.

Summarization is off, so a thread always keeps every message. When a chat nears 70% of the model's context, the app asks the user to start a new one, and `memory.md` carries the important facts over. Threads never expire, unlike traces, which last 14 days. Keep thread TTL off, and delete a user's threads when they delete a chat or their account.

## Example: logging a receipt

What happens when a user sends a photo of a receipt and asks the agent to record it. Time runs from top to bottom, and each arrow is one message between two parts of the system. r41 and r42 are versions of the user's books.

```
iPhone           Agent server          Sandbox              Agent API            Bedrock
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
  |                   |                   |                      | 8 check again,    |
  |                   |                   |                      |   save r42 to S3  |
  |                   |<- 9 "saved r42" -------------------------|                   |
  |                   |-- 10 tool result ------------------------------------------->|
  |                   |<- 11 final reply --------------------------------------------|
  |<- 12 reply -------|                   |                      |                   |
```

1. The user sends a photo of a receipt with a short message.
2. The agent server sends the chat and the photo to Claude on Bedrock.
3. Claude answers with a tool call: add this transaction.
4. The agent server asks the Agent API to run that tool.
5. It's the chat's first tool, so the Agent API starts a sandbox and copies the user's books into it (version r41).
6. In the sandbox, the tool writes the journal entry, checks the ledger with hledger, and commits it with git.
7. The Agent API reads the packed repo out of the sandbox. The sandbox can't send anything itself: the Agent API runs a command there that prints the file, and reads the output.
8. The Agent API checks it again and saves it to S3 as version r42. This is the only moment the books change.
9. The Agent API tells the agent server the save worked.
10. The agent server gives the tool's result back to Claude.
11. Claude writes the final reply.
12. The phone shows the reply.

The phone sees each step as it happens, so the user watches the progress. When the phone sees "saved r42", open pages reload. If the phone disconnects, the run keeps going and the phone picks the stream back up.

## How it works

**The API service.** Three stateless Lambda functions, built from one container image (Node, git, hledger) with a different entry point each. They are split by caller, so each gets only the access it needs, and each has its own function URL, timeout and concurrency limit, so a busy agent can't slow pages or sign-in. Each request works in its own temporary folder.

| Function  | Called by                              | Does                                                               | Access                                                                                                                                                       |
| --------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App API   | the phone, with our JWT                | sign-in, pages, export, invites, account deletion                  | DynamoDB `users`, `identities`, `ledgers`, `members`, `refresh_tokens` (read and write), `plans` (read); books in S3 (read, delete); the private signing key |
| Agent API | the agent server, with a service token | commands and files in the sandbox, saves, the check before a run   | AgentCore; books in S3 (read, conditional write); DynamoDB `members`, `ledgers`, `plans` (read), `daily_runs` (read and write)                               |
| Webhooks  | RevenueCat, with its webhook secret    | subscription changes                                               | DynamoDB `plans`, `webhook_events` (write)                                                                                                                   |

Only the Agent API writes books to S3. On every call it checks `members`: the user must belong to the ledger, and only owners and editors can save. Before a run starts, the agent server's custom auth asks the Agent API whether the user may run (a plan, from launch, and room under the daily cap). The Agent API never sees `identities`, where the Apple refresh tokens live, and can't sign JWTs, change members or delete accounts.

**Sign-in.** The app signs in with `expo-apple-authentication`. The App API checks Apple's identity token against Apple's public keys, exchanges the authorization code for a refresh token, stores it in `identities` against our own `user_id` (a new user also gets a `ledgers` row and an owner `members` row), and issues a one-hour JWT and a refresh token (see Auth); the agent server's custom auth verifies that JWT. Deleting the account revokes the Apple token (App Store rule 5.1.1(v)), cancels the refresh tokens, then deletes the ledgers they own, their threads and their rows.

**Identity.** The user ID comes only from our verified JWT, never from the request or the model. Every request names a ledger, and the server serves it only if `members` lists that user for it; every storage path is built from that ledger ID. Cross-user tests in CI check that one user can't reach another's ledger. Each user has one ledger at first, but user and ledger stay separate IDs so shared ledgers need no migration.

**The sandbox.** Opening a chat starts nothing. On the agent's first tool call, the Agent API starts a session on the new AgentCore Runtime (GA in Ireland since September 2026, starts in about 2 seconds) with our image: hledger, git and the ledger program. It copies the user's `books.bundle` in and runs `git clone`, so the first tool waits about 2–3 seconds. Later tools reuse the session until it stops after 10 idle minutes. The sandbox is only a working copy. It has no internet and no credentials, and a change counts only once the Agent API has saved it.

**Tools.** The agent loop runs on LangSmith, and every tool runs in the sandbox. Our deepagents connector turns the file tools and `execute` into three calls to the Agent API: run a command, upload a file, download a file. The Agent API runs them with `InvokeAgentRuntimeCommand` under its own AWS role, and retries a command that gets a 409 because the session is still starting or stopping. Ledger tools are thin wrappers around the ledger program.

**Saving.** The Agent API saves; the sandbox never writes to S3.

1. `commit_and_push` asks the Agent API to save. The Agent API runs `git commit` and `git bundle create books.bundle --all` in the sandbox.
2. It reads the bundle out with a second command that prints the file, and clones it into a temporary folder. Copying books in works the same way in reverse: the file goes in with a command.
3. It runs two checks. The last saved commit, stored as metadata on the S3 object, must be an ancestor of the new `main`. And `hledger check --strict` must pass. The sandbox already ran the same check, but it runs model-written code, so the server checks again.
4. It uploads the file to S3 with `If-Match` on the version the sandbox cloned, so the write fails if another chat saved first. S3 versioning keeps the previous bundle.
5. If the write fails, the save returns "the books changed in another chat". The Agent API copies the latest books into the sandbox, and the agent redoes its change.

Commits carry the chat and run IDs, so "undo the last change" reverts exactly that run with `git revert`.

**Documents.** Photos and PDFs go straight to Claude in the message; Claude reads PDFs natively. CSV and other text files go in as plain text. Files never reach the sandbox, and only the chat history keeps them.

**Skills.** Skills are instructions only: `SKILL.md` files in the books repo. The built-in ones ship with the app, and users can create their own in chat.

## Auth

Two rules carry most of the security: the model never picks the user or the ledger, and every token either expires soon or can be cancelled.

**From the start:**

- **Apple sign-in.** The app sends Apple the hash of a one-time nonce and sends the App API the nonce itself. The App API checks Apple's signature against Apple's public keys, the nonce, the issuer, our bundle ID as the audience, and the expiry.
- **Our tokens.** A login JWT that lasts one hour, and an opaque refresh token that lasts 90 days and works once. A JWT can't be taken back, so it stays short; the refresh token is checked against `refresh_tokens` on every use, so logout, deletion or a stolen phone cancels it. The app keeps the JWT in memory and the refresh token in the Keychain (`expo-secure-store`, this device only). A refresh token used twice cancels all of that user's refresh tokens.
- **One signing key pair (ES256).** The App API signs with the private key from Secrets Manager; the agent server and the Agent API get only the public key from the App API's JWKS, so they can check tokens but never make them. Every key has a `kid` from day one.
- **Audience.** Each JWT names the one service it's for, and every service rejects the others'.
- **The model never picks the user or the ledger.** Tools take them from the user the agent server's custom auth verified (`langgraph_auth_user`), never from tool arguments, so a document that tricks the model still can't reach another ledger.
- **Agent server to Agent API.** A long random service secret, kept in Secrets Manager and LangSmith's secrets, sent as a header.
- **No secrets in logs or traces.** Tokens never go into graph state, tool arguments or the sandbox, and LangSmith hides them from traces.
- **Webhooks, from the public launch.** RevenueCat sends a secret header, and the webhook skips events already in `webhook_events`.

**Later, before the public launch or shared ledgers:**

- **A run token.** Before a run, the Agent API checks the user's JWT, plan, cap and membership, and returns a JWT bound to that user, ledger and chat for about an hour. Tool calls carry it, and the Agent API takes the user and ledger only from it, so a leaked service secret alone opens nothing.
- **Signed requests** from the agent server, with a timestamp, instead of the fixed secret, and a check against LangSmith's EU outbound IPs.
- **The signing key in AWS KMS,** and a routine for rotating it.
- **Apple's server-to-server notifications,** to catch users who disconnect the app from their Apple ID.
- **RevenueCat's signature check,** and reading the subscription from RevenueCat's API after each event.

## Pages

To serve a page, the App API checks the token and the user's membership, downloads the ledger's `books.bundle` into a temporary folder, runs hledger, and parses the output with `ledger-json.ts`. There is no cache, so pages always show the latest save.

| Page                 | hledger command                                         |
| -------------------- | ------------------------------------------------------- |
| Transactions         | `hledger print -O json`, limited by date range          |
| Net worth            | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers    | `hledger accounts`, `payees`, `tags`                    |

Pages refetch when the chat reports a save and when the app returns to the foreground.

## Infrastructure as code

One CDK app in TypeScript and one AWS account with dev and prod stacks. GitHub Actions deploys over OIDC.

| Stack   | What it creates                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Network | VPC with private subnets for the sandboxes only; no NAT gateway, no endpoints (the API runs outside the VPC)                                                                                                             |
| Data    | Versioned books bucket with the 30-day rule and AWS default encryption (kept on stack delete); DynamoDB tables from the beta                                                                                             |
| Sandbox | Sandbox image in ECR, AgentCore Runtime (new runtime version, stable `aws-cdk-lib` constructs) in private subnets with no network access                                                                                 |
| API     | App API, Agent API and webhook Lambda functions from one container image in ECR, each with its own function URL, role, timeout and concurrency limit; JWT signing key in Secrets Manager; the AWS Budgets alarm on spend |

## Costs and unit economics

|                                          | Before launch                   | At launch                             |
| ---------------------------------------- | ------------------------------- | ------------------------------------- |
| LangSmith (agent server)                 | $39 (Serverless, beta included) | ≈ $430 (Dedicated)                    |
| AWS base (Lambda, logs)                  | ≈ $0–5                          | ≈ $20–60                              |
| S3, DynamoDB                             | ≈ $1                            | ≈ $5–20 at 10k users                  |
| Sandboxes (AgentCore, per second of use) | usage                           | ≈ $500–1,500 at 10k users             |
| RevenueCat, Expo, Sentry, PostHog        | $0                              | $0–50                                 |
| **Total**                                | **≈ $40–50**                    | **≈ $450–550** + model + sandbox time |

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
- Live page updates across devices
- Long chats with summarization, plus a separate `ui_messages` display copy

**Later, in the tech, when needed:**

- Page caching keyed by commit
- Starting the sandbox when a chat opens
- Automatic rebase for parallel saves
- A path allowlist on saves
- A `pdftotext` path for cheaper statements
- Different models for different tasks
- A monthly limit or per-dollar metering
- AWS credentials scoped to one user per request
- A separate prod account and our own KMS key
- Agent hosting on AgentCore instead of LangSmith

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Switching from pi to deepagents is the biggest risk.** The prompt was tuned on pi, so build the eval set and record pi's baseline first.
- **Pin versions.** deepagents ships almost weekly. hledger must be the same version in both images; it's GPL, which is fine on servers but rules it out inside the iOS app. Pin the new AgentCore runtime version.
- **Confirm with LangSmith** that the Serverless deployment is enough for the beta and runs in the EU. Dedicated, for launch, is a new deployment.
- **Confirm with AWS** that Sonnet 5.5 and Haiku 4.5 are on the EU profile from Ireland, AgentCore's prices and session quota (fallback: Daytona), AgentCore's size limits on command input and output, since bundles travel through them (fallback: read in chunks, or serve upload and download from the sandbox's `/invocations` endpoint), and Bedrock's size limit for PDFs.
- **Lambda cold starts may slow pages.** Measure them; add provisioned concurrency, or fall back to Fargate behind a load balancer.
- **Receiving shared files needs an iOS share extension** (`expo-share-intent`). Budget a few days and test with statements shared from real bank apps.
- **assistant-ui React Native with the LangGraph runtime is undocumented.** Prototype it first, using `expo/fetch` for streaming.
- **LangSmith traces are full copies of users' books.** Sample them, keep retention short, and keep the workspace to one person.
- **Statements are the priciest messages.** A 10-page PDF is about 20–30k input tokens, so cap pages and size per upload.
- **Measure hledger on a ten-year ledger**, and page Transactions by date range.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that revokes the Apple token and reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with AWS, LangSmith, RevenueCat, Sentry, PostHog; a DPIA; check where RevenueCat keeps data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger and git run.
- **Cost control:** hidden daily cap per user, cap on model calls per run, cache-friendly prompt order (context block last), Budgets alarms and a switch that pauses new runs.
- **Operations:** a tested restore from an older S3 version; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL).

## Build order

| Phase                 | Time        | Work                                                                                                                                                                                      | Done when                                                                    |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0 · Groundwork        | ≈ 2 weeks   | Eval set and pi baseline; delete desktop, website, docs, demos from the fork; ledger code as a command-line program; AWS account and CDK Network and Data stacks; pick one model on Bedrock | Ledger program tests pass, `cdk deploy` works in dev, baseline numbers exist |
| 1 · Cloud agent       | ≈ 3–4 weeks | Agent API (tools, saves with checks), App API (sign-in, pages); sandbox image, AgentCore, connector; deepagents graph on LangSmith with ledger tools                                                 | Evals match pi, concurrent saves never lose a change, cross-user tests pass  |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, share extension, Transactions, Net worth, export, delete account                                                                                                         | You keep your own books on the phone for two weeks                           |
| 3 · Launch            | ≈ 2–3 weeks | Dedicated LangSmith deployment, DynamoDB with plans and the daily cap, RevenueCat and its webhook, paywall, consent screen, privacy label, legal entity, App Review, prod stacks                                                                                      | Live, first renewal goes through                                             |

## Decisions for you

1. **Sonnet 5.5 or Haiku 4.5?** One model for everything at launch. With EU VAT, Sonnet 5.5 loses money at $9.99; Haiku 4.5 (35%) or $12.99 (12%) fixes it, if it passes the evals against the pi baseline.
2. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

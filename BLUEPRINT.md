# Accountant24 Mobile Blueprint

Forked from accountant24 v0.3.4 (13c2f44).

How to turn the desktop agent into a paid, closed-source iPhone app on AWS, with the model, compute and storage included.

## The short version

Keep the ledger logic, the prompt and hledger. Store the books as git in S3, run every tool in a sandbox per chat, read pages straight from the books, and run it all in one EU region of AWS.

| Area              | Pick                                                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Cloud             | AWS, Ireland (eu-west-1), defined in CDK                                                                                          |
| Books             | A git repo per user, one bundle file in a versioned S3 bucket, replaced with a conditional write                                  |
| Server            | One stateless API function on Lambda (container image: Node, git, hledger)                                                        |
| Accounts          | None for the beta (Clerk lists users); DynamoDB from the public launch                                                            |
| Agent             | deepagents (TypeScript) on LangSmith, EU: Serverless for the beta, Dedicated from launch                                          |
| Sandboxes         | AgentCore Runtime, one session per chat, with a connector we write                                                                |
| Model             | Claude on Bedrock (EU inference profile), one model as a server setting; Anthropic's API directly if EU residency stops mattering |
| Accounting engine | hledger, one pinned version                                                                                                       |
| App               | Expo, assistant-ui (React Native + LangGraph runtime)                                                                             |
| Sign-in           | Clerk, Sign in with Apple only                                                                                                    |
| Payments          | RevenueCat on StoreKit 2                                                                                                          |

This repo is a closed fork; the open-source desktop app stays in its own repo. Keep the Apache-2.0 license and notice for the forked code.

## Architecture

The books are git, so the agent works on real files exactly as on the Mac, and history and undo are plain git. Each chat gets a throwaway sandbox with a clone; the sandbox never holds the only copy, and pages never need a sandbox awake.

```
+------------------+  JWT  +-------------------------------+
| Clerk            | ----> | iOS APP (Expo, React Native)  |
| Apple sign-in    |       | chat with tool steps          |
+------------------+       | Transactions, Net worth       |
                           | export                        |
                           | photos, Files, share sheet    |
                           | paywall                       |
                           +-------------------------------+
                               |                     |
                          chat |                     | pages, export,
                               |                     | account
                               v                     v
+-----------------------------------+         +-------------------------------------+
| AGENT SERVER                      |         | AWS, eu-west-1 (Ireland), in CDK    |
| LangSmith Deployment, EU          |         |                                     |
|                                   |  tool   | API service, sandboxes, S3,         |
| custom auth: Clerk token          |  calls, | DynamoDB, Bedrock                   |
| deepagents graph: system.md,      |  run    |                                     |
|   skills, memory.md               |  done,  | (see the next diagram)              |
| ledger tools: thin wrappers       |  prompts|                                     |
| chats, runs, rejoin, cron, traces | ------> |                                     |
+-----------------------------------+         +-------------------------------------+
                                                  ^
                                          webhook |
                                                  |
                                        +------------------+
                                        | RevenueCat       |
                                        | StoreKit 2       |
                                        +------------------+
```

```
+-------------------------------------------------------------------------------------+
| AWS, eu-west-1 (Ireland), defined in CDK                                            |
|                                                                                     |
|   from the phone and the agent server                                               |
|              |                                                                      |
|              v                                                                      |
|   +------------------------+              +-----------------------------+           |
|   | Lambda function URL    |              | Bedrock, EU inference       |           |
|   +------------------------+              | profile: Claude Sonnet 5.5, |           |
|              |                            | Haiku 4.5                   |           |
|              v                            +-----------------------------+           |
|   +---------------------------+                  ^  prompts from the agent server   |
|   | API SERVICE (Lambda)      |                                                     |
|   | container image, no state |   run commands   +-----------------------------+    |
|   | Node + git + hledger      | ---------------> | SANDBOX SESSION             |    |
|   | save checks               |                  | AgentCore Runtime           |    |
|   | pages: hledger on HEAD    |   books.bundle   | one microVM per chat        |    |
|   | accounts, webhooks        | <--------------> | clone of the books          |    |
|   | drives the sandboxes      |   in and out     | hledger, git                |    |
|   +---------------------------+                  | stops after 10 idle min     |    |
|         |               |                        | no internet access          |    |
|         |               |                        +-----------------------------+    |
|         v               v                                                           |
|   +--------------+  +--------------+                                                |
|   | S3           |  | DynamoDB     |                                                |
|   | versioned    |  | from launch: |                                                |
|   | books.bundle |  | plan, daily  |                                                |
|   | per user     |  |              |                                                |
|   +--------------+  +--------------+                                                |
+-------------------------------------------------------------------------------------+
```

### Storage

```
-- S3 bucket "a24-books" (eu-west-1, versioning on)
users/<user_id>/books.bundle       -- the whole git repo at the latest commit
                                   -- metadata: commit=<sha>; replaced only with If-Match
                                   -- older versions expire 30 days after they are replaced

-- DynamoDB, on-demand, from the public launch; the free beta needs none (Clerk lists the users)
plans        user_id · plan · renews_at                  -- from RevenueCat
daily_runs   user_id · day · count                       -- hidden daily cap, from public launch
```

A git bundle is the whole repo, history included, in one file. It stays a few MB for years because uploads never go into git. Chats and traces live in LangSmith in the Netherlands; everything else stays in Ireland.

### Chat history

Each chat is a LangSmith thread with its messages, tool steps and images. The app lists a user's threads through a thin adapter, so moving off LangSmith later only changes that adapter.

Summarization is off, so a thread always keeps every message. When a chat nears 70% of the model's context, the app asks the user to start a new one, and `memory.md` carries the important facts over. Threads never expire, unlike traces, which last 14 days. Keep thread TTL off, and delete a user's threads when they delete a chat or their account.

## One turn, end to end

```
iPhone           Agent server          Sandbox              API service          Bedrock
  |                   |                   |                      |                   |
  | 1 run + receipt   |                   |                      |                   |
  |   photo --------->|                   |                      |                   |
  |                   |-- 2 prompt (cached prefix) + image ------------------------->|
  |                   |<- 3 add_transactions(...) -----------------------------------|
  |                   |-- 4 run the tool ----------------------->|                   |
  |                   |                   |<- 5 start sandbox ---|                   |
  |                   |                   |   + books.bundle r41 |                   |
  |                   |                   | 6 entry, check,      |                   |
  |                   |                   |   commit             |                   |
  |                   |                   |-- 7 books.bundle --->|                   |
  |                   |                   |  (full repo)         | 8 check,          |
  |                   |                   |                      |   save r42        |
  |                   |<- 9 saved r42 ---------------------------|                   |
  |                   |-- 10 tool result -> final reply ---------------------------->|
  |<- 11 stream steps |                   |                      |                   |
  |      + reply -----|                   |                      |                   |
```

Step 8 is the only save. When the phone sees "saved r42" in the stream, open pages refetch. If the phone disconnects, the run keeps going and the phone rejoins the stream.

## How it works

**Identity.** The user ID comes only from the verified Clerk token, never from the request or the model. Every storage path is built from it, and cross-user tests in CI check that one user can't reach another's data. Each user has one ledger, keyed by that ID.

**The sandbox.** Opening a chat starts nothing. On the agent's first tool call, the API service starts an AgentCore session with our image: hledger, git and the ledger program. It copies the user's `books.bundle` in and runs `git clone`, so the first tool waits about 2 seconds. Later tools reuse the session until it stops after 10 idle minutes. The sandbox is only a working copy. It has no internet and no credentials, and a change counts only once the API service has saved it.

**Tools.** The agent loop runs on LangSmith, and every tool runs in the sandbox. Our deepagents connector turns the file tools and `execute` into three API calls: run a command, upload a file, download a file. The API service runs them with `InvokeAgentRuntimeCommand` under its own AWS role. Ledger tools are thin wrappers around the ledger program.

**Saving.** The API service keeps no state; each request works in its own temporary folder.

1. `commit_and_push` commits in the sandbox, packs the whole repo with `git bundle create books.bundle --all`, and asks the API service to save.
2. The API service downloads that file and clones it into a temporary folder.
3. It runs two checks. The last saved commit, stored as metadata on the S3 object, must be an ancestor of the new `main`. And `hledger check --strict` must pass. The sandbox already ran the same check, but it runs model-written code, so the server checks again.
4. It uploads the file to S3 with `If-Match` on the version the sandbox cloned, so the write fails if another chat saved first. S3 versioning keeps the previous bundle.
5. If the write fails, the save returns "the books changed in another chat". The API service copies the latest books into the sandbox, and the agent redoes its change.

Commits carry the chat and run IDs, so "undo the last change" reverts exactly that run with `git revert`.

**Documents.** Photos and PDFs go straight to Claude in the message; Claude reads PDFs natively. CSV and other text files go in as plain text. Files never reach the sandbox, and only the chat history keeps them.

**Skills.** Skills are instructions only: `SKILL.md` files in the books repo. The built-in ones ship with the app, and users can create their own in chat.

## Pages

To serve a page, the API service checks the token, downloads the user's `books.bundle` into a temporary folder, runs hledger, and parses the output with `ledger-json.ts`. There is no cache, so pages always show the latest save.

| Page                 | hledger command                                         |
| -------------------- | ------------------------------------------------------- |
| Transactions         | `hledger print -O json`, limited by date range          |
| Net worth            | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers    | `hledger accounts`, `payees`, `tags`                    |

Pages refetch when the chat reports a save and when the app returns to the foreground.

## Infrastructure as code

One CDK app in TypeScript and one AWS account with dev and prod stacks. GitHub Actions deploys over OIDC.

| Stack   | What it creates                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| Network | VPC with private subnets for the sandboxes only; no NAT gateway, no endpoints (the API runs outside the VPC)               |
| Data    | Versioned books bucket with the 30-day rule and AWS default encryption (kept on stack delete); DynamoDB at launch          |
| Sandbox | Sandbox image in ECR, AgentCore Runtime in private subnets with no network access                                          |
| API     | Lambda function from a container image in ECR, function URL, execution role, and the AWS Budgets alarm on spend            |

## Costs and unit economics

|                                          | Before launch                   | At launch                             |
| ---------------------------------------- | ------------------------------- | ------------------------------------- |
| LangSmith (agent server)                 | $39 (Serverless, beta included) | ≈ $430 (Dedicated)                    |
| AWS base (Lambda, logs)                  | ≈ $0–5                          | ≈ $20–60                              |
| S3, DynamoDB                             | ≈ $1                            | ≈ $5–20 at 10k users                  |
| Sandboxes (AgentCore, per second of use) | usage                           | ≈ $500–1,500 at 10k users             |
| Clerk, RevenueCat, Expo, Sentry, PostHog | $0                              | $0–50                                 |
| **Total**                                | **≈ $40–50**                    | **≈ $450–550** + model + sandbox time |

The unit economics below are per subscriber per month. They assume 80 messages with 3 model calls each, 20k tokens of context per call with 75% served from cache, 800 output tokens per call, and 2,000 subscribers. Prices include 20% EU VAT; Apple takes 15% of the price after VAT; model prices are Bedrock EU, 10% above Anthropic's.

```
                               ||  Sonnet 5.5  Sonnet 5.5   Haiku 4.5
                               ||       $9.99      $12.99       $9.99
===============================++====================================
income:subscription            ||        9.99       12.99        9.99
-------------------------------++------------------------------------
expenses:tax:vat               ||        1.67        2.17        1.67
expenses:store:commission      ||        1.25        1.62        1.25
expenses:llm:tokens            ||        7.52        7.52        3.76
expenses:sandbox               ||        0.06        0.06        0.06
expenses:revenuecat            ||        0.09        0.12        0.09
expenses:platform:shared       ||        0.24        0.24        0.24
expenses:storage               ||        0.01        0.01        0.01
-------------------------------++------------------------------------
                               ||       10.84       11.74        7.08
===============================++====================================
Net                            ||       -0.85        1.25        2.91
Margin (of revenue after VAT)  ||        -10%         12%         35%
```

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
- Shared ledgers
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
- **Pin versions.** deepagents ships almost weekly. hledger must be the same version in both images; it's GPL, which is fine on servers but rules it out inside the iOS app. The AgentCore CDK constructs are still alpha.
- **Confirm with LangSmith** that the Serverless deployment is enough for the beta and runs in the EU. Dedicated, for launch, is a new deployment.
- **Confirm with AWS** that Sonnet 5.5 and Haiku 4.5 are on the EU profile from Ireland, AgentCore's prices and session quota (fallback: Daytona), and Bedrock's size limit for PDFs.
- **Lambda cold starts may slow pages.** Measure them; add provisioned concurrency, or fall back to Fargate behind a load balancer.
- **Receiving shared files needs an iOS share extension** (`expo-share-intent`). Budget a few days and test with statements shared from real bank apps.
- **assistant-ui React Native with the LangGraph runtime is undocumented.** Prototype it first, using `expo/fetch` for streaming.
- **LangSmith traces are full copies of users' books.** Sample them, keep retention short, and keep the workspace to one person.
- **Statements are the priciest messages.** A 10-page PDF is about 20–30k input tokens, so cap pages and size per upload.
- **Measure hledger on a ten-year ledger**, and page Transactions by date range.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with AWS, LangSmith, Clerk, RevenueCat, Sentry, PostHog; a DPIA; check where Clerk and RevenueCat keep data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger and git run.
- **Cost control:** hidden daily cap per user, cap on model calls per run, cache-friendly prompt order (context block last), Budgets alarms and a switch that pauses new runs.
- **Operations:** a tested restore from an older S3 version; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL).

## Build order

| Phase                 | Time        | Work                                                                                                                                                                                      | Done when                                                                    |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0 · Groundwork        | ≈ 2 weeks   | Eval set and pi baseline; delete desktop, website, docs, demos from the fork; ledger code as a command-line program; AWS account and CDK Network and Data stacks; pick one model on Bedrock | Ledger program tests pass, `cdk deploy` works in dev, baseline numbers exist |
| 1 · Cloud agent       | ≈ 3–4 weeks | API service (save with checks, pages); sandbox image, AgentCore, connector; deepagents graph on LangSmith with ledger tools                                                 | Evals match pi, concurrent saves never lose a change, cross-user tests pass  |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, share extension, Transactions, Net worth, export, delete account                                                                                                         | You keep your own books on the phone for two weeks                           |
| 3 · Launch            | ≈ 2–3 weeks | Dedicated LangSmith deployment, DynamoDB with plans and the daily cap, RevenueCat and its webhook, paywall, consent screen, privacy label, legal entity, App Review, prod stacks                                                                                      | Live, first renewal goes through                                             |

## Decisions for you

1. **Sonnet 5.5 or Haiku 4.5?** One model for everything at launch. With EU VAT, Sonnet 5.5 loses money at $9.99; Haiku 4.5 (35%) or $12.99 (12%) fixes it, if it passes the evals against the pi baseline.
2. **Clerk or Cognito?** Clerk is faster to build with; Cognito keeps sign-in on AWS, one vendor fewer.
3. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

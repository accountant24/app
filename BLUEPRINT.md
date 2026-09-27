# Accountant24 Mobile Blueprint

Draft 3 · 27 Sep 2026 · Forked from accountant24 v0.3.4 (13c2f44) · Vendor facts checked 25–27 Sep 2026

How to turn the local-first desktop agent into a paid, closed-source iPhone app on AWS, with the model, the compute and the storage included, and what to build first.

## Contents

- [The short version](#the-short-version)
- [What changed in draft 3](#what-changed-in-draft-3)
- [What the repo has today](#what-the-repo-has-today)
- [What carries over](#what-carries-over)
- [Where the books live](#where-the-books-live)
- [Target architecture](#target-architecture)
- [One turn, end to end](#one-turn-end-to-end)
- [How it works](#how-it-works)
- [Pages](#pages)
- [Infrastructure as code](#infrastructure-as-code)
- [Privacy](#privacy)
- [Choices by area](#choices-by-area)
- [Unit economics](#unit-economics)
- [Feature port map](#feature-port-map)
- [What else you need](#what-else-you-need)
- [Build order](#build-order)
- [Decisions for you](#decisions-for-you)
- [Sources](#sources)

## The short version

Keep the ledger logic, the prompt and hledger. Store the books as git in S3, run every tool in a sandbox per chat, read pages straight from the books, and put it all in one EU region of AWS.

- **Books live in** a git repo per ledger, stored in S3 as one bundle file. It is replaced only with a conditional write, so two saves can't overwrite each other. S3 versioning keeps every older version for 30 days.
- **The agent runs** as one shared deepagents server (TypeScript) on LangSmith, in the EU. It calls Claude on Bedrock through the EU inference profile, so the model stays in the EU too.
- **Sandboxes:** one AgentCore Runtime session per chat, its own microVM running our container with hledger and git. It clones the books when the chat opens and pushes when the agent saves. It has no internet access.
- **The server:** one stateless API service on ECS Fargate with Node, git and hledger. It serves the git remote, checks every push with hledger, builds pages, and drives the sandboxes. It keeps no user data between requests.
- **The app:** Expo (React Native) with Clerk sign-in, RevenueCat subscriptions, assistant-ui chat and Expo push notifications.
- **The money:** LLM tokens are the only cost that scales with use. On Sonnet 5 through Bedrock EU, $9.99 barely covers a typical user; $12.99 or a cheaper everyday model fixes it. Give each plan a monthly allowance either way.

| Area                 | Pick                                                                                                                        | Runner-up                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cloud                | AWS, one EU region (Ireland, eu-west-1), defined in CDK                                                                     | Frankfurt, if the older AgentCore Runtime is acceptable |
| Books                | A git repo per ledger, one bundle file in a versioned S3 bucket, replaced with a conditional write                          | CodeCommit, one repo per ledger                         |
| History              | Real git: the agent uses log, diff, show, revert                                                                            | Version list + our own tools                            |
| Server               | One API service on ECS Fargate (Node, git, hledger) behind a load balancer                                                  | Lambda with a container image                           |
| Accounts             | DynamoDB: users, ledgers, plan, usage, push tokens                                                                          | Aurora Serverless Postgres                              |
| Agent loop           | deepagents, TypeScript                                                                                                      | pi, as in the open-source app                           |
| Agent hosting        | LangSmith Deployment, Dedicated, EU                                                                                         | AgentCore Runtime hosting the graph                     |
| Sandboxes            | AgentCore Runtime, one session per chat, with a deepagents connector we write                                               | Daytona, with a ready-made connector                    |
| Accounting engine    | hledger, one pinned version in the sandbox and API images                                                                   | None; decided                                           |
| Statements, receipts | Photos to the model; text PDFs via pdftotext in the sandbox; never stored on their own                                      | OCR service                                             |
| Python packages      | CodeArtifact as a PyPI mirror inside the network                                                                            | An internet allowlist                                   |
| iOS app              | Expo SDK 57+, development builds                                                                                            | SwiftUI                                                 |
| Chat UI              | assistant-ui React Native + LangGraph runtime                                                                               | `@langchain/react` useStream                            |
| Sign-in              | Clerk: Apple and Google                                                                                                     | Cognito                                                 |
| Payments             | RevenueCat on StoreKit 2                                                                                                    | Superwall                                               |
| Model                | Chosen by evals: Claude Sonnet 5 and Haiku 4.5 on Bedrock (EU profile); DeepSeek V4.1 Flash if it passes and has an EU host | Anthropic API directly                                  |
| Background           | Runs finish on the server; the API service sends Expo pushes; EventBridge Scheduler for alerts                              | SNS mobile push                                         |

## What changed in draft 3

Draft 2 moved the design to git books, a sandbox per chat and pages straight from hledger, on Cloudflare. Draft 3 keeps that design and moves it to AWS.

| Area            | Draft 2 (Cloudflare)                                                   | Draft 3 (AWS)                                                                            |
| --------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Server          | A Worker for the API plus a Container for git and hledger              | One ECS Fargate service does both                                                        |
| Books           | Bundle in R2 with backup copies; Cloudflare Artifacts as the end state | Bundle in S3; S3 versioning keeps old versions. No separate end state.                   |
| Sandboxes       | Cloudflare Sandbox, internet limited to an allowlist                   | AgentCore Runtime sessions, driven by the API service, with no internet at all           |
| Accounts        | D1                                                                     | DynamoDB                                                                                 |
| Model           | Anthropic API; Bedrock only if data must stay in the EU                | Bedrock, EU inference profile                                                            |
| Python packages | PyPI through the internet allowlist                                    | CodeArtifact mirror inside the network                                                   |
| Isolation       | Paths built from the verified ID                                       | Also AWS-enforced: each request gets credentials that reach only its own ledger's folder |
| Infrastructure  | Wrangler config                                                        | CDK in TypeScript, separate dev and prod accounts                                        |

Kept from draft 2: sandboxes push their own chat branch and only the server moves `main`; the sandbox only knows the git URL and token the server gives it; uploads live in the chat only; pages read the books directly.

## What the repo has today

Under the chat UI, Accountant24 is a coding agent pointed at a folder. pi runs the loop, the accountant24 extension adds eight ledger tools, a context block rebuilt every turn and a guard around `memory.md`, and the rest is plain files plus a few CLI binaries. That design is why "a sandbox per chat" is the natural port: the tools keep working on real files.

```
+------------------------------+
| RENDERER                     |
| React UI, assistant-ui chat  |
| Transactions, Net worth      |
| Settings, Plugins            |
+------------------------------+
               |
               | IPC
               v
+------------------------------+
| ELECTRON MAIN                |       hledger -O json
| IPC handlers, ledger views   | ---------------------------+
| plugins, providers           |                            |
| workspace migrations         |                            v
+------------------------------+         +-------------------------------------------+
               |                         | WORKSPACE ~/.accountant24 (git repo)      |
               | fork                    | ledger/YYYY/MM.journal, files/YYYY/MM/    |
               v                         | memory.md, plugins/, sessions/*.jsonl     |
+------------------------------+         | auth.json, models.json, app-settings.json |
| AGENT HOST (utilityProcess)  |  r/w    |                                           |
| pi SDK, one session per chat | ------> |                                           |
| accountant24 extension       |         +-------------------------------------------+
| 8 ledger tools + bash, edit  |  spawn  +-------------------------------------------+
| memory guard hook            | ------> | VENDORED BINARIES                         |
+------------------------------+         | hledger, git, pdftotext, tesseract, uv    |
               |                         +-------------------------------------------+
               | HTTPS
               v
+------------------------------+
| LLM: the user's provider     |
| API key, OAuth plan, Ollama  |
+------------------------------+
```

Today everything runs on one Mac. The agent reaches your books only through the workspace folder and a handful of CLI binaries; the Transactions and Net Worth screens skip the agent and ask hledger directly.

- **Agent loop.** pi SDK 0.84.1 in one Electron utilityProcess, one session per chat, stored as JSONL under `sessions/`. Up to 8 live sessions; idle ones are disposed after 15 minutes.
- **Tools.** `query`, `add_transactions`, `bulk_edit_transactions`, `add_balance_assertions`, `add_prices`, `validate`, `extract_text`, `commit_and_push`, plus pi's own read, edit, write, bash, grep, find and ls. The prompt tells the agent to prefer the ledger tools and use bash only as a last resort.
- **Safety is enforced in code, not only in the prompt.** Every ledger write runs `hledger check --strict` over the whole ledger and restores the touched files byte for byte on failure. Writes are serialized. A hook blocks wholesale rewrites of `memory.md` and any bash access to it.
- **Git.** `commit_and_push` commits every change and already pushes to `origin` when a remote is set (`pi-extension/src/git/git.ts`).
- **Prompt.** `system.md` is 8.2 KB (about 2k tokens). Each turn appends the date, the docs folder, memory, and the full lists of accounts, payees and tags.
- **Screens skip the agent.** Transactions is `hledger print -O json` over the whole journal, filtered in the renderer. Net Worth is two `hledger bs -O json` runs, at cost and at market value (`desktop/src/main/ledger.ts`).
- **Documents.** `pdftotext` for text PDFs, `pdftocairo` plus `tesseract` for scans. Non-image attachments are saved under `files/YYYY/MM/` and linked with a `related_file` tag.
- **Plugins.** Agent Plugins format (`plugin.json` plus `skills/<name>/SKILL.md`), indexed from GitHub. The three official skills are instructions only. The one community plugin, `ynab-import`, ships a Python script run through the bundled uv.
- **Models.** Bring your own: API key, OAuth plan, or a local Ollama model.
- **Tests.** Unit, component, integration and Playwright e2e with a coverage ratchet. There are no LLM evals. The prompt rules came from observed behavior and nothing measures them yet, which matters as soon as the harness changes.

## What carries over

This repo becomes the closed-source app; the open-source desktop app stays where it is. The ledger code no longer has to keep working for the desktop, so it can be reshaped freely. The code carried over is Apache-2.0, which allows a closed product: keep its license and copyright notice.

| Piece                                                                                  | Where it lives                               | Fate    | In the app                                                                                                                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Journal writing, routing, bulk edit, query args, validation                            | `pi-extension/src/ledger`                    | Keep    | Moves out of the pi extension into a ledger program that runs in the sandbox. The deepagents tools pass their JSON to it.              |
| System prompt, tool descriptions, prompt guidelines                                    | `system-prompt/`, `tools/`                   | Keep    | Rename tools for deepagents. Drop the desktop-only lines (docs folder, `app-settings.json`) and the `related_file` and `files/` rules. |
| hledger JSON parsers for both screens                                                  | `desktop/src/main/ledger-json.ts`            | Keep    | Move into the API service; every page uses them.                                                                                       |
| Pure UI logic: amounts, date ranges, mentions, skill blocks, prompt ideas, chat titles | `renderer/lib`                               | Keep    | A package imported by React Native.                                                                                                    |
| Payload types                                                                          | `desktop/src/shared/types.ts`                | Keep    | Become the app API contract.                                                                                                           |
| Skills, plugin format                                                                  | `accountant24/skills`                        | Keep    | SKILL.md folders load as they are.                                                                                                     |
| `extract_text`                                                                         | `pi-extension/src/files`                     | Keep    | `pdftotext` in the sandbox for text PDFs. Photos and scans go to the model, so tesseract is dropped.                                   |
| `commit_and_push`                                                                      | `pi-extension/src/git`                       | Keep    | Pushes the chat's own branch to the API's git remote. Add one step: when a push is rejected, pull, rebase, re-check and push again.    |
| Chat runtime bridge, overflow recovery, compaction markers                             | `renderer/runtime`                           | Rewrite | Against the LangGraph stream. The harness handles compaction itself.                                                                   |
| Components (shadcn, Base UI, data grid)                                                | `renderer/components`                        | Rewrite | Native components; keep the designs and copy.                                                                                          |
| Electron main, preload, IPC, updater, window state                                     | `desktop/src/main`                           | Delete  | Not used.                                                                                                                              |
| Provider keys, OAuth, Ollama, model settings                                           | `llm-providers/`                             | Delete  | The subscription includes the model.                                                                                                   |
| Website, docs site, demos                                                              | `packages/website`, `docs/`, `packages/demo` | Delete  | They stay in the open-source repo.                                                                                                     |

## Where the books live

"Every user gets their own sandbox with their files" bundles two things: a place to _keep_ the files and a place to _run_ commands against them. They are used very differently. Books are read all the time (every page, reminder and export) and written a few times a day. This design keeps the books in git, stored in S3, and gives each chat a throwaway sandbox with a clone of them.

```
A. One sandbox per user (rejected)

   iPhone ---> API gateway + LLM proxy ---> LLM
                        |
                        | wake + stream
                        v
   +--------------------------------------------------------+
   | PER-USER SANDBOX VM (paused when idle)                 |
   |  pi agent loop  |  workspace disk  |  hledger, git, uv |
   |  (as today)     |  (the only copy) |  bash             |
   +--------------------------------------------------------+

   At rest:   a paused VM or disk snapshot per user
   App open:  resume the VM, then load the pi session
   Pages:     wake the VM for every read
   Risks:     the LLM proxy token sits next to bash


B. Shared agent, books in git (picked)

   iPhone ---> Agent server ---> LLM
                     |
                     | every tool call
                     v
              +-------------+  clone / push  +---------------------------------+
              | Sandbox     | -------------> | Books: git repo in S3,          |
              | per chat    |                | behind a stateless API service  |
              +-------------+                +---------------------------------+

   At rest:   one bundle file per ledger, cents a year
   App open:  sandbox starts and clones as the chat opens
   Pages:     hledger on the latest version, cached
```

|                            | A · pi inside a per-user VM         | B · agent outside, books in git, sandbox per chat                                                   |
| -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Books between chats        | VM disk                             | One git bundle file per ledger in S3                                                                |
| Pages, reminders, export   | Wake the VM                         | The API service runs hledger on the latest version                                                  |
| App open to first answer   | VM resume, then load the pi session | Sandbox starts and clones when the chat opens (about 2 s), usually before the first message is sent |
| Backups                    | Whatever the sandbox vendor keeps   | Yours: full git history in every bundle, and S3 versioning keeps each older version for 30 days     |
| Keys next to the shell     | LLM proxy token                     | Only a short-lived token for the ledger's own git remote                                            |
| Scripts and free-form bash | Yes                                 | Yes                                                                                                 |

**Cost doesn't decide this.** Sandbox time comes to cents per user per month, next to several dollars of tokens. What decides it is that in A the sandbox disk is the database: every page wakes a VM, the vendor's cleanup rules become your backup policy, and a process that runs model-written bash holds the only copy of someone's books.

**B keeps the books in git, in storage you control, and treats the sandbox as a scratch clone.** Every chat gets a sandbox and every tool runs in it, just like the desktop app works on a folder. The sandbox never holds the only copy of anything.

## Target architecture

Two places to deploy: the agent server on LangSmith, and the AWS stacks from one CDK app. The phone talks to the agent server only to chat; pages, history, export and account actions go to the API service, so they keep working when the agent server is busy or down.

The system from outside:

```
+------------------+  JWT  +-------------------------------+
| Clerk            | ----> | iOS APP (Expo, React Native)  |
| Apple and Google |       | chat with tool steps          |
+------------------+       | Transactions, Net worth       |
                           | History, undo, export         |
                           | camera, scanner, Files        |
                           | paywall, usage meter          |
                           +-------------------------------+
                               |                     |
                          chat |                     | pages, history,
                               |                     | export, account
                               v                     v
+-----------------------------------+         +-------------------------------------+
| AGENT SERVER                      |         | AWS, eu-west-1 (Ireland), in CDK    |
| LangSmith Deployment, EU          |         |                                     |
|                                   |  tool   | API service, sandboxes, S3,         |
| custom auth: Clerk token          |  calls, | DynamoDB, Bedrock, CodeArtifact     |
| deepagents graph: system.md,      |  run    |                                     |
|   skills, memory.md               |  done,  | (see the next diagram)              |
| ledger tools: thin wrappers       |  prompts|                                     |
| chats, runs, rejoin, cron, traces | ------> |                                     |
+-----------------------------------+         +-------------------------------------+
                                                  ^                     |
                                          webhook |                     | push
                                                  |                     v
                                        +------------------+  +------------------+
                                        | RevenueCat       |  | Expo Push, APNs  |
                                        | StoreKit 2       |  | run finished,    |
                                        +------------------+  | alerts           |
                                                              +------------------+
```

Inside AWS:

```
+-------------------------------------------------------------------------------------+
| AWS, eu-west-1 (Ireland), defined in CDK                                            |
|                                                                                     |
|   from the phone and the agent server                                               |
|              |                                                                      |
|              v                                                                      |
|   +------------------------+              +-----------------------------+           |
|   | Public load balancer   |              | Bedrock, EU inference       |           |
|   +------------------------+              | profile: Claude Sonnet 5,   |           |
|              |                            | Haiku 4.5                   |           |
|              v                            +-----------------------------+           |
|   +---------------------------+                  ^  prompts from the agent server   |
|   | API SERVICE (ECS Fargate) |                                                     |
|   | stateless, 2 small tasks  |   run commands   +-----------------------------+    |
|   | Node + git + hledger      | ---------------> | SANDBOX SESSION             |    |
|   | git remote, push checks   |                  | AgentCore Runtime           |    |
|   | pages: hledger on HEAD    |  git clone, push | one microVM per chat        |    |
|   | accounts, webhooks, push  | <--------------- | clone of the books          |    |
|   | drives the sandboxes      |  (internal load  | hledger, git, uv, pdftotext |    |
|   +---------------------------+   balancer)      | uploads/, never saved       |    |
|         |               |                        | no internet access          |    |
|         |               |                        +-----------------------------+    |
|         v               v                                      |                    |
|   +--------------+  +--------------+                           v                    |
|   | S3           |  | DynamoDB     |                 +------------------+           |
|   | versioned    |  | users,       |                 | CodeArtifact     |           |
|   | books.bundle |  | ledgers,     |                 | PyPI mirror      |           |
|   | per ledger   |  | plan, usage, |                 +------------------+           |
|   +--------------+  | push tokens  |                                                |
|                     +--------------+                                                |
+-------------------------------------------------------------------------------------+
```

### Rules the diagrams don't show

- **The sandbox is never the database.** It is a throwaway clone per chat, stopped after 10 idle minutes. A change counts only once the API service has saved it to S3.
- **Every save passes hledger twice.** In the sandbox, for fast feedback to the agent. Then in the API service before saving, because the sandbox runs model-written code. A failed check leaves the books untouched.
- **Saves are conditional.** Sandboxes push their own chat branch, and only the server moves `main`. A push is saved only if `books.bundle` is still the version the push was based on. Otherwise it is rejected, and the sandbox pulls, rebases, re-checks and pushes again. Undo is `git revert`.
- **The server keeps nothing.** Each request works in its own temporary folder, deleted afterwards. Any task can serve any ledger, so scaling means adding tasks.
- **Identity comes from the token.** The user and ledger ID come from the verified Clerk token or the sandbox's git token, never from the request body or the model.
- **AWS enforces the ledger boundary.** For each request, the API service takes temporary credentials that can reach only `ledgers/<id>/` in S3. A bug that picks the wrong ledger gets "access denied".
- **Keys never meet a shell.** The only credential in a sandbox is a short-lived token for its own ledger's git remote. Sandboxes have no internet, no AWS credentials and no model keys.
- **Uploads live in the chat only.** A receipt or statement travels inside the chat message and sits in the sandbox while the chat is open. Nothing stores it on its own.
- **Keyed by ledger, not by user.** Sign-up creates one personal ledger. Shared ledgers later only add a members list with roles.

### What lives where

| Data                                             | Where                                                                | Location                               |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------- |
| Journals, `memory.md`, skill files, full history | The ledger's git repo, one bundle file in S3                         | Ireland                                |
| Backups                                          | Older versions of the bundle, kept by S3 versioning for 30 days      | Ireland                                |
| Receipts, statements, other uploads              | Inside the chat message, and in the chat's sandbox until it stops    | Netherlands (chats), Ireland (sandbox) |
| Page results                                     | In memory in the API service, keyed by ledger and commit; disposable | Ireland                                |
| Chats (messages, tool steps, attachments)        | The LangSmith deployment's own Postgres                              | Netherlands                            |
| Users, ledgers, plan, usage, push tokens         | DynamoDB                                                             | Ireland                                |
| Model calls                                      | Bedrock, EU inference profile                                        | EU regions                             |
| Sign-in accounts                                 | Clerk; the Clerk user ID is the user ID everywhere                   | Clerk                                  |
| Agent traces                                     | LangSmith, sampled, short retention                                  | Netherlands                            |
| Each chat's working files                        | That chat's sandbox session, gone when it stops                      | Ireland                                |

```
-- S3 bucket "a24-books" (eu-west-1, versioning on)
ledgers/<ledger_id>/books.bundle   -- the whole git repo at the latest commit
                                   -- metadata: commit=<sha>; replaced only with If-Match
                                   -- older versions expire 30 days after they are replaced

-- DynamoDB, on-demand
users        id (Clerk) · created_at
ledgers      id · owner_id · created_at
members      ledger_id · user_id · role                  -- later: shared ledgers
plans        user_id · plan · allowance_usd · renews_at  -- from RevenueCat
usage        user_id · period · input_tokens · output_tokens · usd
push_tokens  user_id · token · device · updated_at
```

Without uploads in git, a ledger's repo stays a few MB for years, so cloning it into a sandbox or the API service takes well under a second inside the region.

### Services and monthly cost

| What              | Service                                                                                                    | Before launch  | At launch                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------- |
| Agent server      | LangSmith Deployment, EU. Free Serverless Small for development, Dedicated Small (3 CPUs, 6 GB) for launch | $39            | ≈ $430                                |
| AWS base          | A public and an internal load balancer, Fargate tasks (0.5 vCPU, 1 GB), private endpoints for the network  | ≈ $60–90       | ≈ $120–200                            |
| Storage, accounts | S3, DynamoDB on-demand, CodeArtifact                                                                       | ≈ $1           | ≈ $5–20 at 10k users                  |
| Sandboxes         | AgentCore Runtime, billed per second for the CPU actually used and memory                                  | usage          | ≈ $500–1,500 at 10k users             |
| Model             | Bedrock, EU inference profile, about 10% above Anthropic's list prices                                     | usage          | usage                                 |
| Sign-in           | Clerk, Apple and Google                                                                                    | $0             | $0 up to 50k monthly users            |
| Payments          | RevenueCat on App Store subscriptions                                                                      | $0             | 1% above $2,500 a month               |
| Push              | Expo push service                                                                                          | $0             | $0                                    |
| Errors, analytics | Sentry EU, PostHog EU                                                                                      | $0             | $0–26                                 |
| App builds        | Expo EAS                                                                                                   | $0             | $0–19                                 |
| **Total**         | Plus the Apple developer account, $99 a year                                                               | **≈ $100–130** | **≈ $600–700** + model + sandbox time |

The AWS figures are estimates to confirm in the AWS pricing calculator. Interface endpoints cost about $7 a month each per availability zone, so keep the list short; the S3 and DynamoDB endpoints are free. Sandbox time at 10k users assumes three chats a week per user, each open for about 15 minutes including the idle wait, with the CPU mostly waiting on the model.

## One turn, end to end

A photo of a receipt, taken in the app. The phone never talks to the model or to storage directly; it sends the message, and listens.

```
iPhone           Agent server          Sandbox              API service          Bedrock
  |                   |                   |                      |                   |
  | 1 chat opened ---------------------------------------------->|                   |
  |                   |                   |<--- 2 start sandbox -|                   |
  |                   |                   |-- 3 git clone r41 -->|                   |
  | 4 run + receipt   |                   |                      |                   |
  |   photo --------->|                   |                      |                   |
  |                   |-- 5 prompt (cached prefix) + image ------------------------->|
  |                   |<----------------------------------- 6 add_transactions(...) |
  |                   |-- 7 run the tool (via the API) ->|       |                   |
  |                   |                   | 8 entry, check,      |                   |
  |                   |                   |   commit             |                   |
  |                   |                   |-- 9 push chat ------>|                   |
  |                   |                   |   branch             | 10 check,         |
  |                   |                   |                      |    save r42       |
  |                   |<- 11 saved r42 ---|                      |                   |
  |                   |-- 12 tool result -> final reply ---------------------------->|
  |<- 13 stream steps |                   |                      |                   |
  |      + reply -----|                   |                      |                   |
  |                   |-- 14 run finished ---------------------->|                   |
  |<----------------------------------------- 15 push if the app is closed          |
```

The sandbox starts and clones when the chat opens, so it is ready by the time the message is sent. Step 10 is the only save, and it happens only after hledger accepts the whole ledger on the server. When the phone sees "saved r42" in the stream, open pages refetch. If the phone loses its connection, the run keeps going and the phone picks the stream back up.

What lands in `ledger/2026/09.journal` at r42. The photo stays in the chat, so there is no `related_file` tag:

```
; ledger/2026/09.journal  @ r42
2026-09-24 * Whole Foods
    ; original_payee_name: WHOLEFDS MKT 10234
    Assets:Bank:Chase                                               -45.00 USD
    Expenses:Food:Groceries                                          45.00 USD
```

- **Commits record where they came from.** Each commit message carries the chat and run as trailers (`Chat: 7f3c…`, `Run: 91a0…`), so "undo the last change" can revert exactly that run's commits.
- **One chat, one tool at a time.** Inside a chat, ledger tools run one by one, as `executionMode: "sequential"` does today. Across chats and devices, the conditional write keeps saves in order.

## How it works

One rule underneath everything: every chat works in its own sandbox, on a real clone of the ledger. The books themselves are the bundle in S3, and a change reaches them only after the API service's hledger check accepts it.

### What happens when a chat opens

As soon as the user opens a chat, the phone tells the API service, which starts an AgentCore Runtime session for it: a dedicated microVM running our sandbox image. The session gets one credential, a short-lived token for its own ledger's git remote, and clones the books (a few MB: journals, `memory.md`, skills) from the API service over the internal network. By the time the message is sent, the sandbox is usually ready.

The sandbox image has hledger, git, uv with Python, pdftotext, and the ledger code as a small command-line program. The session runs in private subnets with no route to the internet; it can reach only the API service and the CodeArtifact PyPI mirror.

After 10 idle minutes the session stops and its microVM is wiped. Nothing is lost: the next message starts a fresh one and clones again.

### How the tools work

The agent loop runs on the agent server, and every tool runs in the chat's sandbox. Our deepagents connector turns `read_file`, `edit_file`, `write_file`, `ls`, `grep`, `glob` and `execute` into three calls to the API service: run a command, upload a file, download a file. The API service runs them in the session with `InvokeAgentRuntimeCommand`, using its own AWS role, so the agent server holds no AWS credentials. The ledger tools (`add_transactions`, `query`, `bulk_edit_transactions`, …) are thin wrappers that pass their JSON to the ledger program in the sandbox.

### When changes become real

Changes in the sandbox are only a draft. The agent saves with `commit_and_push`, and the run saves once more when it ends, so nothing is left behind:

1. The sandbox commits and pushes its own branch (`chat/<chat_id>`) to the API service's git URL. The API service checks the git token, which can write only that branch.
2. The API service downloads `books.bundle` into a temporary folder and notes its ETag. It runs real git to receive the push.
3. Before accepting, a hook checks three things: the new commit builds on the current `main`, only workspace files changed, and `hledger check --strict` passes on the whole ledger. Only the server ever moves `main`.
4. It moves `main` to the new commit and writes the new bundle to S3 with `If-Match` on the ETag it noted, so the write succeeds only if nobody saved in the meantime. S3 versioning keeps the previous bundle. Only then does git tell the sandbox the push succeeded.
5. If another chat saved first, the push is rejected. The sandbox pulls, rebases, re-checks and pushes again. A real conflict (both chats edited the same lines) goes back to the agent.

History is plain git. The agent answers "what did you change today?" with `git log` and `git diff`, and "undo the last change" with `git revert`. The app's History page reads `git log` through the API service, and its undo button asks the API service to revert a commit through the same checks.

### Statements and receipts

An attachment travels inside the chat message, the way it does in the desktop chat today, so the chat history shows it. Photos and scans go to the model as images. For a PDF with a text layer, the agent server also uploads the file into the sandbox's `uploads/` folder, outside the git repo, and `extract_text` runs `pdftotext` on it: text costs a fraction of the tokens of page images.

Nothing stores the file on its own. It is never committed, and the sandbox copy disappears with the session. The trade-off: a user who wants the agent to look at an old statement again uploads it again.

### Python in skills

Every chat already has a sandbox, so scripts need nothing special. Take `ynab-import`: the user attaches a YNAB CSV, the skill tells the agent to run `uv run …/scripts/ynab_to_hledger.py`, uv pulls any packages from the CodeArtifact mirror, the script converts into a temporary folder, and the agent moves the new journal files into `ledger/`. The next push is checked by hledger and saved as one commit, so "undo the import" reverts exactly that.

### When the user asks for a new skill

The official `create-plugin` skill writes `plugins/<name>/plugin.json` and `…/skills/<name>/SKILL.md`, plus scripts if needed, into the sandbox. The push check also validates plugin manifests and rejects a broken one so the agent can fix it. Once saved, the skill is in the history, undoable, and in the export. deepagents keeps a chat's skill list in its state; a save that touches `plugins/` resets it.

### Programs in each image

| Program            | Sandbox image                  | API service image                                                |
| ------------------ | ------------------------------ | ---------------------------------------------------------------- |
| `hledger`          | Yes, for the agent's tools     | Yes, for push checks and pages. The same pinned version in both. |
| `git`              | Yes, to clone, commit and push | Yes, to receive pushes and read history                          |
| `pdftotext`        | Yes                            | No                                                               |
| `uv`, Python, bash | Yes                            | No                                                               |
| Ledger program     | Yes                            | No; the API service only needs hledger and the JSON parsers      |

## Pages

Every page reads the books directly. hledger runs on the latest version when a page is asked for, and the result is cached under that version, so there is no second copy of the books to keep in sync.

### What a page request does

1. The phone asks the API service for a page, for example transactions for September.
2. The API service checks the Clerk token, finds the ledger in DynamoDB, and reads the commit ID stored on `books.bundle` with a metadata request, not a download.
3. It looks in its in-memory cache under (ledger, commit, page, filters). A hit returns straight away.
4. On a miss, it downloads the bundle into a temporary folder, runs hledger, parses the output with the same code the desktop app uses (`ledger-json.ts`), caches the result and deletes the folder.

Every save makes a new commit, so a new save means a new cache key. Nothing ever has to be refreshed or invalidated, and a page can't show stale data. With several tasks, each keeps its own cache; a miss on one task costs one hledger run.

| Page                          | hledger command                                            |
| ----------------------------- | ---------------------------------------------------------- |
| Transactions, search, filters | `hledger print -O json`, limited by date range (`-b`/`-e`) |
| Net worth                     | `hledger bs -O json`, at cost and valued (`-V` or `-X`)    |
| Net worth over time           | `hledger bs -M -V --historical -O json`                    |
| Spending by category          | `hledger bal expenses -M --depth 2 -O json`                |
| `@` mentions, account pickers | `hledger accounts`, `payees`, `tags`                       |
| History                       | `git log` with the chat and run trailers                   |

A new page or chart is a new hledger command. Currency conversion and market prices always come from hledger, never from our own math.

> **Watch:** measure hledger on a synthetic ten-year ledger before launch, and page the Transactions list by date range rather than sending the whole register to the phone.

### Keeping pages current

- The chat stream carries the tool result "saved r42". When the phone sees it, open pages refetch, so Transactions updates before the reply finishes.
- When the app comes back to the foreground, it asks for the latest commit and refetches if it changed.
- Live updates across several devices can come later, for example with API Gateway WebSockets.

### Later: shared ledgers

Households, partners and accountants on one ledger are not part of launch. To keep adding them cheap, everything is keyed by a **ledger ID**, and sign-up creates one personal ledger per user. Sharing then fills the `members` table with roles (owner, editor, viewer) and checks it on every request. Conditional saves already work for several people at once.

## Infrastructure as code

One CDK app in TypeScript, in this repo. It synthesizes CloudFormation, so every deploy is a stack update with change sets and rollback, and the stacks can be tested with CDK's assertion library like the rest of the code.

| Stack   | What it creates                                                                                                                                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network | A VPC with public and private subnets and no NAT gateway. Free gateway endpoints for S3 and DynamoDB; interface endpoints only where needed (CodeArtifact, ECR, logs, Bedrock).               |
| Data    | The versioned books bucket with its 30-day rule for old versions, the DynamoDB tables, and a KMS key. Both are kept when the stack is deleted.                                                |
| Sandbox | The sandbox image in ECR, the AgentCore Runtime in the private subnets, and the CodeArtifact repository with a PyPI upstream.                                                                 |
| API     | The Fargate service behind a public load balancer, an internal load balancer for sandboxes, the task role, and the role it assumes per request with a session policy for one ledger's folder. |
| Jobs    | EventBridge Scheduler for budget alerts and the monthly review, and AWS Budgets alarms on spend.                                                                                              |

- **Accounts.** Separate AWS accounts for dev and prod. GitHub Actions deploys with OIDC, so no AWS keys are stored anywhere.
- **Per-user things are not infrastructure.** CDK creates the bucket, tables and runtime once. A ledger's folder and a chat's sandbox session are created by the app at runtime.
- **Also in CDK:** the Bedrock API key the agent server uses, limited to invoking the chosen models, and the Secrets Manager entries for Clerk, RevenueCat and Expo.

> **Watch:** AgentCore's CDK constructs are an alpha package whose API can change between releases, so pin the version. ECS Express Mode may not be in CDK yet; CDK's standard load-balanced Fargate service pattern does the same job.

## Privacy

Almost every consumer finance app serves all its users from shared servers. A shared server isn't the risk. The risks are a bug that mixes users up, a leak through logs, and too many people with access. Moving data around doesn't fix those; the practices below do.

### Practices, built in from phase 1

1. **Identity comes from a verified token only.** Never from the request body, a URL or the model. Every storage path, cache key, git remote and sandbox is built from that ID.
2. **AWS enforces the ledger boundary.** Each request's S3 access uses temporary credentials that reach only that ledger's folder, so a bug can't read another ledger even if it tries.
3. **No user data between requests.** The API service works in a fresh temporary folder per request and deletes it. Nothing user-specific sits in global variables apart from the page cache, which is keyed by ledger.
4. **Isolated, short-lived sandboxes.** Each chat's session is its own microVM, belongs to one ledger, has no internet and no AWS credentials, and is wiped after 10 idle minutes.
5. **Tests that try to break in.** Automated tests try to read another user's chats, pages, repo and sandbox. They must fail, and they run in CI on every change.
6. **Logs carry metadata, not content.** Sentry, PostHog, CloudWatch and server logs get IDs and error types, never transactions, statements or chat text. LangSmith traces are the exception, because they contain everything: sample them and keep retention short.
7. **Minimal staff access.** Only you can reach production data, with two-factor sign-in on every service. Anyone in the LangSmith workspace can read every user's chats, so keep that workspace to one person.
8. **Encryption in transit and at rest.** HTTPS everywhere; S3 and DynamoDB encrypted with the stack's KMS key.
9. **Keep only what's needed.** Uploads are never stored on their own, sandboxes and temporary folders disappear automatically, and old versions expire after 30 days. Deleting an account removes everything, including every version of the ledger's bundle, chats in LangSmith and the Clerk user.
10. **Tell users plainly.** A clear privacy policy, a list of the services that process their data, the AI consent screen, an export button, and for EU users a written risk assessment (DPIA).

### Stronger isolation, if needed later

| Option                                                                                 | Protects against                                       | Cost                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Encrypt each ledger's bundle with its own data key (KMS encryption context per ledger) | A leak of the storage itself                           | Moderate. Worth adding once there's revenue.               |
| A separate agent process per user                                                      | Memory bugs that cross users                           | High: slower and far more expensive. Rare outside banking. |
| Keep the data on the device                                                            | Everything on our side, because we never hold the data | That is the open-source desktop app.                       |

## Choices by area

One pick per area, the runner-up, and the thing most likely to bite.

### What runs the agent loop?

**Pick: deepagents in TypeScript (npm `deepagents` 1.14).** It has what the port needs, in the language the rest of the repo uses:

- **Sandbox backends.** Point deepagents at the chat's sandbox and its built-in ls, read, edit, write, glob, grep and execute tools all run there, on real files.
- **Agent Skills with progressive disclosure.** Your `SKILL.md` folders load as they are.
- **A memory file** loaded into the prompt and changed with `edit_file`, which is how `memory.md` already works. The memory guard becomes tool middleware.
- **Built in:** summarization at 85% of the context window, interrupts for "confirm before creating an account", and prompt caching with breakpoints after the static prompt and after memory.

What changes: tool names (`read_file`, `edit_file`, …), a base prompt wrapped around `system.md`, and the tool steps' labels in the UI. Behavior will shift, which is why the eval baseline comes first.

> **Watch:** this is the biggest risk in the plan, because the prompt and tools were tuned on pi. deepagents also ships almost weekly (1.14.1 on September 24): pin the version and run the evals on every bump.

### Where does the agent server run?

**Pick: LangSmith Deployment, Dedicated, in the EU region.** It supplies the parts you would otherwise build: chats and runs, background runs that survive the app closing, resumable streams (`stream_resumable: true`), double-texting modes for steering, cron jobs, custom auth that stamps an owner on every chat, run-finished webhooks, and traces and evals. assistant-ui's LangGraph runtime talks to it directly.

Since October 1, 2026 you pay for resources: Plus is $39 a seat, and a Dedicated S deployment (3 vCPU, 6 GiB, its own Postgres) works out to about $390 a month before autoscaling. Develop on the free Serverless S deployment, then create the Dedicated one for launch. You can't change a deployment's type or region after creating it.

Runner-up: host the graph on AgentCore Runtime too, which puts almost everything on AWS. Then chat storage (a LangGraph checkpointer in DynamoDB), stream rejoining, background runs and cron become your code. Worth revisiting once the app is live.

> **Watch:** traces are full copies of users' books, and anyone in your LangSmith workspace can read every user's chats. Sample traces and keep retention short. The TypeScript config docs leave out the `auth` key, so prove Clerk auth works on day one.

### Which AWS region?

**Pick: Ireland (eu-west-1), for everything.** The new AgentCore Runtime, generally available since September 2026, has 2-second cold starts and is offered in Ireland but not yet in Frankfurt. Sandboxes run in private subnets of the same VPC as the API service, so everything belongs in one region. Claude comes through Bedrock's EU inference profile, which keeps requests inside EU regions.

Runner-up: Frankfurt (eu-central-1), where only the older AgentCore Runtime runs, with cold starts of 5–30 seconds.

> **Watch:** confirm that the EU inference profile for Sonnet 5 can be called from Ireland before creating the stacks.

### Where do the books live?

**Pick: one git bundle file per ledger in a versioned S3 bucket, replaced with a conditional write.** A git bundle is a whole repo, history included, in one file. S3 supports conditional writes (`If-Match` on the object's ETag), so "save only if nobody else saved first" needs no locks and no database. Versioning keeps each replaced bundle, and a lifecycle rule deletes old versions 30 days after they are replaced.

- The sandbox sees a normal git remote, so `commit_and_push` works almost unchanged.
- One piece of code we own: the git endpoint in the API service. It is testable locally against a temp folder, has no quotas, and needs nothing created or deleted when a user signs up or leaves.
- Any task can serve any ledger; storage scales on its own.

Runner-up: CodeCommit, one managed repo per ledger. It removes the git endpoint but adds more around it: CodeCommit runs no checks before a push lands, so saving becomes a push plus a separate "promote" call; repos must be created and deleted with accounts; the default quota is 5,000 repos per region; and pricing is per active user. The sandbox only knows the git URL and token the server gives it, so switching later stays small.

> **Watch:** each save uploads the whole bundle. That is fine at a few MB, and it is why uploads stay out of git.

### Where does the API service run?

**Pick: ECS Fargate, one container image with Node, git and hledger.** On AWS one container can do everything: token checks, DynamoDB, RevenueCat and LangSmith webhooks, Expo pushes, the page cache, the git endpoint and driving the sandboxes. A public load balancer serves the phone and the agent server; an internal one serves the sandboxes, which have no internet. Run two small tasks for availability, in public subnets so no NAT gateway is needed. ECS Express Mode, which replaced App Runner, sets up the service, load balancer and scaling in one step.

Runner-up: Lambda with a container image. It scales to zero, but its 6 MB request limit is a poor fit for git pushes and its cold starts would slow pages.

> **Watch:** don't start on App Runner: it stopped taking new customers on April 30, 2026.

### Where do accounts live?

**Pick: DynamoDB, on-demand.** Users, ledgers, members, plan, usage and push tokens: small items read on almost every request, with no server to run and cents of cost at launch. Usage is metered after each model call and checked before each run.

Runner-up: Aurora Serverless Postgres, if you'd rather have SQL and a dashboard. It costs more at rest.

### Which accounting engine?

**Pick: hledger, one pinned version.** The same binary in the sandbox image and the API service image, so the agent's check and the server's check always agree. Rebuilding what hledger does (balancing, assertions, reports, market valuation) would mean owning the financial math.

License: hledger is GPL-3.0-or-later. Running it on your own servers and sandboxes isn't distribution, so it places no duty on your code, and calling the binary keeps your code separate. Don't ship it inside the iOS app. Confirm this in the pre-launch license review.

> **Watch:** the open-source desktop build takes whatever Homebrew has on release day. Pin the app's version explicitly in both Dockerfiles.

### How are statements and receipts read?

**Pick: photos to the model; text PDFs through pdftotext in the sandbox.** The file stays in the chat message and in the sandbox's `uploads/` folder, and is never committed or stored on its own.

> **Watch:** a ten-page statement sent as images is tens of thousands of input tokens. Prefer the text path when the PDF has text, cap file size and pages per upload, and count imports against the allowance.

### Where do sandboxes come from?

**Pick: AgentCore Runtime, one session per chat, with a deepagents connector we write.** Each session is its own microVM running our container image, and memory is wiped when it ends. `InvokeAgentRuntimeCommand` runs shell commands in the session and streams the output; the image's own HTTP handler takes file uploads and downloads. Sessions stop after an idle timeout (we set 10 minutes) and live up to 8 hours. Billing is per second for the CPU actually used and the memory, so the long waits for the model cost little.

**The connector we write.** A deepagents sandbox backend needs three operations: run a command, upload a file, download a file. The agent server calls the API service with its service token, and the API service calls AgentCore with its own role. Expect a few hundred lines plus tests, built in phase 1.

| Option                     | Our own image                                 | Internet control             | deepagents connector |
| -------------------------- | --------------------------------------------- | ---------------------------- | -------------------- |
| **AgentCore Runtime**      | Yes                                           | Private subnets, no internet | None; we write it    |
| AgentCore Code Interpreter | No; hledger would be installed on every start | Sandbox, public or VPC mode  | None                 |
| Daytona                    | Yes                                           | Block-all, 100 domains       | Python · TS          |
| E2B                        | Yes                                           | Deny-all, domain rules       | Python               |

Runner-up: Daytona, which has a ready-made TypeScript connector but runs outside AWS. deepagents talks to every sandbox through the same backend interface, so switching touches only the connector.

> **Watch:** AgentCore itself doesn't tie sessions to users; the API service keeps that mapping and caps sessions per user. Check AgentCore's current prices and concurrent-session quota before launch.

### How is the app built?

**Pick: Expo SDK 57+, Expo Router, development builds.** TypeScript end to end: the app imports the payload types and the pure helpers from `renderer/lib`, and Android later costs little code. Every native piece has a path: `expo-notifications`, `expo-widgets` (stable since SDK 56), `expo-share-intent` v8 for a real Share Extension, and a VisionKit document-scanner wrapper. EAS builds, submits and ships JavaScript-only fixes.

For chat, assistant-ui's React Native package pairs with its LangGraph runtime (`@assistant-ui/react-langgraph`), the same component model as the desktop app. React Native's own `fetch` can't stream response bodies, so pass `expo/fetch` or use the websocket transport. No one documents that combination yet, so prototype it first.

Runner-up: SwiftUI. You get Apple's scanner, share extensions, widgets and StoreKit screens with no bridge, and give up Android, a shared language, and a ready-made streaming chat UI.

> **Watch:** the scanner wrapper has an open crash on zero-page scans, and Expo's own share-receiving plugin is still experimental. Budget a day for each native module.

### How do people sign in?

**Pick: Clerk, with Sign in with Apple and Google.** Native Apple and Google sign-in through Clerk's Expo hooks or its native `<AuthView/>`. Free up to 50,000 monthly returning users, then $25 a month plus $0.02 per user. The agent server and the API service check Clerk tokens locally with Clerk's public key.

Runner-up: Cognito. It keeps sign-in on AWS and in the EU region, with Apple and Google supported, but its Expo integration and screens take more work. See Q2.

> **Watch:** Clerk tokens expire after about a minute, so the agent server calls the API service with its own service token plus the user ID, never with the user's token. Deleting an account must also delete the Clerk user and revoke the Sign in with Apple token.

### How do people pay?

**Pick: RevenueCat on StoreKit 2.** Subscriptions, receipt handling, a paywall builder with experiments, and webhooks to the API service, which sets each user's plan and allowance in DynamoDB. Free until $2,500 a month of tracked revenue, then 1%. In-App Currency covers top-up credits if you sell them. Apple takes 15% under the Small Business Program.

Runner-up: Superwall, if paywall experiments matter most. In the US storefront a link to web checkout carries no Apple commission today; Apple has proposed 15%, 10% on renewals and 5% for small businesses, so don't build the model around zero.

> **Watch:** new EU terms start October 1, 2026, and credits bought through in-app purchase may never expire.

### Which model, at what cost?

**Pick: Claude on Bedrock through the EU inference profile; the evals choose the model per task.** Sonnet 5 is the safe start, because the prompt was tuned on Claude. Bedrock keeps model calls inside EU regions under your AWS agreement, which settles the residency question Anthropic's own API couldn't. The EU profile costs about 10% more than Anthropic's list prices. The agent server calls Bedrock with a Bedrock API key limited to the chosen models.

| Model                        | Per message (3 calls, 20k context) | 80 messages a month | Notes                                      |
| ---------------------------- | ---------------------------------- | ------------------- | ------------------------------------------ |
| Claude Sonnet 5, Bedrock EU  | ≈ $0.094                           | ≈ $7.50             | Tuned prompt, reads images and PDFs        |
| Claude Haiku 4.5, Bedrock EU | ≈ $0.047                           | ≈ $3.75             | Titles, summaries, extraction              |
| DeepSeek V4.1 Flash, EU host | ≈ $0.01–0.03                       | ≈ $0.80–2.20        | Text only; check whether Bedrock serves it |

If DeepSeek passes the evals and has an EU host, a likely split is: DeepSeek for everyday chats (logging, questions, reports); a vision model for photos and scanned PDFs; Sonnet 5 for hard work (statement imports, bulk edits) and as a retry when the cheap model fails. The model is a server setting, changed without an app release.

> **Watch:** never use DeepSeek's own API: it processes data in China, which rules it out for bank statements. Only our evals decide which model runs what.

### What happens when the app closes?

**Pick: runs finish on the server; the API service sends a push.** The phone does no heavy work: iOS background tasks can be delayed and are never guaranteed. A run keeps going after the app closes. When it ends, LangSmith calls the API service, which sends a push through Expo using the tokens in DynamoDB. Opening the chat picks the stream back up or loads the finished answer. Later, EventBridge Scheduler triggers budget alerts and the monthly review the same way.

## Unit economics

The price has to come from token math. Everything else on the bill rounds to cents; the model does not.

**Assumptions:** 80 messages per subscriber a month, 3 model calls per message, 20k tokens of prompt and history per call with 75% served from cache, about 2k new input tokens per call, 800 output tokens per call, 120 sandbox minutes a month, 2,000 paying subscribers, 15% store commission.

**Prices used:** Sonnet 5 on Bedrock EU $2.20 in / $11 out per million tokens; Haiku 4.5 on Bedrock EU $1.10 / $5.50 (both include the EU profile's 10% premium). Cache reads cost 0.1× input, cache writes 1.25×. Shared costs about $620 a month (LangSmith seat and Dedicated Small deployment, the AWS base, Sentry, sampled traces). Sandbox time about $0.03 an hour. RevenueCat 1% above $2,500 of monthly revenue. Storage about a cent per user.

**Formula per model call:** `input_price × (prefix × (hit × 0.1 + (1 − hit) × 1.25) + 2,000 × 1.25) + output_price × output_tokens`

Per subscriber, one month:

```
                               ||  Sonnet 5  Sonnet 5  Haiku 4.5
                               ||     $9.99    $12.99      $9.99
===============================++==============================
income:subscription            ||      9.99     12.99       9.99
-------------------------------++------------------------------
expenses:store:commission      ||      1.50      1.95       1.50
expenses:llm:tokens            ||      7.52      7.52       3.76
expenses:sandbox               ||      0.06      0.06       0.06
expenses:revenuecat            ||      0.09      0.12       0.09
expenses:platform:shared       ||      0.31      0.31       0.31
expenses:storage               ||      0.01      0.01       0.01
-------------------------------++------------------------------
                               ||      9.49      9.97       5.73
===============================++==============================
Net                            ||      0.50      3.02       4.26
Margin                         ||        5%       23%        43%
```

A Sonnet 5 message costs about $0.094 in tokens, and tokens are about 80% of all costs. The levers, in order of effect: shorter chats, a better cache hit rate (one-hour cache writes survive a user's pause), fewer model calls per message, plain logging on a cheaper model, and the price.

## Feature port map

Every shipped desktop feature, where it goes on the phone, and when. Phases refer to the build order below.

| Desktop today                                                                   | On iPhone                                                                                                                   | When    |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------- |
| Chat with streaming, tool steps, thinking                                       | Same, with the friendly tool labels; tool steps collapse into one row                                                       | Launch  |
| Several chats running at once                                                   | Runs continue on the server with the app closed; rejoin the stream on return, push when done                                | Launch  |
| Steer while the agent works, queue, stop                                        | Same, mapped to the server's double-texting modes                                                                           | Launch  |
| Attach PDFs and images                                                          | Camera, document scanner, photo library, Files. Shown in the chat; not stored on their own                                  | Launch  |
| Drop a file from another app                                                    | Share sheet from a banking app straight into a new chat                                                                     | Phase 4 |
| `@` mentions of accounts, payees, tags                                          | Same, from the cached hledger lists                                                                                         | Launch  |
| `/` to run a skill                                                              | Skills sheet above the composer                                                                                             | Launch  |
| Prompt ideas on New Chat                                                        | Same                                                                                                                        | Launch  |
| Transactions page: search, filters, columns, CSV                                | List grouped by day, search, filter chips; CSV through the share sheet                                                      | Launch  |
| Net Worth page: cost and market value, assertions                               | Totals first, then accounts by section                                                                                      | Launch  |
| Memory, kept by the agent                                                       | A readable "What Accountant24 remembers" screen with delete                                                                 | Launch  |
| Git history, "undo the last change"                                             | Real git in the sandbox for the agent; a History screen from `git log`; an undo button that reverts through the same checks | Launch  |
| Workspace folder in the Finder                                                  | Export the books as a zip or a git repo                                                                                     | Launch  |
| Create your own skill in chat                                                   | Works unchanged, scripts included                                                                                           | Launch  |
| Plugin marketplace, plugin scripts through uv                                   | Install from Settings; scripts run in the chat's sandbox. See Q3                                                            | Launch  |
| Answers about the app from bundled docs                                         | Help pages written for the app, placed in the sandbox image                                                                 | Phase 4 |
| Provider, model and Ollama settings                                             | Removed; at most a "Standard / Thorough" switch                                                                             | Dropped |
| Analytics opt-out, About                                                        | Same, plus subscription, usage, export and delete account                                                                   | Launch  |
| _New:_ "Tell me when I get close to my food budget"                             | EventBridge Scheduler plus push                                                                                             | Phase 4 |
| _New:_ More pages and charts: spending by category, trends, net worth over time | One hledger command per chart, cached by commit                                                                             | Launch  |
| _New:_ Pages refresh the moment the agent saves                                 | The phone refetches when the chat reports a save                                                                            | Launch  |
| _New:_ Shared ledgers (household, partner, accountant)                          | Members with roles on one ledger                                                                                            | Later   |
| _New:_ Widgets, Siri "log a $5 coffee"                                          | `expo-widgets` (stable since SDK 56), App Intents                                                                           | Later   |

## What else you need

The parts of a paid consumer finance app that aren't architecture, but will block launch if they are missing.

### App Store

- An organization developer account. Guideline 5.1.1(ix) asks for a legal entity for finance apps, and 3.2.1(viii) invites questions about "money management"; be ready to explain the app keeps the user's own books and never moves money.
- Sign in with Apple next to Google (4.8).
- In-app account deletion that also reaches your processors, revokes the Apple token and points to subscription management (5.1.1(v)).
- A consent screen that names the AI provider before the first message or upload (5.1.2(i), November 2025).
- Restore purchases, plan terms on the paywall, a demo account for the reviewer.
- EAS Update for fixes only; new features go through review (2.5.2).

### Privacy and GDPR

- Privacy policy, terms, and processor agreements with every vendor: AWS, LangSmith, Clerk, RevenueCat, Expo, Sentry, PostHog.
- A data protection impact assessment: financial data plus AI processing is high risk under the EDPB criteria.
- Everything on AWS stays in the EU. LangSmith is in the Netherlands; check where Clerk, Expo push and RevenueCat hold data (Q2).
- Every model named in the privacy policy and the AI consent screen. Never DeepSeek's own API.
- Short trace retention in LangSmith. Traces are full copies of users' bank data.
- Privacy label: financial info, photos, user content, identifiers, purchases, all linked to the user.

### Security

- User and ledger IDs come from verified tokens only, and S3 access is scoped per ledger by AWS. Tests try to read another user's chats, pages, repo and sandbox.
- Treat uploaded statements and community plugins as hostile. A PDF can carry instructions and a script can misbehave; the server's push check is the guard, and the sandbox can reach only the API service and CodeArtifact.
- Keep hledger `include` directives inside the ledger's own tree (`resolveSafePath` already does this), in the sandbox and in the API service.
- Limits on attachment size, page count and file types.
- Timeouts and memory limits on every hledger and git run in the API service.

### Cost control

- A monthly allowance per user in dollars, checked before each run and metered after each model call.
- A cap on model calls per run and a fixed summarization threshold.
- Cache-friendly prompt order: static prompt and tools first, the per-turn context block last. Today the context block sits in the system prompt, so every new payee rewrites the cache from that point.
- A cheaper model for titles, summaries and extraction subtasks.
- AWS Budgets alarms, a daily spend alarm on Bedrock, and a switch that pauses new runs.

### Quality

- An eval set built from your own real conversations: logging, refunds, transfers, duplicates, imports, memory updates, bulk edits, net worth questions.
- Run it against today's pi agent in the open-source repo first to get a baseline, then against every prompt, model or harness change.
- A "this answer is wrong" button that links to the trace.

### Operations and brand

- All infrastructure in CDK, with separate dev and prod accounts and deploys from GitHub Actions over OIDC.
- Migrations with the same discipline as the desktop workspace migrations: ledger layout changes applied as a commit the first time a repo is opened after a release.
- A tested restore: bring a ledger back from an older S3 version before launch, not after.
- One pinned hledger version in the sandbox and API images.
- Sentry on app and server, CloudWatch for the AWS side, PostHog for product analytics.
- Remote config for model choice and allowances, without an app release.
- A license review of everything carried over: Apache-2.0 notices for the forked code, and hledger's GPL kept on the server side.
- Brand: the open-source app says "your data stays on your machine" and "works with any LLM". The paid app changes both; lead with "plain-text books you can export anytime".

## Build order

Each phase ends with something you can use, and the risky parts (agent quality, tenant isolation) are tested before any app UI exists.

### Phase 0 · about 2 weeks · Groundwork

- In the open-source repo: build the eval set and record the pi agent's baseline scores.
- In this fork: delete the desktop app, website, docs and demos. Move the ledger code out of the pi extension into a command-line program with its tests.
- Set up the dev and prod AWS accounts and the CDK app skeleton with the Network and Data stacks.
- Run the eval set on Sonnet 5 and Haiku 4.5 through Bedrock EU, and on DeepSeek V4.1 Flash if an EU host exists, to choose the default model and the per-task split.

**Done when** the ledger program passes its tests on its own, `cdk deploy` works in dev, and you have baseline numbers.

### Phase 1 · about 3 to 4 weeks · Cloud agent, no app yet

- The API service: the git endpoint over S3 with push checks and conditional writes, the page reports and cache, Clerk token checks, DynamoDB accounts, per-ledger scoped credentials, usage metering.
- The sandbox: the image, the AgentCore Runtime in private subnets, the CodeArtifact mirror, and the deepagents connector through the API service.
- The agent: the deepagents graph on LangSmith calling Bedrock, ledger tool wrappers, and `commit_and_push` with rebase-and-retry.
- Drive it from a script or a throwaway web page.

**Done when** evals match or beat the pi baseline, two chats saving at once never lose a change, and the cross-user tests pass.

### Phase 2 · about 4 to 6 weeks · iPhone app on TestFlight

- Sign in, chat, camera and file attachments, Transactions, Net Worth, memory, history with undo, export, delete account.

**Done when** you keep your own books on the phone for two weeks.

### Phase 3 · about 2 to 3 weeks · Launch

- RevenueCat, paywall, allowance enforcement, AI consent screen, privacy label, legal entity, App Review, the prod stacks.

**Done when** the app is live and the first renewal goes through.

### Phase 4 · after launch · What the cloud makes possible

- Scheduled jobs with push: budget alerts, monthly review.
- Share extension, widgets, app help pages.
- Shared ledgers for households and accountants: a members list with roles.
- Revisit hosting the agent on AgentCore Runtime to drop LangSmith.

## Decisions for you

These change the plan, so they are yours to make before phase 1.

1. **Which model runs everyday chats?** Sonnet 5 through Bedrock EU is the safe start and leaves a thin margin at $9.99. A cheaper everyday model or a higher price fixes it. The phase 0 evals decide.
2. **Clerk or Cognito for sign-in?** Clerk is quicker to build with in Expo. Cognito keeps sign-in on AWS and in the EU region, one vendor fewer, at the cost of more work on the sign-in screens. Check where Clerk stores EU users' data before deciding.
3. **Do community plugins install with one tap?** Marketplace listing is automatic and unreviewed, and a plugin's scripts run with the user's books in their sandbox. The sandbox can't reach the internet or other users, and the server checks every push, but a bad script can still mangle one user's books before they notice. The options are one tap with a clear warning, or only reviewed plugins.
4. **What does a subscription buy?** One plan with a fair-use allowance, or tiers plus top-up credits (RevenueCat In-App Currency; credits bought through IAP can't expire).
5. **Keep a bring-your-own-key plan?** Cheap to run and loved by power users, but it brings back provider settings and support load.
6. **Android at launch?** Expo makes the code nearly free; testing, store listings and the Play billing path are not.
7. **Which legal entity publishes the app?** Apple asks for an organization account for finance apps, and every processor agreement, AWS included, needs a company on your side.

## Sources

Checked 25–27 September 2026.

- Repository: machulav/accountant24 at 13c2f44 (packages/pi-extension, packages/desktop/src/main, renderer/runtime, scripts/vendor-bin.ts), accountant24/skills, machulav/ynab-import, accountant24/marketplace index.
- deepagents: [backends](https://docs.langchain.com/oss/javascript/deepagents/backends), [sandboxes](https://docs.langchain.com/oss/javascript/deepagents/sandboxes), skills, memory, context engineering, going to production; npm deepagents 1.14.1.
- LangSmith: [pricing](https://www.langchain.com/pricing), billing, cloud platform features, custom auth, [regions](https://docs.langchain.com/langsmith/cloud).
- AgentCore: [Runtime sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [shell command execution](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-execute-command.html), [new AgentCore Runtime GA](https://aws.amazon.com/about-aws/whats-new/2026/09/new-agentcore-runtime-generally-available/), [Runtime instances and regions](https://aws.amazon.com/blogs/aws/runtime-instances-persistent-compute-for-production-ai-agents-on-amazon-bedrock-agentcore/), [Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-create.html).
- Bedrock: [Claude Sonnet 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html), [inference profiles by region](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html).
- Storage and compute: [S3 conditional writes](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes/), [CodeCommit returns to GA](https://aws.amazon.com/blogs/devops/aws-codecommit-returns-to-general-availability/), [CodeCommit quotas](https://docs.aws.amazon.com/codecommit/latest/userguide/limits.md), [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html).
- Sandboxes compared: pricing and docs of AgentCore, Daytona and E2B.
- Anthropic: [pricing](https://platform.claude.com/docs/en/about-claude/pricing), data residency.
- Apple: [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) (3.1.1, 3.2.1, 4.8, 5.1.1, 5.1.2), AI data-sharing update (13 Nov 2025), EU terms from 1 Oct 2026, Small Business Program.
- Client and services: Expo SDK 57 changelog and module docs, assistant-ui React Native docs, RevenueCat, Superwall and Clerk pricing and Expo docs.

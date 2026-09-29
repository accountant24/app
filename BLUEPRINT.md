# Accountant24 Mobile Blueprint

Draft 3 · 27 Sep 2026 · Forked from accountant24 v0.3.4 (13c2f44)

How to turn the desktop agent into a paid, closed-source iPhone app on AWS, with the model, compute and storage included.

## The short version

Keep the ledger logic, the prompt and hledger. Store the books as git in S3, run every tool in a sandbox per chat, read pages straight from the books, and run it all in one EU region of AWS.

| Area                 | Pick                                                                                               | Runner-up                                   |
| -------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Cloud                | AWS, Ireland (eu-west-1), defined in CDK                                                           | Frankfurt, with the older AgentCore Runtime |
| Books                | A git repo per user, one bundle file in a versioned S3 bucket, replaced with a conditional write   | CodeCommit, one repo per user               |
| Server               | One stateless API function on Lambda (container image: Node, git, hledger)                         | ECS Fargate behind a load balancer          |
| Accounts             | DynamoDB                                                                                           | Aurora Serverless Postgres                  |
| Agent                | deepagents (TypeScript) on LangSmith Deployment, EU                                                | deepagents on AgentCore Runtime             |
| Sandboxes            | AgentCore Runtime, one session per chat, with a connector we write                                 | Daytona                                     |
| Model                | Claude on Bedrock (EU inference profile), one model as a server setting                            | Anthropic API directly                      |
| Accounting engine    | hledger, one pinned version                                                                        | None; decided                               |
| App                  | Expo, assistant-ui (React Native + LangGraph runtime)                                              | SwiftUI                                     |
| Sign-in              | Clerk (Apple, Google)                                                                              | Cognito                                     |
| Payments             | RevenueCat on StoreKit 2                                                                           | Superwall                                   |

The fork: this repo becomes the closed app; the open-source desktop app stays in its own repo. The ledger code no longer has to serve the desktop. The forked code is Apache-2.0: keep its license and notice.

## Architecture

The books are git, so the agent works on real files exactly as on the Mac, and history and undo are plain git. Each chat gets a throwaway sandbox with a clone; the sandbox never holds the only copy, and pages never need a sandbox awake.

```
+------------------+  JWT  +-------------------------------+
| Clerk            | ----> | iOS APP (Expo, React Native)  |
| Apple and Google |       | chat with tool steps          |
+------------------+       | Transactions, Net worth       |
                           | export                        |
                           | camera, scanner, Files        |
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
|   +------------------------+              | profile: Claude Sonnet 5,   |           |
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
|   | versioned    |  | users,       |                                                |
|   | books.bundle |  | plan, daily  |                                                |
|   | per user     |  |              |                                                |
|   +--------------+  +--------------+                                                |
+-------------------------------------------------------------------------------------+
```

### Rules

- **The sandbox is never the database.** A throwaway clone per chat, stopped after 10 idle minutes. A change counts only once the API service has saved it to S3.
- **Every save passes hledger twice.** In the sandbox for fast feedback, then in the API service before saving, because the sandbox runs model-written code.
- **Only the server writes the books.** The sandbox has no way to reach storage; the API service copies `books.bundle` in and out. A save lands only if `books.bundle` is still the version the sandbox cloned; otherwise it fails, the sandbox gets the newer books, and the agent redoes its change. Undo is `git revert`.
- **The server keeps nothing.** Each request works in its own temporary folder. Any invocation serves any ledger.
- **Identity comes from a verified token only**, never from the request body or the model. Every storage path is built from that ID, and cross-user tests guard it. AWS credentials scoped to one user per request can come later.
- **Sandboxes hold no credentials**: no git token, no AWS credentials, no model keys, no internet. Because the API service moves the books, storage can change without touching the sandbox.
- **Uploads live in the chat only.** A receipt or statement travels in the chat message to the model; nothing stores it separately and it never reaches the sandbox.
- **One ledger per user, keyed by the user ID.** Shared ledgers later add ledger IDs and a members list.

### Storage

```
-- S3 bucket "a24-books" (eu-west-1, versioning on)
users/<user_id>/books.bundle       -- the whole git repo at the latest commit
                                   -- metadata: commit=<sha>; replaced only with If-Match
                                   -- older versions expire 30 days after they are replaced

-- DynamoDB, on-demand
users        id (Clerk) · created_at
plans        user_id · plan · renews_at                  -- from RevenueCat
daily_runs   user_id · day · count                       -- hidden daily cap, from public launch
```

A git bundle is the whole repo, history included, in one file. Without uploads in git it stays a few MB for years. Chats and traces live in LangSmith (Netherlands); everything else stays in Ireland.

### Chat history

Chats are LangSmith threads in the deployment's Postgres, with messages, tool steps and images. The app lists them by owner.

- **What the user sees is separate from what the model sees.** deepagents' summarization replaces older messages in the thread's `messages` with a summary. So a middleware appends every user message, tool step and reply to a separate `ui_messages` field that summarization never touches, and the app renders `ui_messages`. The model gets the summary; the user keeps the whole chat.
- When it summarizes, deepagents also writes the old conversation to a file so the agent can look up details later. Route that folder to LangSmith's store, so the file survives the sandbox and stays out of the books repo. The app doesn't read this file: it's plain text, covers only the summarized part, and its format belongs to deepagents.
- Threads are not traces: traces expire (14 days on standard retention), threads stay until deleted.
- Keep thread TTL (`checkpointer.ttl`) off, and delete threads when a chat or account is deleted.
- The app reads chats through a thin adapter, so leaving LangSmith means exporting threads and changing only that adapter.

## One turn, end to end

```
iPhone           Agent server          Sandbox              API service          Bedrock
  |                   |                   |                      |                   |
  | 1 chat opened ---------------------------------------------->|                   |
  |                   |                   |<--- 2 start sandbox -|                   |
  |                   |                   |<-- 3 books.bundle ---|                   |
  | 4 run + receipt   |                   |                      |                   |
  |   photo --------->|                   |                      |                   |
  |                   |-- 5 prompt (cached prefix) + image ------------------------->|
  |                   |<----------------------------------- 6 add_transactions(...) |
  |                   |-- 7 run the tool (via the API) ->|       |                   |
  |                   |                   | 8 entry, check,      |                   |
  |                   |                   |   commit             |                   |
  |                   |                   |-- 9 books.bundle --->|                   |
  |                   |                   |   (full repo)        | 10 check,         |
  |                   |                   |                      |    save r42       |
  |                   |<- 11 saved r42 ---|                      |                   |
  |                   |-- 12 tool result -> final reply ---------------------------->|
  |<- 13 stream steps |                   |                      |                   |
  |      + reply -----|                   |                      |                   |
```

Step 10 is the only save. When the phone sees "saved r42" in the stream, open pages refetch. If the phone disconnects, the run keeps going and the phone rejoins the stream.

## How it works

**Chat opens.** The API service starts an AgentCore session (our image: hledger, git, the ledger program), uploads the ledger's `books.bundle` into it and runs `git clone` there. The agent gets a normal repo with the full history. The session stops after 10 idle minutes.

**Tools.** The agent loop runs on LangSmith; every tool runs in the sandbox. Our deepagents connector maps the file tools and `execute` to three API calls: run a command, upload a file, download a file. The API service runs them with `InvokeAgentRuntimeCommand` under its own AWS role. Ledger tools are thin wrappers that pass JSON to the ledger program.

**Saving:**

1. `commit_and_push` commits in the sandbox and packs the whole repo with `git bundle create books.bundle --all`, then asks the API service to save.
2. The API service downloads that one file from the sandbox and clones it into a temporary folder.
3. It checks that the last saved commit (stored as metadata on the S3 object, read without a download) is an ancestor of the new `main`, that only workspace files changed since it, and that `hledger check --strict` passes.
4. It uploads the file to S3 with `If-Match` on the version the sandbox cloned, so the write fails if another chat saved first. S3 versioning keeps the previous bundle.
5. If the write fails, the save returns "the books changed in another chat". The API service copies the latest `books.bundle` into the sandbox and re-clones, and the agent redoes its change on top. There is no automatic rebase; add one if users often save from parallel chats.

Commits carry the chat and run as trailers, so "undo the last change" reverts exactly that run.

**Documents.** Photos, scans and PDFs go straight to Claude in the message; Claude reads PDFs natively. CSV and other text files go in as plain text. Nothing reaches the sandbox, and the chat history is the only place that keeps the file. A `pdftotext` path through the sandbox, which cuts a statement's tokens several times over, comes back if imports get expensive or a text-only model joins.

**Skills.** Built-in skills and skills users create in chat are instructions only: `SKILL.md` files in the books repo, saved like any other change. Skill scripts (uv, Python, a PyPI mirror) and the plugin marketplace come after launch.

## Pages

A page request: check the token, download the ledger's `books.bundle` into a temporary folder, run hledger, parse the output with `ledger-json.ts`, and delete the folder. Pages always read the latest saved version. Add caching, keyed by commit, only if pages get slow.

| Page                 | hledger command                                         |
| -------------------- | ------------------------------------------------------- |
| Transactions         | `hledger print -O json`, limited by date range          |
| Net worth            | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Mentions, pickers    | `hledger accounts`, `payees`, `tags`                    |

Later pages are each one more command: net worth over time (`hledger bs -M -V --historical`), spending by category (`hledger bal expenses -M --depth 2`), and a History page from `git log` with the chat and run trailers.

Pages refetch when the chat reports a save and when the app returns to the foreground. Live updates across devices can come later.

## Infrastructure as code

One CDK app in TypeScript, one AWS account with dev and prod stacks; GitHub Actions deploys over OIDC. A separate prod account and our own KMS key come before real users' data grows.

| Stack   | What it creates                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------- |
| Network | VPC with private subnets for the sandboxes only; no NAT gateway, no endpoints (the API runs outside the VPC)               |
| Data    | Versioned books bucket with the 30-day rule and DynamoDB tables, both with AWS default encryption (kept on stack delete)   |
| Sandbox | Sandbox image in ECR, AgentCore Runtime in private subnets with no network access                                          |
| API     | Lambda function from a container image in ECR, function URL, execution role, and the AWS Budgets alarm on spend            |

Per-user things (a user's folder, a chat's session) are created by the app, not by CDK. EventBridge Scheduler comes with budget alerts and the monthly review, after launch.

## Costs and unit economics

|                                               | Before launch  | At launch                             |
| --------------------------------------------- | -------------- | ------------------------------------- |
| LangSmith (agent server)                      | $39            | ≈ $430                                |
| AWS base (Lambda, logs)                       | ≈ $0–5         | ≈ $20–60                              |
| S3, DynamoDB                                  | ≈ $1           | ≈ $5–20 at 10k users                  |
| Sandboxes (AgentCore, per second of use)      | usage          | ≈ $500–1,500 at 10k users             |
| Clerk, RevenueCat, Expo, Sentry, PostHog      | $0             | $0–50                                 |
| **Total**                                     | **≈ $40–50**   | **≈ $450–550** + model + sandbox time |

AWS figures are estimates; confirm them in the AWS pricing calculator.

Per subscriber per month, assuming 80 messages, 3 model calls each, 20k tokens of context at 75% cache hits, 800 output tokens, 2,000 subscribers, 15% store commission, and Bedrock EU prices (10% above Anthropic's):

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
expenses:platform:shared       ||      0.24      0.24       0.24
expenses:storage               ||      0.01      0.01       0.01
-------------------------------++------------------------------
                               ||      9.42      9.90       5.66
===============================++==============================
Net                            ||      0.57      3.09       4.33
Margin                         ||        6%       24%        43%
```

Tokens are about 80% of all costs. The levers, in order: shorter chats, better cache hits, fewer calls per message, a cheaper model for everyday logging, and the price. There is no monthly limit at first: TestFlight and the invite-only beta run unlimited, and the terms carry a fair-use clause. Before the public launch, add a hidden daily cap per user (about 200 messages, which only a script reaches) and the Bedrock budget alarm. Beta usage then shows whether a monthly limit is needed; per-dollar metering comes only with usage-priced plans.

## Scope

**At launch:** chat with tool steps, runs that finish with the app closed (the answer is there on reopening), a stop button, camera/scanner/Files attachments, `@` mentions, the skills sheet, Transactions, Net worth, export as a zip or git repo, skills made in chat (instructions only), subscription, delete account.

**Later:** skill scripts and the plugin marketplace, a History screen with an undo button (until then, undo is asking the agent), a Memory screen, more charts, steering and queueing messages while the agent works, push notifications when a run finishes, share sheet into a chat, budget alerts and a monthly review, app help pages, shared ledgers, widgets and Siri.

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Switching from pi to deepagents is the biggest risk**; the prompt was tuned on pi. Build the eval set and record pi's baseline first, and pin deepagents (it ships almost weekly).
- **Confirm with AWS:** the Sonnet 5 EU profile works from Ireland; AgentCore prices and concurrent-session quota; Lambda cold starts for the container image (measure page latency; add provisioned concurrency if needed); Bedrock's size limit for PDFs attached to a message.
- **AgentCore CDK constructs are alpha**; pin the version.
- **assistant-ui React Native with the LangGraph runtime is undocumented**; prototype it first (use `expo/fetch` for streaming).
- **LangSmith traces are full copies of users' books**; sample them, keep retention short, keep the workspace to one person.
- **Statements are the priciest messages**: Claude reads each PDF page as text and an image (a 10-page statement is about 20–30k input tokens). Cap pages and size per upload.
- **Measure hledger on a ten-year ledger** and page Transactions by date range.
- **Pin one hledger version** in both Dockerfiles. It's GPL: fine on servers, never inside the iOS app.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple next to Google; in-app account deletion that reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with AWS, LangSmith, Clerk, RevenueCat, Sentry, PostHog; a DPIA; check where Clerk and RevenueCat keep data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger and git run.
- **Cost control:** hidden daily cap per user, cap on model calls per run, cache-friendly prompt order (context block last), Budgets alarms and a switch that pauses new runs.
- **Operations:** a tested restore from an older S3 version; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL).

## Build order

| Phase                 | Time        | Work                                                                                                                                                                                      | Done when                                                                    |
| --------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 0 · Groundwork        | ≈ 2 weeks   | Eval set and pi baseline; delete desktop, website, docs, demos from the fork; ledger code as a command-line program; AWS account and CDK Network and Data stacks; pick one model on Bedrock | Ledger program tests pass, `cdk deploy` works in dev, baseline numbers exist |
| 1 · Cloud agent       | ≈ 3–4 weeks | API service (save with checks, pages, accounts); sandbox image, AgentCore, connector;               deepagents graph on LangSmith with ledger tools                         | Evals match pi, concurrent saves never lose a change, cross-user tests pass  |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, Transactions, Net worth, export, delete account                                                                                                               | You keep your own books on the phone for two weeks                           |
| 3 · Launch            | ≈ 2–3 weeks | RevenueCat, paywall, daily cap, consent screen, privacy label, legal entity, App Review, prod stacks                                                                                      | Live, first renewal goes through                                             |
| 4 · After launch      |             | Push notifications, alerts and monthly review, share extension, widgets, shared ledgers, maybe agent hosting on AgentCore                                                                                     |                                                                              |

## Decisions for you

1. **Sonnet 5 or Haiku 4.5?** One model for everything at launch. Sonnet 5 leaves 6% at $9.99; Haiku 4.5 or $12.99 fixes it, if it passes the evals against the pi baseline. Routing tasks to different models comes later, when costs need cutting.
2. **Clerk or Cognito?** Clerk is faster to build with; Cognito keeps sign-in on AWS, one vendor fewer.
3. **What does a subscription buy?** One unlimited plan under fair use at launch; tiers or a monthly limit only if beta usage shows heavy users cost more than they pay.
4. **Keep bring-your-own-key?** Cheap to run, but it brings back provider settings and support load.
5. **Android at launch?** The code is nearly free with Expo; testing and store work are not.
6. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

## Sources

Checked 25–27 September 2026: [AgentCore Runtime sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [AgentCore shell commands](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-execute-command.html), [new AgentCore Runtime](https://aws.amazon.com/about-aws/whats-new/2026/09/new-agentcore-runtime-generally-available/), [Claude Sonnet 5 on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html), [Bedrock inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html), [S3 conditional writes](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes/), [CodeCommit quotas](https://docs.aws.amazon.com/codecommit/latest/userguide/limits.md), [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html), [deepagents sandboxes](https://docs.langchain.com/oss/javascript/deepagents/sandboxes), [LangSmith pricing](https://www.langchain.com/pricing), [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

# Accountant24 Mobile Blueprint

Draft 3 · 27 Sep 2026 · Forked from accountant24 v0.3.4 (13c2f44)

How to turn the desktop agent into a paid, closed-source iPhone app on AWS, with the model, compute and storage included.

## The short version

Keep the ledger logic, the prompt and hledger. Store the books as git in S3, run every tool in a sandbox per chat, read pages straight from the books, and run it all in one EU region of AWS.

| Area | Pick | Runner-up |
| --- | --- | --- |
| Cloud | AWS, Ireland (eu-west-1), defined in CDK | Frankfurt, with the older AgentCore Runtime |
| Books | A git repo per ledger, one bundle file in a versioned S3 bucket, replaced with a conditional write | CodeCommit, one repo per ledger |
| Server | One stateless API service on ECS Fargate (Node, git, hledger) | Lambda with a container image |
| Accounts | DynamoDB | Aurora Serverless Postgres |
| Agent | deepagents (TypeScript) on LangSmith Deployment, EU | deepagents on AgentCore Runtime |
| Sandboxes | AgentCore Runtime, one session per chat, with a connector we write | Daytona |
| Model | Claude on Bedrock (EU inference profile), chosen per task by evals | Anthropic API directly |
| Accounting engine | hledger, one pinned version | None; decided |
| Python packages | CodeArtifact PyPI mirror, no internet in sandboxes | An internet allowlist |
| App | Expo, assistant-ui (React Native + LangGraph runtime) | SwiftUI |
| Sign-in | Clerk (Apple, Google) | Cognito |
| Payments | RevenueCat on StoreKit 2 | Superwall |
| Push, scheduled jobs | Expo push, EventBridge Scheduler | SNS mobile push |

The fork: this repo becomes the closed app; the open-source desktop app stays in its own repo. The ledger code no longer has to serve the desktop. The forked code is Apache-2.0: keep its license and notice.

## Architecture

The books are git, so the agent works on real files exactly as on the Mac, and history and undo are plain git. Each chat gets a throwaway sandbox with a clone; the sandbox never holds the only copy, and pages never need a sandbox awake.

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

### Rules

- **The sandbox is never the database.** A throwaway clone per chat, stopped after 10 idle minutes. A change counts only once the API service has saved it to S3.
- **Every save passes hledger twice.** In the sandbox for fast feedback, then in the API service before saving, because the sandbox runs model-written code.
- **Only the server moves `main`.** Sandboxes push their own chat branch. A push is saved only if `books.bundle` is still the version it was based on; otherwise the sandbox pulls, rebases, re-checks and pushes again. Undo is `git revert`.
- **The server keeps nothing.** Each request works in its own temporary folder. Any task serves any ledger.
- **Identity comes from a verified token only**, never from the request body or the model.
- **AWS enforces the ledger boundary.** Each request gets temporary credentials that reach only `ledgers/<id>/` in S3.
- **Sandboxes hold no keys.** Only a short-lived token for their own ledger's git remote; no internet, no AWS credentials, no model keys.
- **The sandbox only knows the git URL and token the server gives it**, so the storage behind it can change without touching the sandbox.
- **Uploads live in the chat only.** A receipt travels in the chat message and sits in the sandbox while the chat is open; nothing stores it separately.
- **Keyed by ledger, not by user**, so shared ledgers later only add a members list.

### Storage

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

Step 10 is the only save. When the phone sees "saved r42" in the stream, open pages refetch. If the phone disconnects, the run keeps going and the phone rejoins the stream.

## How it works

**Chat opens.** The API service starts an AgentCore session (our image: hledger, git, uv, pdftotext, the ledger program). It gets a short-lived git token and clones the books over the internal network. It stops after 10 idle minutes.

**Tools.** The agent loop runs on LangSmith; every tool runs in the sandbox. Our deepagents connector maps the file tools and `execute` to three API calls: run a command, upload a file, download a file. The API service runs them with `InvokeAgentRuntimeCommand` under its own AWS role. Ledger tools are thin wrappers that pass JSON to the ledger program.

**Saving:**

1. The sandbox commits and pushes `chat/<chat_id>` to the API service's git URL. The token can write only that branch.
2. The API service downloads `books.bundle` into a temporary folder, notes its ETag, and receives the push with real git.
3. A hook checks that the commit builds on the current `main`, only workspace files changed, and `hledger check --strict` passes.
4. It moves `main`, writes the new bundle with `If-Match` on the ETag, and only then reports success. S3 versioning keeps the previous bundle.
5. If another chat saved first, the push is rejected and the sandbox pulls, rebases, re-checks and pushes again. A real conflict goes back to the agent.

Commits carry the chat and run as trailers, so "undo the last change" reverts exactly that run.

**Documents.** Photos and scans go to the model as images. A text PDF is also written into the sandbox's `uploads/` (outside git) and read with `pdftotext`. The chat history shows the file; nothing else keeps it.

**Scripts and new skills.** Skill scripts run in the sandbox with packages from CodeArtifact. New skills are files the agent writes; the push check validates plugin manifests.

## Pages

A page request: check the token, read the commit ID on `books.bundle` (a metadata request), return the cached result for (ledger, commit, page, filters), or on a miss download the bundle, run hledger, parse with `ledger-json.ts` and cache. A new save means a new commit, so nothing is ever invalidated or stale.

| Page | hledger command |
| --- | --- |
| Transactions | `hledger print -O json`, limited by date range |
| Net worth | `hledger bs -O json`, at cost and valued (`-V` or `-X`) |
| Net worth over time | `hledger bs -M -V --historical -O json` |
| Spending by category | `hledger bal expenses -M --depth 2 -O json` |
| Mentions, pickers | `hledger accounts`, `payees`, `tags` |
| History | `git log` with the chat and run trailers |

Pages refetch when the chat reports a save and when the app returns to the foreground. Live updates across devices can come later.

## Infrastructure as code

One CDK app in TypeScript. Separate dev and prod accounts; GitHub Actions deploys over OIDC.

| Stack | What it creates |
| --- | --- |
| Network | VPC with public and private subnets, no NAT gateway; free S3 and DynamoDB endpoints, interface endpoints only where needed |
| Data | Versioned books bucket with the 30-day rule, DynamoDB tables, KMS key (kept on stack delete) |
| Sandbox | Sandbox image in ECR, AgentCore Runtime in private subnets, CodeArtifact with a PyPI upstream |
| API | Fargate service, public and internal load balancers, task role, per-ledger role with a session policy |
| Jobs | EventBridge Scheduler, AWS Budgets alarms |

Per-user things (a ledger's folder, a chat's session) are created by the app, not by CDK.

## Costs and unit economics

| | Before launch | At launch |
| --- | --- | --- |
| LangSmith (agent server) | $39 | ≈ $430 |
| AWS base (load balancers, Fargate, endpoints) | ≈ $60–90 | ≈ $120–200 |
| S3, DynamoDB, CodeArtifact | ≈ $1 | ≈ $5–20 at 10k users |
| Sandboxes (AgentCore, per second of use) | usage | ≈ $500–1,500 at 10k users |
| Clerk, RevenueCat, Expo, Sentry, PostHog | $0 | $0–50 |
| **Total** | **≈ $100–130** | **≈ $600–700** + model + sandbox time |

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
expenses:platform:shared       ||      0.31      0.31       0.31
expenses:storage               ||      0.01      0.01       0.01
-------------------------------++------------------------------
                               ||      9.49      9.97       5.73
===============================++==============================
Net                            ||      0.50      3.02       4.26
Margin                         ||        5%       23%        43%
```

Tokens are about 80% of all costs. The levers, in order: shorter chats, better cache hits, fewer calls per message, a cheaper model for everyday logging, and the price. Every plan gets a monthly allowance, checked before each run.

## Scope

**At launch:** chat with tool steps, runs that finish with the app closed plus a push, steering and stop, camera/scanner/Files attachments, `@` mentions, the skills sheet, Transactions, Net worth, charts from hledger, memory screen, history with undo, export as a zip or git repo, skills with scripts, plugin install, subscription, usage, delete account.

**Later:** share sheet into a chat, budget alerts and a monthly review, app help pages, shared ledgers, widgets and Siri.

**Dropped:** provider, model and Ollama settings.

## Risks and things to verify

- **Switching from pi to deepagents is the biggest risk**; the prompt was tuned on pi. Build the eval set and record pi's baseline first, and pin deepagents (it ships almost weekly).
- **Confirm with AWS:** the Sonnet 5 EU profile works from Ireland; AgentCore prices and concurrent-session quota; ECS Express Mode in CDK (otherwise the standard load-balanced Fargate pattern).
- **AgentCore CDK constructs are alpha**; pin the version.
- **assistant-ui React Native with the LangGraph runtime is undocumented**; prototype it first (use `expo/fetch` for streaming).
- **LangSmith traces are full copies of users' books**; sample them, keep retention short, keep the workspace to one person.
- **Statements as images are expensive**; prefer the text path, cap pages and size, count imports against the allowance.
- **Measure hledger on a ten-year ledger** and page Transactions by date range.
- **Pin one hledger version** in both Dockerfiles. It's GPL: fine on servers, never inside the iOS app.
- **Never use DeepSeek's own API** (data in China); only an EU host, and only if evals pass.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple next to Google; in-app account deletion that reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with AWS, LangSmith, Clerk, RevenueCat, Expo, Sentry, PostHog; a DPIA; check where Clerk, Expo push and RevenueCat keep data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger and git run.
- **Cost control:** per-user allowance, cap on model calls per run, cache-friendly prompt order (context block last), Budgets alarms and a switch that pauses new runs.
- **Operations:** a tested restore from an older S3 version; remote config for model and allowances; a license review (Apache-2.0 notices, hledger GPL).

## Build order

| Phase | Time | Work | Done when |
| --- | --- | --- | --- |
| 0 · Groundwork | ≈ 2 weeks | Eval set and pi baseline; delete desktop, website, docs, demos from the fork; ledger code as a command-line program; AWS accounts and CDK Network and Data stacks; model evals on Bedrock | Ledger program tests pass, `cdk deploy` works in dev, baseline numbers exist |
| 1 · Cloud agent | ≈ 3–4 weeks | API service (git endpoint, checks, pages, accounts, metering); sandbox image, AgentCore, CodeArtifact, connector; deepagents graph on LangSmith with ledger tools | Evals match pi, concurrent saves never lose a change, cross-user tests pass |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, Transactions, Net worth, memory, history, export, delete account | You keep your own books on the phone for two weeks |
| 3 · Launch | ≈ 2–3 weeks | RevenueCat, paywall, allowance, consent screen, privacy label, legal entity, App Review, prod stacks | Live, first renewal goes through |
| 4 · After launch | | Alerts and monthly review, share extension, widgets, shared ledgers, maybe agent hosting on AgentCore | |

## Decisions for you

1. **Which model runs everyday chats?** Sonnet 5 on Bedrock EU leaves 5% at $9.99. A cheaper model or $12.99 fixes it; the evals decide.
2. **Clerk or Cognito?** Clerk is faster to build with; Cognito keeps sign-in on AWS, one vendor fewer.
3. **Community plugins with one tap?** Their scripts run next to the user's books. One tap with a warning, or reviewed plugins only.
4. **What does a subscription buy?** One plan with an allowance, or tiers plus top-up credits.
5. **Keep bring-your-own-key?** Cheap to run, but it brings back provider settings and support load.
6. **Android at launch?** The code is nearly free with Expo; testing and store work are not.
7. **Which legal entity publishes the app?** Apple and every processor agreement need a company.

## Sources

Checked 25–27 September 2026: [AgentCore Runtime sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [AgentCore shell commands](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-execute-command.html), [new AgentCore Runtime](https://aws.amazon.com/about-aws/whats-new/2026/09/new-agentcore-runtime-generally-available/), [Claude Sonnet 5 on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html), [Bedrock inference profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html), [S3 conditional writes](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-functionality-conditional-writes/), [CodeCommit quotas](https://docs.aws.amazon.com/codecommit/latest/userguide/limits.md), [App Runner availability change](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html), [deepagents sandboxes](https://docs.langchain.com/oss/javascript/deepagents/sandboxes), [LangSmith pricing](https://www.langchain.com/pricing), [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).

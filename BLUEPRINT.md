# Accountant24 Mobile Blueprint

How to turn the desktop agent into a paid, closed-source iPhone app on Cloudflare, with the model (Claude), compute and storage included.

## The short version

Keep the agent, the ledger logic, the prompt and hledger, and run them the way the desktop does. Each set of books gets one Durable Object (the bookkeeper) that plays the part of the desktop's Electron main, and one sandbox that plays the part of its agent host: the desktop's own agent host, pi with our extension, one session per chat, working on a clone of the books repo in Cloudflare Artifacts. Pages are computed at save time, and everything stored stays in Cloudflare's EU jurisdiction. The model is Claude, reached through Cloudflare's AI Gateway; EU-only inference is preferred but not required for the MVP.

| Area | Pick |
| --- | --- |
| Cloud | Cloudflare (Workers, Durable Objects, Containers, Artifacts, R2, D1, AI Gateway), storage in the EU jurisdiction, defined in wrangler config |
| Books | The books repo: one git repo per set of books in Cloudflare Artifacts; the sandbox clones and pushes it, and a daily fork keeps a snapshot |
| Server | One Worker (the worker): sign-in, the chat connection, uploads and pages |
| State | The bookkeeper, one Durable Object per set of books, with its chats and page data; the directory (D1) for users, sessions, members and limits |
| Agent | The desktop's agent host (pi + `pi-extension`) in the sandbox, one pi session per chat, as on the Mac |
| Sandboxes | Cloudflare's Sandbox SDK: the bookkeeper extends its class and runs one sandbox per set of books, shared by its chats |
| Model | Claude through Cloudflare's AI Gateway to Anthropic's API, one model as a server setting; open models on Workers AI as the cheaper option the evals may pick later |
| Accounting engine | hledger, one pinned version |
| Uploads | PDFs and CSVs in R2, read by the agent with `extract_text`; photos go to the model directly, as on the desktop |
| Mobile app | Expo, assistant-ui (React Native) with its pi runtime (`@assistant-ui/react-pi`, as on the desktop) |
| Sign-in | Sign in with Apple only, no auth vendor: the worker checks Apple's token and issues our own session token |
| Payments | None in the beta; RevenueCat on StoreKit 2 from the public launch (see Planned for the public launch) |

This repo is a closed fork; the open-source desktop app stays in its own repo. Keep the Apache-2.0 license and notice for the forked code.

## Architecture

The cloud is the desktop with its parts moved apart. The bookkeeper does what Electron main does: it starts the agent host, passes it the user's messages, streams its events back and stores the chats. The sandbox does what the agent host's utilityProcess does: it runs pi with our extension over one shared working copy of the books, so every chat on the same books sees the same files, as every chat on the Mac shares the workspace folder. The sandbox never holds the only copy or any credential, and pages never need a sandbox awake. Plain records live in the directory, a D1 database.

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
|  | one per set of books; extends Cloudflare's     |   | PDFs and CSVs, per set of     |  |
|  | Sandbox class; chat relay, chats, saves,       |   | books                         |  |
|  | pages; outbound rule: adds tokens, counts      |   +-------------------------------+  |
|  | model calls                                    |                                      |
|  +------------------------------------------------+                                      |
|        |  start, messages        ^  every outbound request                               |
|        v  events back            |                                                       |
|  +---------------------------+   |   +------------------+                                |
|  | SANDBOX                   |---+-->| BOOKS REPO       |                                |
|  | one per set of books;     |   |   | Artifacts, one   |                                |
|  | agent host: pi +          |   |   | git repo per set |                                |
|  | pi-extension, one session |   |   | of books         |                                |
|  | per chat; the clone,      |   |   +------------------+                                |
|  | hledger, git, poppler     |   |   +------------------+                                |
|  +---------------------------+   +-->| AI GATEWAY       |                                |
|                                      +------------------+                                |
+--------------------------------------------|---------------------------------------------+
  Cloudflare, EU jurisdiction                |
                                             v
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
current commit · the sandbox · save log · the current run's events
chats: chats (chat_id · name · updated_at) · chat_entries (chat_id · seq · entry)
page data: page_transactions (one row per month) · page_net_worth · page_lists

-- directory: D1 database "directory" (EU jurisdiction)
users           user_id · created_at                                   -- our own ID, never a provider's
identities      provider · sub · user_id · refresh_token               -- unique (provider, sub); apple now, google later
sessions        token_hash · user_id · created_at · expires_at         -- hashes only
books           books_id · owner_user_id · created_at                  -- one per user at first; shared books later
members         books_id · user_id · role                              -- owner, editor, viewer; the owner's row at first
daily_runs      user_id · day · count                                  -- hidden daily cap, from public launch
```

Artifacts is Cloudflare's git server for agents: ordinary git clients clone and push with a scoped token, and a Worker can read history and files (`log`, `readCommit`, `readFile`) and copy a repo (`fork`) without git. A books repo stays a few MB for years because uploads never go into git (`files/` is git-ignored in the cloud); the limits are 1 GB per repo and 32 MB per file. The user ID is always our own, never Apple's, and users and books have separate IDs, so Google sign-in and shared books need no data migration. Everything is stored in Cloudflare's EU jurisdiction. Model calls go to Anthropic, whose processing may happen outside the EU; the privacy policy says so, and an EU-only route can replace it later as a server setting.

### Chat history

Each chat is a pi session, as on the desktop. The bookkeeper owns them: it keeps every session entry in its SQLite, writes a chat's session file into the sandbox before the chat's first run there, and stores the new entries after every turn. The mobile app lists chats and loads their messages from the bookkeeper.

Summarization is off, so a chat always keeps every message. When a chat nears 70% of the model's context, the mobile app asks the user to start a new one, and `memory.md` carries the important facts over. Chats never expire; deleting a chat or the account deletes its rows.

## Example: logging a receipt

What happens when a user sends a photo of a receipt and asks the agent to record it. Time runs from top to bottom, and each arrow is one message between two parts of the system. r41 and r42 are versions of the user's books.

```
iPhone             Bookkeeper              Sandbox (pi)            Claude
  |                     |                       |                      |
  | 1 "log receipt"     |                       |                      |
  |   + photo --------->|                       |                      |
  |                     |-- 2 start, clone r41, |                      |
  |                     |     pass message ---->|                      |
  |                     |                       |-- 3 chat + photo --->|
  |                     |                       |<- 4 tool call -------|
  |                     |                       | 5 add_transactions   |
  |                     |                       |-- 6 tool result ---->|
  |                     |                       |<- 7 commit_and_push -|
  |                     |<- 8 git push (r42) ---|                      |
  |                     | 9 check commit,       |                      |
  |                     |   store pages         |                      |
  |                     |                       |-- 10 "saved r42" --->|
  |                     |                       |<- 11 final reply ----|
  |<- 12 every step, as it happens -------------|                      |
```

1. The user sends a photo of a receipt with a short message over the chat connection.
2. The sandbox is asleep, so the bookkeeper starts it: it clones the books (version r41), writes the chat's session file, starts the agent host and passes the message on.
3. Pi sends the chat and the photo to Claude. The call leaves through the bookkeeper's outbound rule, which adds the gateway token and counts the call.
4. Claude answers with a tool call: add this transaction.
5. Pi runs `add_transactions` in its own process, and it writes the journal entry in the clone.
6. Pi gives the tool's result back to Claude.
7. Claude calls `commit_and_push`, as on the desktop.
8. `commit_and_push` checks the ledger with hledger, commits and pushes. The push passes the outbound rule, which adds the repo token. The push is the only moment the books change.
9. The bookkeeper checks with `log()` that r42 follows the last saved commit, has the sandbox compute the pages from r42, checks their shape and size and stores them.
10. Pi gives "saved r42" back to Claude.
11. Claude writes the final reply.
12. Every event streams through the bookkeeper to the phone as it happens. When the phone sees "saved r42", open pages reload. If the phone disconnects, the run keeps going, and the phone replays the run's events from the bookkeeper when it reconnects.

## How it works

**The worker, the bookkeeper and the directory.** One Worker is the only door in. Records live in the directory, one D1 (SQLite) database with normal tables. Everything live about a set of books goes through its bookkeeper: one Durable Object per set of books with its own SQLite, which Cloudflare runs as exactly one copy, handles requests in order, and puts to sleep when idle. It exists because the books need a running sandbox, a chat relay and timers, which a table can't hold.

| Part | Called by | Does | Holds or reaches |
| --- | --- | --- | --- |
| worker | the mobile app: Apple's token or our session token | sign-in, logout, account deletion, the chat connection, uploads, pages | directory; bookkeepers; the uploads bucket |
| bookkeeper | the worker | the sandbox, the chat relay, chats, saves, pages, the outbound rule | the books repo (its token and `log`), the AI Gateway token, the uploads bucket, the sandbox container |
| sandbox | the bookkeeper | the agent host: pi sessions, tools, hledger, git | its own clone; through the outbound rule, only its books repo, AI Gateway and its own uploads |

**Sign-in.** The mobile app signs in with `expo-apple-authentication`. The worker checks Apple's identity token against Apple's public keys and exchanges the authorization code for Apple's refresh token. It finds the user in `identities`, where `(provider, sub)` is unique, so two sign-ins at the same moment still create one user. A new user also gets rows in `users`, `books` and `members` (as owner), and a bookkeeper with an empty books repo and empty page data. The worker then issues a session token (see Auth). Deleting the account revokes the Apple token (App Store rule 5.1.1(v)), deletes the sessions, stops the sandbox, deletes the books the user owns with their books repos, snapshots, uploads and bookkeepers (which hold the chats), and deletes the user's rows.

**Identity.** The user ID comes only from the session token. Every request names a `books_id`, and the worker passes it on only if `members` lists that user for it: when the chat connection opens and on every page or upload request. The agent can't pick a user or books at all: it runs inside one set of books' sandbox, and its only way out is the outbound rule of that set of books. Cross-user tests in CI check that one user can't reach another's books. Each user has one set of books at first.

**The sandbox.** Opening a chat starts nothing. On the first message while the sandbox is asleep, the bookkeeper starts it from our image (see The image), clones the books and starts the agent host; Cloudflare's median container start is about 0.65 seconds, and with the clone the reply starts about 1–2 seconds later. All chats on the same books share this one sandbox and its one agent host, as on the Mac: a change one chat writes is visible to the others at once. The bookkeeper keeps the sandbox up while a run is in flight, so runs finish with the phone closed; after 10 idle minutes it saves anything unsaved and stops it. Its only network access is the outbound rule, a Sandbox SDK hook in the bookkeeper that sees every request: it lets through the books repo and AI Gateway, adds their tokens on the way out, and serves the sandbox its own uploads from R2. The sandbox holds no credentials, and a change counts only once it is pushed.

**The agent.** The agent host is the desktop's own (`agent/host/`, which never imports Electron), moved into a package both builds share. Only its entry changes: the desktop talks to it over Electron's `parentPort`, the cloud over the bookkeeper's connection to the sandbox, with the same messages (`AgentHostRequest`, `AgentHostNotice`). It runs one pi session per chat with our extension, the system prompt and the built-in skills, configured exactly as on the desktop. Stop, the model choice and chat names are the same pi commands the desktop sends.

**Tools.** The same as on the desktop: pi's built-in file tools and `bash`, and the ledger tools of `pi-extension` (`add_transactions`, `query`, `commit_and_push`, `extract_text`, …). They run inside pi, in the sandbox, with no network hop. `bash` runs as a separate user that can't change the agent host, our extension, the prompt or hledger (pi lets the host swap how `bash` spawns), so a tricked model can change only the books' working copy, and only a push makes that count.

**Saving.** Tools and the prompt stay as on the desktop: writes land in the working copy at once, and the agent calls `commit_and_push` after a batch of related changes and at the end of a turn.

1. `commit_and_push` commits with git hooks turned off (`core.hooksPath=/dev/null`), so a planted hook can't change what is committed, checks that `hledger check --strict` passes, and runs `git push`, never with `--force`. The push is the save.
2. The bookkeeper sees the push in its outbound rule and checks with `log()` that the new commit follows the last saved one. If history was rewritten, it flags the books and restores them from the latest snapshot.
3. It has the sandbox compute the pages from that commit (not the working copy, where another chat may be mid-change), reads them with `readFile`, checks them (valid JSON, the expected shape, a size limit), stores them in its SQLite, and records the new commit.
4. The bookkeeper also asks the agent host to run the same save at the end of every run and before stopping an idle sandbox, so nothing stays unsaved when the agent forgets. If the container dies with unsaved changes, those changes are lost and the agent redoes them.

With one working copy there are no stale copies, so saves never conflict. As on the desktop, a commit includes every change not yet saved, whichever chat made it. Commits carry the chat ID, so "undo the last change" reverts that commit with `git revert`. History and restores go through git: `git revert`, or a new commit that brings back an older state. The check after each push catches a rewritten history, and a daily `fork` of the repo, kept for 30 days, covers a bad push. Artifacts has no push checks of its own, so these run after the push, not before.

The save checks run in the sandbox, as on the desktop, and a tricked model could get around them with `bash`, but only on its own books, the same risk the desktop accepts; the snapshots roll a bad push back. A verifier, a second container that never runs model code and checks every save again, comes with shared books, where one person's agent could hurt the books of others.

**The model.** Pi calls Claude at Cloudflare's AI Gateway instead of at Anthropic directly. The sandbox's `models.json` names the gateway with a placeholder key, and the outbound rule swaps in the real gateway token, so no key ever enters the sandbox. The gateway holds the Anthropic key and gives one place for spend and rate limits; the outbound rule counts every model call per set of books, which is where the per-run call cap and the daily cap apply. The model is a server setting the bookkeeper passes to the agent host. Gateway logging stays off, because prompts carry users' books.

**Documents.** As on the desktop. Photos go to the model directly in the message. PDFs and CSVs are uploaded to the worker, stored in R2, and written into the sandbox at `files/YYYY/MM/`; the message carries their path, and the agent reads them with `extract_text`, which runs `pdftotext -layout` for PDFs with text and returns page images (`pdftoppm`) for scans, so the model never gets a whole PDF. Text instead of the native PDF keeps statements several times cheaper, also on every later call that re-sends the chat, and works with models that can't read PDFs. A sandbox that started after the upload reads the file from R2 through the outbound rule.

**Skills.** Skills are instructions only: `SKILL.md` files. The built-in ones ship in the sandbox image with the agent, and the ones users create in chat live in the books repo.

**Calls outside chat.** Model calls that don't need the agent, such as chat names, dashboard widgets and short insights, run in the bookkeeper: it calls Claude through AI Gateway with page data in the prompt and a JSON schema for the answer, checks the result, and stores it next to the page data under a hash of its inputs, so a widget calls the model only when its inputs change, not when it is viewed. Each such call names its own model, usually the cheapest that passes, and counts against the same caps. Work that has to dig into the books, such as a monthly review or budget alerts, runs as a pi session without a chat, started by the bookkeeper after a save or on an alarm, with its result stored the same way.

**Data changes.** Directory changes are numbered SQL files applied with `wrangler d1 migrations` on deploy. The bookkeeper's own small SQLite migrates itself: numbered steps run in its constructor inside `blockConcurrencyWhile`, before it handles any request, so the code only ever sees the current shape. An idle bookkeeper migrates when it next wakes, even months later, so shipped steps are never edited or removed; tests run them with `@cloudflare/vitest-pool-workers` over real SQLite. A change that must reach every bookkeeper at once walks the `books` table and wakes each one. New, renamed or deleted object classes are declared in the wrangler config. Changes go in two releases, add first and remove later, so a rollback still works. Changes to the books themselves are workspace migrations, run in the sandbox by the desktop's migration runner.

### The image

Cloudflare's sandbox image plus:

| Item | What it is |
| --- | --- |
| Node | runs the agent host; the base image's, or added and pinned |
| git | clone, `commit_and_push`, history and undo |
| hledger | one pinned version, the desktop's |
| poppler-utils | `pdftotext` and `pdftoppm` for `extract_text` |
| `/opt/a24/agent-host.js` | the agent host's cloud entry, built like the desktop's, with pi left external |
| `/opt/a24/node_modules` | pi and its own dependencies, pinned, from `npm ci` |
| `/opt/a24/accountant24-extension.js`, `system.md` | our extension and prompt, from `scripts/bundle-extension.ts`, the same files the desktop ships |
| `/opt/a24/skills/` | the built-in skills |
| `/opt/a24/pages.sh` | the page commands of the save step |

Left out: tesseract and its data (vision models read scans better; it comes back only with a model that can't see), uv and Python (skills have no scripts), Electron, provider settings, the plugin marketplace and every secret. At start the bookkeeper adds the clone (`/workspace`, the agent's cwd), the chats' session files (`/sessions`) and `models.json`.

## Auth

Two rules carry most of the security: the agent never gets a way to name another user or set of books, and every token can be cancelled.

**From the start:**

- **Apple sign-in.** The mobile app sends Apple the hash of a one-time nonce and sends the worker the nonce itself. The worker checks Apple's signature against Apple's public keys, the nonce, the issuer, our bundle ID as the audience, and the expiry.
- **Our session tokens.** An opaque random token that lasts 90 days, kept in the Keychain (`expo-secure-store`, this device only). The directory stores only its hash; the worker looks it up on every request (once per chat connection), so logout, deletion or a stolen phone cancels it by deleting the row. Only our own worker ever checks it, so there are no signing keys, public key sets or audiences to manage.
- **The agent can't pick the user or the books.** It runs inside one set of books' sandbox, the outbound rule of that set of books is its only way out, and membership is checked by the worker before anything reaches the bookkeeper, so a document that tricks the model still can't reach other books.
- **No secrets in the sandbox, logs or chats.** The outbound rule adds every token outside the sandbox; logs carry IDs only, never content.

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

Everything on Cloudflare is declared in wrangler config in the repo, one `wrangler.jsonc` with dev and prod environments. GitHub Actions deploys with `wrangler deploy` and a scoped API token. There is no network to set up.

| Piece | What it declares |
| --- | --- |
| `worker` | routes; the `Bookkeeper` object class; the `books-repo` Artifacts namespace; the `uploads` R2 bucket; the `directory` D1 database and its migrations; the `sandbox` container image; the AI Gateway token as a secret |
| Storage | the `books-repo` namespace, the `uploads` bucket and the `directory` database in the EU jurisdiction |
| `ai-gateway` | one AI Gateway with the Anthropic key, logging off, a gateway token for the bookkeeper, and rate limits |

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

The sandbox, platform and storage lines were estimated for AWS; Cloudflare's list prices for containers are lower, but the sandbox now stays up for the whole run, model time included, so the spike measures real usage.

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
- Steering and queueing messages while the agent works (pi supports both)
- Push notifications
- The camera and a document scanner
- Budget alerts and a monthly review
- App help pages
- Shared books: invite links that add a `members` row, roles, Family Sharing on the subscription
- Widgets and Siri
- Live page updates across devices, pushed by the bookkeeper over WebSockets
- Long chats with pi's compaction

**Later, in the tech, when needed:**

- Starting the sandbox when a chat opens, to hide the start
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

- **Pi on a server.** Pi was built for one local user, so the server glue is ours: storing sessions, relaying and replaying events. Pin it and upgrade on purpose; it ships often and breaks things. Keep the ledger logic, the prompt building and memory free of pi imports, with the tools as thin wrappers, so leaving pi means rewriting only the wrappers and the host. Leave pi, for our own loop in the bookkeeper, if we need runs that survive a crash, workflows that pause for an approval, or pi's upgrades cost more than they give.
- **A crashed container loses its turn.** The chat keeps every finished step, and the user sends the message again. Measure how often it happens in the beta.
- **Cloudflare's new container setup and Sandbox SDK 1.0 are previews.** The `durable_object` scheduling policy launched on 30 September 2026, Sandbox SDK 1.0 is on its `@next` line, and the older Container and Sandbox classes get updates only until 31 December 2026. Build on the new API, pin the SDK and its image to the same version, and prove it in the Phase 0 spike.
- **Confirm with Cloudflare** that containers under the new setup, Artifacts, R2 and D1 all run in the EU jurisdiction (the directory holds all user records); container prices and limits; point-in-time recovery for Durable Object storage; and, for Artifacts, beta access on our account, that a sandbox outbound rule can reach a repo and AI Gateway with injected tokens, and whether force pushes can be refused.
- **Confirm with Anthropic and Cloudflare** Anthropic's data retention for API calls (ask for zero retention), that AI Gateway passes images through unchanged with logging off, and Haiku 5.5's release and price.
- **Chats in the bookkeeper's SQLite.** A row holds at most 2 MB, so the mobile app shrinks photos before sending, and a session entry larger than that fails loudly. Check in the spike.
- **Pin versions.** Pi, hledger and poppler are pinned in the sandbox image; hledger is GPL, which is fine on servers but rules it out inside the iOS app. Pin the Workers compatibility date.
- **Check that the Sandbox SDK lets `bash` run as a separate user** that can't change the agent host, our extension, the prompt or hledger.
- **Deploys restart Durable Objects,** and a run in flight can fail. Make saves safe to retry, and let the phone resend a lost turn.
- **Receiving shared files needs an iOS share extension** (`expo-share-intent`). Budget a few days and test with statements shared from real bank apps.
- **assistant-ui's pi runtime on React Native is unproven.** It runs the desktop's chat, but at version 0.0.5 and on the web. Prototype it first, using `expo/fetch` for streaming.
- **Statements are the priciest messages.** Cap pages and size per upload, and check that `pdftotext -layout` keeps real banks' statements readable.
- **Measure hledger on a ten-year ledger**, including the size of the Transactions page JSON.

## Launch checklist

- **App Store:** organization account (5.1.1(ix)); Sign in with Apple; in-app account deletion that revokes the Apple token and reaches every processor; AI consent screen naming the provider (5.1.2(i)); restore purchases; a reviewer demo account.
- **Privacy:** policy and terms; processor agreements with Cloudflare, Anthropic, RevenueCat, Sentry, PostHog; a DPIA; check where RevenueCat keeps data; privacy label.
- **Security:** cross-user tests in CI that must fail; logs with IDs only, never content; hledger `include` kept inside the ledger (`resolveSafePath`); limits on attachment size and type; timeouts on every hledger, git and poppler run; git hooks off on saves; `bash` as a user that can't change the agent; page data checked before it is stored.
- **Cost control:** hidden daily cap per user, cap on model calls per run in the outbound rule, cache-friendly prompt order (context block last), Cloudflare usage notifications, a spend limit on the Anthropic account, and a switch that pauses new runs.
- **Operations:** a tested restore, from git history and from a snapshot; remote config for the model and the daily cap; a license review (Apache-2.0 notices, hledger GPL, poppler GPL).

## Build order

| Phase | Time | Work | Done when |
| --- | --- | --- | --- |
| 0 · Groundwork | ≈ 2 weeks | Eval set and the desktop's baseline; move the agent host out of the desktop package into its own, then delete desktop, website, docs, demos from the fork; Cloudflare dev environment; a spike: one bookkeeper with a sandbox in the EU jurisdiction running the agent host, cloning from and pushing to an Artifacts repo and reaching AI Gateway through the outbound rule; run the evals on Sonnet and Haiku, with GLM-5.3-Flash and Kimi K2.6 on Workers AI for comparison | the agent host and extension tests pass, `wrangler deploy` works in dev, the spike's first-reply and save times and the baseline numbers exist |
| 1 · Cloud agent | ≈ 3 weeks | worker and bookkeeper (chat relay and replay, chats, saves with checks, pages, uploads); sign-in and the directory tables; sandbox image with the agent host's cloud entry | Evals match the desktop, concurrent chats never lose a change, cross-user tests pass |
| 2 · App on TestFlight | ≈ 4–6 weeks | Sign in, chat, attachments, share extension, Transactions, Net worth, delete account | You keep your own books on the phone for two weeks |
| 3 · Launch | ≈ 2–3 weeks | payments and export as planned above, the daily cap in the directory, consent screen, privacy label, legal entity, App Review, prod environment | Live, first renewal goes through |

## Decisions for you

1. **Sonnet 5.5 or Haiku?** One Claude model for everything at launch. With EU VAT, Sonnet 5.5 about breaks even at $9.99 (0%); Haiku (42%) or $12.99 (20%) fixes it, if Haiku passes the evals against the desktop's baseline. Haiku 4.5 retires in mid-October 2026, so this means Haiku 5.5 once it ships.
2. **Which legal entity publishes the mobile app?** Apple and every processor agreement need a company.

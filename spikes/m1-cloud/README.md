# M1 cloud spike

Throwaway code that checks the cloud half of [BLUEPRINT.md](../../BLUEPRINT.md) on a real Cloudflare account, as planned in [BUILD-PLAN.md](../../BUILD-PLAN.md) (M1). It is not part of the npm workspaces, the tests or the lint; nothing here ships.

What runs: one EU Durable Object per set of books (`Bookkeeper`) hosting Pi Durable through Cloudflare's Pi harness, one session per chat, calling DeepSeek V4.1 Flash on Fireworks through AI Gateway. Its tools run in the books' container (`ctx.container`, Sandbox SDK 1.0) on a clone of the books' Artifacts repo. The container has no internet; its pushes to Artifacts go through the Worker, which adds a short-lived repo token, so no token ever enters the sandbox.

## Accounts and safety

The spike runs on the **Personal** account, until it moves to the account that will host the app. Everything is set up so it can be removed or moved without touching anything else:

- **One account, enforced.** `.env` (gitignored) pins `CLOUDFLARE_ACCOUNT_ID` and the expected account name. The token is an account-owned token of that account, so it can't see any other account, and every infra script stops unless the token reaches exactly that account under that name.
- **One prefix.** Every resource is named `a24-m1-*` (`infra/names.ts`). Teardown only lists and deletes names with that prefix, so the account's other Workers and data are never touched.
- **No account in the code.** `wrangler.jsonc` has no `account_id`; the D1, R2 and Artifacts names don't depend on the account.
- **No secrets in the repo or the sandbox.** The Fireworks key is stored in AI Gateway (BYOK), the Artifacts tokens are minted per request by the Worker, and the Worker's only secret is `SPIKE_TOKEN`, which guards the public workers.dev URL.
- **Test data only.** The books are invented (`src/seed.ts`); nothing from a real workspace goes in.
- **Spend is capped by design.** Fireworks bills prepaid credit; the gateway rate-limits to 120 requests a minute; containers stop when idle.

What it creates: Worker `a24-m1-spike` with its Durable Objects and container application, container images `a24-m1-spike-*`, D1 `a24-m1-directory` (EU), R2 `a24-m1-uploads` (EU), Artifacts namespace `a24-m1-books` (EU), Secrets Store `a24-m1-secrets`, AI Gateway `a24-m1-gateway` and custom provider `a24-m1-fireworks`.

## Run

```sh
cd spikes/m1-cloud
npm install
# .env: CLOUDFLARE_API_TOKEN, plus SPIKE_URL and SPIKE_TOKEN after the first deploy
npm run up                 # create the resources (idempotent)
npm run secret             # set SPIKE_TOKEN on the Worker
npm run deploy             # build the image (Docker running) and deploy
npm run measure -- all     # or one step: init, chats, crash, forcepush, photo, status
npm run tail               # live logs
```

## Clean up

```sh
npm run down               # dry run: lists every a24-m1-* resource
npm run down -- --yes      # deletes them, then lists again to prove nothing is left
```

Then delete the `a24-m1-spike` API token in the dashboard (Manage Account → Account API Tokens).

## Move to the hosting account

Nothing in the spike holds data worth keeping, so moving is a fresh setup plus a cleanup, never a migration:

1. In the new account, create an account-owned token with the same permissions.
2. Point `.env` at it: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `A24_EXPECTED_ACCOUNT_NAME`.
3. `npm run up`, `npm run secret`, `npm run deploy`.
4. Point `.env` back at Personal and run `npm run down -- --yes`, then delete the Personal token.

Fireworks key: the gateway stores a copy, so rotating the key at Fireworks means running `up` again after removing the old provider key (or rotating it in the dashboard).

// Runs before every wrangler command: stops unless the .env token reaches only the pinned account.
// Without this, an empty CLOUDFLARE_API_TOKEN would let wrangler fall back to its OAuth login and its account.
import { guardAccount } from "./cf.ts";

await guardAccount();

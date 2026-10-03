// The spike's Worker: checks the spike token, then hands /books/:id/... to that books' bookkeeper,
// a Durable Object pinned to the EU.

import { type Env } from "./bookkeeper.ts";

export { ArtifactsGateway, Bookkeeper } from "./bookkeeper.ts";

function authorized(request: Request, env: Env): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.SPIKE_TOKEN}`;
  if (!env.SPIKE_TOKEN || header.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < header.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });
    const match = new URL(request.url).pathname.match(/^\/books\/([a-z0-9-]{1,40})(\/.*)?$/);
    if (!match) return new Response("Not found", { status: 404 });
    const stub = env.BOOKKEEPER.jurisdiction("eu").getByName(match[1]!);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

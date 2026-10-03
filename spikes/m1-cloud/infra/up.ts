// Creates the spike's Cloudflare resources, idempotently: D1, R2 and an Artifacts namespace in the EU,
// a Secrets Store, and an AI Gateway with Fireworks as a custom provider whose key lives in the gateway.
// Run: npm run up   (the Worker itself is deployed with `npm run deploy`)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cf, guardAccount } from "./cf.ts";
import { assertOwned, byokSecretName, FIREWORKS_BASE_URL, NAMES } from "./names.ts";

type Named = { id?: string; uuid?: string; name?: string; namespace?: string; slug?: string };

function fireworksKey(): string {
  if (process.env.FIREWORKS_API_KEY) return process.env.FIREWORKS_API_KEY;
  // Reuse the key the evals already hold, without printing it.
  const line = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../packages/evals/.env"), "utf8")
    .split("\n")
    .find((l: string) => l.startsWith("FIREWORKS_API_KEY="));
  const key = line?.slice("FIREWORKS_API_KEY=".length).trim();
  if (!key) throw new Error("No FIREWORKS_API_KEY in the environment or packages/evals/.env");
  return key;
}

async function d1(): Promise<string> {
  assertOwned(NAMES.d1);
  const list = await cf<Named[]>("GET", `/accounts/{account}/d1/database?name=${NAMES.d1}`);
  const found = list.result.find((d) => d.name === NAMES.d1);
  if (found?.uuid) return found.uuid;
  const created = await cf<Named>("POST", "/accounts/{account}/d1/database", {
    body: { name: NAMES.d1, jurisdiction: "eu" },
  });
  return created.result.uuid!;
}

async function r2(): Promise<void> {
  assertOwned(NAMES.r2);
  const headers = { "cf-r2-jurisdiction": "eu" };
  const list = await cf<{ buckets: Named[] }>("GET", "/accounts/{account}/r2/buckets", { headers });
  if (list.result.buckets.some((b) => b.name === NAMES.r2)) return;
  await cf("POST", "/accounts/{account}/r2/buckets", { body: { name: NAMES.r2 }, headers });
}

async function artifacts(): Promise<void> {
  assertOwned(NAMES.artifactsNamespace);
  const got = await cf<Named>("GET", `/accounts/{account}/artifacts/namespaces/${NAMES.artifactsNamespace}`, {
    allow404: true,
  });
  if (got.status !== 404) return;
  await cf("POST", "/accounts/{account}/artifacts/namespaces", {
    body: { namespace: NAMES.artifactsNamespace, jurisdiction: "eu" },
  });
}

async function secretsStore(): Promise<string> {
  assertOwned(NAMES.secretsStore);
  const list = await cf<Named[]>("GET", "/accounts/{account}/secrets_store/stores");
  const found = list.result.find((s) => s.name === NAMES.secretsStore);
  if (found?.id) return found.id;
  const created = await cf<Named>("POST", "/accounts/{account}/secrets_store/stores", {
    body: { name: NAMES.secretsStore },
  });
  return created.result.id!;
}

async function gateway(storeId: string): Promise<void> {
  assertOwned(NAMES.gateway);
  const got = await cf<Named>("GET", `/accounts/{account}/ai-gateway/gateways/${NAMES.gateway}`, { allow404: true });
  const settings = {
    // Prompts carry users' books, so nothing is logged or cached.
    collect_logs: false,
    cache_ttl: 0,
    cache_invalidate_on_update: true,
    authentication: true,
    byok_only: true,
    zdr: true,
    store_id: storeId,
    rate_limiting_interval: 60,
    rate_limiting_limit: 120,
    rate_limiting_technique: "sliding",
  };
  if (got.status === 404) {
    await cf("POST", "/accounts/{account}/ai-gateway/gateways", { body: { id: NAMES.gateway, ...settings } });
  } else {
    await cf("PUT", `/accounts/{account}/ai-gateway/gateways/${NAMES.gateway}`, { body: settings });
  }
}

async function customProvider(): Promise<void> {
  assertOwned(NAMES.customProviderSlug);
  const list = await cf<Named[]>("GET", "/accounts/{account}/ai-gateway/custom-providers");
  if (list.result.some((p) => p.slug === NAMES.customProviderSlug)) return;
  await cf("POST", "/accounts/{account}/ai-gateway/custom-providers", {
    body: {
      name: "Fireworks (a24 M1 spike)",
      slug: NAMES.customProviderSlug,
      base_url: FIREWORKS_BASE_URL,
      enable: true,
    },
  });
}

async function providerKey(storeId: string): Promise<void> {
  const path = `/accounts/{account}/ai-gateway/gateways/${NAMES.gateway}/provider_configs`;
  const list = await cf<{ provider_slug: string; alias: string }[]>("GET", path);
  const slug = NAMES.customProviderSlug;
  if (list.result.some((c) => c.provider_slug === slug && c.alias === NAMES.byokAlias)) return;
  // AI Gateway finds the key by this secret name, so the secret comes first.
  const secrets = `/accounts/{account}/secrets_store/stores/${storeId}/secrets`;
  const existing = await cf<{ id: string; name: string }[]>("GET", secrets);
  let secretId = existing.result.find((x) => x.name === byokSecretName())?.id;
  if (!secretId) {
    const created = await cf<{ id: string }[]>("POST", secrets, {
      body: [{ name: byokSecretName(), value: fireworksKey(), scopes: ["ai_gateway"], comment: "a24 M1 spike" }],
    });
    secretId = created.result[0]!.id;
  }
  await cf("POST", path, {
    body: { provider_slug: slug, alias: NAMES.byokAlias, default_config: true, secret_id: secretId },
  });
}

await guardAccount();
const d1Id = await d1();
console.log(`D1 ${NAMES.d1} (eu): ${d1Id}`);
try {
  await r2();
  console.log(`R2 ${NAMES.r2} (eu)`);
} catch (error) {
  // R2 must be enabled once in the dashboard; M1 doesn't need it, so carry on without it.
  console.warn(`R2 skipped: ${(error as Error).message}`);
}
await artifacts();
console.log(`Artifacts namespace ${NAMES.artifactsNamespace} (eu)`);
const storeId = await secretsStore();
console.log(`Secrets Store ${NAMES.secretsStore}: ${storeId}`);
await gateway(storeId);
console.log(`AI Gateway ${NAMES.gateway} (authenticated, BYOK only, no logs, no cache)`);
await customProvider();
console.log(`Custom provider custom-${NAMES.customProviderSlug} → ${FIREWORKS_BASE_URL}`);
await providerKey(storeId);
console.log(`Fireworks key stored in the gateway as ${byokSecretName()}`);
console.log(`\nPut this in wrangler.jsonc if it differs: d1 database_id = ${d1Id}`);

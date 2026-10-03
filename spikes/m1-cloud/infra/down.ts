// Lists, and with --yes deletes, every resource of this spike in the pinned account.
// Only names starting with "a24-m1" are touched; anything else in the account is never listed or deleted.
// Run: npm run down          (dry run: prints what it would delete)
//      npm run down -- --yes (deletes, then lists again to prove nothing is left)

import { execFileSync } from "node:child_process";
import { cf, guardAccount } from "./cf.ts";
import { assertOwned, NAMES, PREFIX } from "./names.ts";

const apply = process.argv.includes("--yes");
type Item = { kind: string; name: string; remove: () => Promise<void> };

const r2Headers = { "cf-r2-jurisdiction": "eu" };
const owned = (name: string | undefined): name is string => typeof name === "string" && name.startsWith(PREFIX);

function wrangler(args: string[]): string {
  return execFileSync("npx", ["--no-install", "wrangler", ...args], { encoding: "utf8", env: process.env });
}

async function inventory(): Promise<Item[]> {
  const items: Item[] = [];

  const scripts = await cf<{ id: string }[]>("GET", "/accounts/{account}/workers/scripts");
  for (const s of scripts.result.filter((x) => owned(x.id))) {
    items.push({
      kind: "Worker (with its Durable Objects)",
      name: s.id,
      remove: async () => void (await cf("DELETE", `/accounts/{account}/workers/scripts/${s.id}?force=true`)),
    });
  }

  const apps = await cf<{ id: string; name: string }[]>("GET", "/accounts/{account}/containers/applications");
  for (const a of apps.result.filter((x) => owned(x.name))) {
    items.push({
      kind: "Container application",
      name: a.name,
      remove: async () => void (await cf("DELETE", `/accounts/{account}/containers/applications/${a.id}`)),
    });
  }

  // Images live in the account's Cloudflare registry, which only wrangler lists.
  try {
    const listed = JSON.parse(wrangler(["containers", "images", "list", "--json"])) as { name: string; tags: string[] }[];
    for (const image of listed.filter((i) => owned(i.name.split("/").pop()))) {
      for (const tag of image.tags) {
        const ref = `${image.name.split("/").pop()}:${tag}`;
        items.push({
          kind: "Container image",
          name: ref,
          remove: async () => void wrangler(["containers", "images", "delete", ref]),
        });
      }
    }
  } catch (error) {
    console.warn(`Could not list container images: ${(error as Error).message.split("\n")[0]}`);
  }

  const gw = await cf<{ id: string }>("GET", `/accounts/{account}/ai-gateway/gateways/${NAMES.gateway}`, {
    allow404: true,
  });
  if (gw.status !== 404) {
    items.push({
      kind: "AI Gateway (with its provider keys)",
      name: NAMES.gateway,
      remove: async () => {
        const path = `/accounts/{account}/ai-gateway/gateways/${NAMES.gateway}/provider_configs`;
        const configs = await cf<{ id: string }[]>("GET", path);
        for (const c of configs.result) await cf("DELETE", `${path}/${c.id}`);
        await cf("DELETE", `/accounts/{account}/ai-gateway/gateways/${NAMES.gateway}`);
      },
    });
  }

  const providers = await cf<{ id: string; slug: string }[]>("GET", "/accounts/{account}/ai-gateway/custom-providers");
  for (const p of providers.result.filter((x) => owned(x.slug))) {
    items.push({
      kind: "AI Gateway custom provider",
      name: p.slug,
      remove: async () => void (await cf("DELETE", `/accounts/{account}/ai-gateway/custom-providers/${p.id}`)),
    });
  }

  const stores = await cf<{ id: string; name: string }[]>("GET", "/accounts/{account}/secrets_store/stores");
  for (const s of stores.result.filter((x) => owned(x.name))) {
    items.push({
      kind: "Secrets Store (with its secrets)",
      name: s.name,
      remove: async () => {
        const path = `/accounts/{account}/secrets_store/stores/${s.id}/secrets`;
        const secrets = await cf<{ id: string }[]>("GET", path);
        for (const secret of secrets.result) await cf("DELETE", `${path}/${secret.id}`);
        await cf("DELETE", `/accounts/{account}/secrets_store/stores/${s.id}`);
      },
    });
  }

  const namespaces = await cf<{ namespace?: string; name?: string }[]>("GET", "/accounts/{account}/artifacts/namespaces");
  for (const n of namespaces.result.map((x) => x.namespace ?? x.name).filter(owned)) {
    items.push({
      kind: "Artifacts namespace (with its repos)",
      name: n,
      remove: async () => {
        const repos = await cf<{ name: string }[]>("GET", `/accounts/{account}/artifacts/namespaces/${n}/repos`);
        for (const r of repos.result) await cf("DELETE", `/accounts/{account}/artifacts/namespaces/${n}/repos/${r.name}`);
        await cf("DELETE", `/accounts/{account}/artifacts/namespaces/${n}`);
      },
    });
  }

  const buckets = await cf<{ buckets: { name: string }[] }>("GET", "/accounts/{account}/r2/buckets", {
    headers: r2Headers,
  }).catch(() => ({ result: { buckets: [] as { name: string }[] } }));
  for (const b of buckets.result.buckets.filter((x) => owned(x.name))) {
    items.push({
      kind: "R2 bucket, EU (emptied first)",
      name: b.name,
      remove: async () => {
        for (;;) {
          const objects = await cf<{ key: string }[]>("GET", `/accounts/{account}/r2/buckets/${b.name}/objects`, {
            headers: r2Headers,
          });
          if (objects.result.length === 0) break;
          await cf("DELETE", `/accounts/{account}/r2/buckets/${b.name}/objects`, {
            headers: r2Headers,
            body: objects.result.map((o) => o.key),
          });
        }
        await cf("DELETE", `/accounts/{account}/r2/buckets/${b.name}`, { headers: r2Headers });
      },
    });
  }

  const dbs = await cf<{ uuid: string; name: string }[]>("GET", `/accounts/{account}/d1/database?name=${PREFIX}`);
  for (const d of dbs.result.filter((x) => owned(x.name))) {
    items.push({
      kind: "D1 database",
      name: d.name,
      remove: async () => void (await cf("DELETE", `/accounts/{account}/d1/database/${d.uuid}`)),
    });
  }

  return items;
}

await guardAccount();
const items = await inventory();
if (items.length === 0) {
  console.log(`Nothing named ${PREFIX}* is left in this account.`);
  process.exit(0);
}
for (const item of items) {
  assertOwned(item.name);
  console.log(`${apply ? "Deleting" : "Would delete"}: ${item.kind}: ${item.name}`);
  if (apply) await item.remove();
}
if (!apply) {
  console.log("\nDry run. Run `npm run down -- --yes` to delete these.");
} else {
  const left = await inventory();
  console.log(left.length === 0 ? `\nDone: nothing named ${PREFIX}* is left.` : `\nStill there: ${left.map((i) => i.name).join(", ")}`);
}

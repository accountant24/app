// A small Cloudflare API client that refuses to run against any account but the pinned one.
// Credentials come from the gitignored .env (node --env-file=.env).

const API = "https://api.cloudflare.com/client/v4";

export type CfResponse<T> = { success: boolean; result: T; errors: { code: number; message: string }[] };

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; fill it in spikes/m1-cloud/.env`);
  return value;
}

export const accountId = () => env("CLOUDFLARE_ACCOUNT_ID");

export async function cf<T>(
  method: string,
  path: string,
  init: { body?: unknown; headers?: Record<string, string>; allow404?: boolean } = {},
): Promise<CfResponse<T> & { status: number }> {
  const response = await fetch(`${API}${path.replace("{account}", accountId())}`, {
    method,
    headers: {
      Authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let json: CfResponse<T>;
  try {
    json = JSON.parse(text) as CfResponse<T>;
  } catch {
    json = { success: response.ok, result: text as T, errors: [] };
  }
  if (!json.success && !(init.allow404 && response.status === 404)) {
    throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(json.errors ?? text)}`);
  }
  return { ...json, status: response.status };
}

/**
 * Stops unless the token reaches exactly the pinned account and that account has the expected name.
 * Every infra script calls this before anything else.
 */
export async function guardAccount(): Promise<void> {
  const expectedName = env("A24_EXPECTED_ACCOUNT_NAME");
  const account = await cf<{ id: string; name: string }>("GET", "/accounts/{account}");
  if (account.result.name !== expectedName) {
    throw new Error(`Account ${accountId()} is "${account.result.name}", expected "${expectedName}". Stopping.`);
  }
  const visible = await cf<{ id: string; name: string }[]>("GET", "/accounts");
  const others = visible.result.filter((a) => a.id !== accountId());
  if (others.length > 0) {
    throw new Error(
      `The token also reaches ${others.map((a) => a.name).join(", ")}. Use an account-owned token for "${expectedName}" only.`,
    );
  }
  console.log(`Account: ${account.result.name} (${accountId()})`);
}

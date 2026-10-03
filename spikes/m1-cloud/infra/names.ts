// Every Cloudflare resource this spike creates, named in one place.
// Every name starts with PREFIX, and teardown refuses to touch anything that doesn't.

export const PREFIX = "a24-m1";

export const NAMES = {
  worker: `${PREFIX}-spike`,
  d1: `${PREFIX}-directory`,
  r2: `${PREFIX}-uploads`,
  artifactsNamespace: `${PREFIX}-books`,
  gateway: `${PREFIX}-gateway`,
  // AI Gateway addresses a custom provider as `custom-<slug>`.
  customProviderSlug: `${PREFIX}-fireworks`,
  byokAlias: "default",
  secretsStore: `${PREFIX}-secrets`,
} as const;

export const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference";

/**
 * The Secrets Store secret AI Gateway reads for BYOK: `{gateway}_{provider}_{alias}`. For a custom provider the
 * provider part is the bare slug: a key stored under `custom-<slug>` is ignored (found in the M1 spike).
 */
export const byokSecretName = () => `${NAMES.gateway}_${NAMES.customProviderSlug}_${NAMES.byokAlias}`;

export function assertOwned(name: string): void {
  if (!name.startsWith(PREFIX)) throw new Error(`Refusing to touch "${name}": it doesn't start with "${PREFIX}".`);
}

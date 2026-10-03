// DeepSeek V4.1 Flash on Fireworks, reached through AI Gateway's custom provider.
//
// agents/models/pi-ai (`createAI`) only routes AI Gateway's built-in providers and rejects `custom-*` slugs,
// and the gateway's universal endpoint (what `env.AI.gateway(id).run` posts to) answers 502 for a custom
// provider. So this is a small pi-ai provider of our own: pi-ai's Anthropic Messages client, posting to the
// gateway's provider-specific URL with a gateway token that can only run requests. The Fireworks key stays
// in the gateway (BYOK); the Worker never holds it.

import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ProviderStreams } from "@earendil-works/pi-ai";

export const PROVIDER_ID = "a24-fireworks";

// The client posts to `${baseUrl}/v1/messages`; gatewayFetch keeps only the path after this base.
const PLACEHOLDER_BASE = "https://ai-gateway.invalid/fireworks";

export type ModelEnv = {
  AI: Ai;
  GATEWAY_ID: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  GATEWAY_RUN_TOKEN: string;
};

// Headers the gateway or the vendor must not get from us: auth is the gateway's job.
const DROPPED = new Set(["x-api-key", "authorization", "host", "content-length"]);

function gatewayFetch(env: ModelEnv): typeof fetch {
  let base: Promise<string> | undefined;
  return async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const endpoint = request.url.slice(PLACEHOLDER_BASE.length + 1);
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!DROPPED.has(key.toLowerCase())) headers.set(key, value);
    });
    headers.set("cf-aig-authorization", `Bearer ${env.GATEWAY_RUN_TOKEN}`);
    base ??= env.AI.gateway(env.GATEWAY_ID).getUrl(env.MODEL_PROVIDER as never);
    return fetch(`${await base}/${endpoint}`, {
      method: request.method,
      headers,
      body: await request.text(),
      signal: request.signal,
    });
  };
}

function viaGateway(api: ProviderStreams, env: ModelEnv): ProviderStreams {
  const fetch = gatewayFetch(env);
  return {
    stream: (model, context, options) => api.stream(model, context, { ...options, fetch }),
    streamSimple: (model, context, options) => api.streamSimple(model, context, { ...options, fetch }),
  };
}

export function fireworksProvider(env: ModelEnv) {
  return createProvider({
    id: PROVIDER_ID,
    name: "Fireworks via AI Gateway",
    baseUrl: PLACEHOLDER_BASE,
    auth: {
      apiKey: {
        name: "AI Gateway BYOK",
        // Any non-empty key; gatewayFetch drops it and the gateway adds the stored one.
        resolve: async () => ({ auth: { apiKey: "byok" }, source: "AI Gateway" }),
      },
    },
    models: [
      {
        id: env.MODEL_ID,
        name: "DeepSeek V4.1 Flash",
        api: "anthropic-messages",
        provider: PROVIDER_ID,
        baseUrl: PLACEHOLDER_BASE,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        compat: {
          sendSessionAffinityHeaders: true,
          supportsEagerToolInputStreaming: false,
          supportsCacheControlOnTools: false,
          supportsLongCacheRetention: false,
        },
      },
    ],
    api: { "anthropic-messages": viaGateway(anthropicMessagesApi(), env) },
  } as Parameters<typeof createProvider>[0]);
}

// Pure conversion of a finished pi session into what the report reads: the
// transcript as Turn[] (the report's trace format), token usage summed over
// every model call, and the dollar cost derived from it.

import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

export type Turn = {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  name?: string;
  thinking?: string;
};

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** Subset of cache_creation written with 1-hour retention (billed at 2× input). */
  cache_creation_1h_input_tokens: number;
};

export type RunSummary = {
  usage: UsageTotals;
  /** Served model ids, in first-seen order (more than one means a mid-run switch). */
  models: string[];
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  /** Stop reason of the last model call. */
  stopReason: string;
  /** Text of the last assistant message. */
  lastReply: string;
  /** Error messages pi recorded on assistant messages (provider failures). */
  errors: string[];
};

const text = (parts: { type: string; text?: string }[]) =>
  parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

export function toTranscript(systemPrompt: string, messages: Message[]): Turn[] {
  const turns: Turn[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      const parts = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
      const images = parts.filter((p) => p.type === "image").length;
      turns.push({ role: "user", content: text(parts) + (images ? `\n\n[${images} image(s) attached]` : "") });
    } else if (m.role === "assistant") {
      let thinking = m.content
        .filter((p) => p.type === "thinking")
        .map((p) => (p as { thinking: string }).thinking)
        .join("\n");
      // Thinking rides on the first turn this message produces: its text, or
      // else its first tool call.
      const said = text(m.content);
      if (said || !m.content.some((p) => p.type === "toolCall")) {
        turns.push({ role: "assistant", content: said, ...(thinking ? { thinking } : {}) });
        thinking = "";
      }
      for (const p of m.content) {
        if (p.type !== "toolCall") continue;
        turns.push({
          role: "tool_call",
          name: p.name,
          content: JSON.stringify(p.arguments, null, 2),
          ...(thinking ? { thinking } : {}),
        });
        thinking = "";
      }
    } else if (m.role === "toolResult") {
      turns.push({
        role: "tool_result",
        name: m.toolName,
        content: (m.isError ? "[error] " : "") + text(m.content),
      });
    }
  }
  return turns;
}

const emptyUsage = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation_1h_input_tokens: 0,
});

function addUsage(total: UsageTotals, u: Usage): void {
  total.input_tokens += u.input;
  total.output_tokens += u.output;
  total.cache_read_input_tokens += u.cacheRead;
  total.cache_creation_input_tokens += u.cacheWrite;
  total.cache_creation_1h_input_tokens += u.cacheWrite1h ?? 0;
}

export function summarize(messages: Message[]): RunSummary {
  const assistants = messages.filter((m): m is AssistantMessage => m.role === "assistant");
  const usage = emptyUsage();
  const models: string[] = [];
  const errors: string[] = [];
  let toolCalls = 0;
  for (const a of assistants) {
    addUsage(usage, a.usage);
    const served = a.responseModel ?? a.model;
    if (!models.includes(served)) models.push(served);
    if (a.errorMessage) errors.push(a.errorMessage);
    toolCalls += a.content.filter((p) => p.type === "toolCall").length;
  }
  const last = assistants.at(-1);
  return {
    usage,
    models,
    modelCalls: assistants.length,
    toolCalls,
    toolErrors: messages.filter((m) => m.role === "toolResult" && m.isError).length,
    stopReason: last?.stopReason ?? "none",
    lastReply: last ? text(last.content) : "",
    errors,
  };
}

/** First-party list prices, $ per million tokens. */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** Dollar cost of `usage` on `model`: cache reads at 0.1× input, 5-minute
 *  cache writes at 1.25×, 1-hour writes at 2×. Throws on an unpriced model so
 *  a missing rate can never show up as a free run. */
export function costUsd(model: string, usage: UsageTotals): number {
  const price = PRICES[model.replace(/-\d{8}$/, "")];
  if (!price) throw new Error(`no price for model ${model}`);
  const write1h = usage.cache_creation_1h_input_tokens;
  const write5m = usage.cache_creation_input_tokens - write1h;
  const inputEquivalent =
    usage.input_tokens + usage.cache_read_input_tokens * 0.1 + write5m * 1.25 + write1h * 2;
  return (inputEquivalent * price.in + usage.output_tokens * price.out) / 1_000_000;
}

// Pure conversion of a finished pi session into what the report reads: the
// transcript as Turn[] (the report's trace format), token usage summed over
// every model call, and the dollar cost pi priced each call at.

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
  /** Dollar cost pi computed per call from its model catalog prices, summed. */
  costUsd: number;
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
  let cost = 0;
  for (const a of assistants) {
    addUsage(usage, a.usage);
    cost += a.usage.cost?.total ?? 0;
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
    costUsd: cost,
  };
}

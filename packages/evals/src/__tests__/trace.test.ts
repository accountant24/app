import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { summarize, toTranscript } from "../trace";

const usage = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  total: number,
  cacheWrite1h?: number,
) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  ...(cacheWrite1h === undefined ? {} : { cacheWrite1h }),
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
});

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    role: "assistant",
    content,
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-5",
    usage: usage(10, 20, 100, 50, 0.01),
    stopReason: "stop",
    timestamp: 0,
    ...extra,
  }) as unknown as Message;

const MESSAGES: Message[] = [
  {
    role: "user",
    content: [
      { type: "text", text: "Paid cash from my wallet." },
      { type: "image", data: "x", mimeType: "image/png" },
    ],
    timestamp: 0,
  },
  assistant(
    [
      { type: "thinking", thinking: "Need the payee history." },
      { type: "toolCall", id: "1", name: "query", arguments: { report: "reg" } },
    ],
    { responseModel: "claude-sonnet-5-20260901" },
  ),
  {
    role: "toolResult",
    toolCallId: "1",
    toolName: "query",
    content: [{ type: "text", text: "no results" }],
    isError: false,
    timestamp: 0,
  },
  assistant([{ type: "toolCall", id: "2", name: "bash", arguments: { command: "false" } }], {
    usage: usage(5, 5, 10, 0, 0.002, 0),
  }),
  {
    role: "toolResult",
    toolCallId: "2",
    toolName: "bash",
    content: [{ type: "text", text: "exit 1" }],
    isError: true,
    timestamp: 0,
  },
  assistant([{ type: "text", text: "Logged $23.47 at Green Basket Market." }]),
  { role: "user", content: "Thanks", timestamp: 0 },
  assistant([{ type: "text", text: "You're welcome." }], { usage: usage(1, 2, 3, 4, 0.0005, 4) }),
];

describe("toTranscript()", () => {
  test("should turn the conversation into report turns, one per tool call and result", () => {
    expect(toTranscript("SYSTEM", MESSAGES)).toEqual([
      { role: "system", content: "SYSTEM" },
      { role: "user", content: "Paid cash from my wallet.\n\n[1 image(s) attached]" },
      { role: "tool_call", name: "query", content: '{\n  "report": "reg"\n}', thinking: "Need the payee history." },
      { role: "tool_result", name: "query", content: "no results" },
      { role: "tool_call", name: "bash", content: '{\n  "command": "false"\n}' },
      { role: "tool_result", name: "bash", content: "[error] exit 1" },
      { role: "assistant", content: "Logged $23.47 at Green Basket Market." },
      { role: "user", content: "Thanks" },
      { role: "assistant", content: "You're welcome." },
    ]);
  });

  test("should put thinking on the assistant's text when the message has text", () => {
    const turns = toTranscript("S", [
      assistant([
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Done." },
      ]),
    ]);
    expect(turns[1]).toEqual({ role: "assistant", content: "Done.", thinking: "hm" });
  });
});

describe("summarize()", () => {
  const s = summarize(MESSAGES);

  test("should sum token usage over every model call", () => {
    expect(s.usage).toEqual({
      input_tokens: 26,
      output_tokens: 47,
      cache_read_input_tokens: 213,
      cache_creation_input_tokens: 104,
      cache_creation_1h_input_tokens: 4,
    });
  });

  test("should sum the cost pi priced each call at", () => {
    expect(s.costUsd).toBeCloseTo(0.0225, 10);
  });

  test("should count model calls, tool calls and failed tool calls", () => {
    expect([s.modelCalls, s.toolCalls, s.toolErrors]).toEqual([4, 2, 1]);
  });

  test("should list each served model once, preferring the response model", () => {
    expect(s.models).toEqual(["claude-sonnet-5-20260901", "claude-sonnet-5"]);
  });

  test("should keep the last reply and everything the agent said", () => {
    expect(s.lastReply).toBe("You're welcome.");
    expect(s.replies).toBe("Logged $23.47 at Green Basket Market.\n\nYou're welcome.");
    expect(s.stopReason).toBe("stop");
  });

  test("should collect provider errors recorded on assistant messages", () => {
    const failed = summarize([assistant([], { stopReason: "error", errorMessage: "Rate limit reached" })]);
    expect(failed.errors).toEqual(["Rate limit reached"]);
    expect(failed.stopReason).toBe("error");
  });

  test("should report no calls for a conversation without assistant messages", () => {
    const empty = summarize([{ role: "user", content: "hi", timestamp: 0 }]);
    expect([empty.modelCalls, empty.stopReason, empty.lastReply, empty.costUsd]).toEqual([0, "none", "", 0]);
  });
});

// Whether the agent stopped to ask instead of acting: the runner then sends
// the case's auto-reply once.

/** Tools that change the books; a turn that used none and ends in a question is a clarification. */
const WRITE_TOOLS = new Set([
  "add_transactions",
  "add_balance_assertions",
  "add_prices",
  "bulk_edit_transactions",
  "edit",
  "write",
]);

export function askedInsteadOfActing(turnMessages: { role: string; content?: unknown }[]): boolean {
  const assistants = turnMessages.filter((m) => m.role === "assistant");
  const calls = assistants.flatMap((m) =>
    (m.content as { type: string; name?: string }[]).filter((p) => p.type === "toolCall").map((p) => p.name),
  );
  if (calls.some((name) => name && WRITE_TOOLS.has(name))) return false;
  const last = assistants.at(-1)?.content as { type: string; text?: string }[] | undefined;
  const reply = (last ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  return reply.slice(-300).includes("?");
}

import { describe, expect, test } from "vitest";
import { askedInsteadOfActing } from "../ask";

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (name: string) => ({ role: "assistant", content: [{ type: "toolCall", name }] });

describe("askedInsteadOfActing()", () => {
  test("should be true when the turn ends in a question and nothing was written", () => {
    expect(askedInsteadOfActing([{ role: "user" }, call("query"), say("Which cash account did you pay from?")])).toBe(
      true,
    );
  });

  test("should be false when the turn wrote to the books, even if it ends in a question", () => {
    expect(askedInsteadOfActing([call("add_transactions"), say("Done. Anything else?")])).toBe(false);
    expect(askedInsteadOfActing([call("edit"), say("Updated memory. Want more?")])).toBe(false);
  });

  test("should be false when the turn ends without a question", () => {
    expect(askedInsteadOfActing([call("query"), say("You spent $417.40 on food in August.")])).toBe(false);
  });

  test("should only look at the end of a long reply for the question mark", () => {
    const early = `Is this right? ${"x".repeat(400)}`;
    expect(askedInsteadOfActing([say(early)])).toBe(false);
  });

  test("should be false when there is no assistant message", () => {
    expect(askedInsteadOfActing([{ role: "user" }])).toBe(false);
  });
});

import { describe, expect, test } from "vitest";
import { bashJournalWrites, writesJournal } from "../guard";

describe("writesJournal()", () => {
  describe("reads pass", () => {
    test.each([
      "hledger -f ledger/main.journal bal Assets",
      "cat ledger/2026/09.journal | grep Deli",
      "grep -n Parkside ledger/2026/*.journal",
      "hledger -f ledger/main.journal print > /tmp/out.txt",
      "cp ledger/2026/09.journal /tmp/backup.txt",
      "python3 -c \"print(open('ledger/2026/09.journal').read())\"",
      "rm -rf /tmp/scratch",
      // Path concatenation inside open() is not a write mode (a real DeepSeek run).
      "python3 -c \"for f in ['07','08','09']:\n    for l in open('ledger/2026/'+f+'.journal'):\n        print(f, repr(l))\"",
      "python3 -c \"f='$f'\nfor i,l in enumerate(open('ledger/2026/'+f+'.journal'),1):\n    print(i, repr(l))\"",
    ])("should allow %s", (command) => {
      expect(writesJournal(command)).toBe(false);
    });
  });

  describe("writes fail", () => {
    test.each([
      "echo '2026-10-02 * X' >> ledger/2026/10.journal",
      "printf x > ledger/main.journal",
      "sed -i '' 's/Corner Deli/Sal/' ledger/2026/07.journal",
      "perl -pi -e 's/a/b/' ledger/2026/08.journal",
      "rm ledger/2026/09.journal",
      "rm -rf ledger",
      "mv ledger/2026/09.journal /tmp/",
      "truncate -s 0 ledger/main.journal",
      "cp /tmp/x ledger/2026/09.journal",
      "tee ledger/2026/09.journal < /tmp/x",
      "python3 -c \"open('ledger/2026/09.journal','w').write('')\"",
      "python3 -c \"f=open('ledger/2026/09.journal', mode='a'); f.close()\"",
      "python3 -c \"open('ledger/main.journal', 'r+')\"",
      "node -e \"require('fs').writeFileSync('ledger/main.journal','')\"",
    ])("should flag %s", (command) => {
      expect(writesJournal(command)).toBe(true);
    });
  });
});

describe("bashJournalWrites()", () => {
  const call = (name: string, command: unknown) => ({ type: "toolCall", name, arguments: { command } });

  test("should return only the bash commands that write journals, in order", () => {
    const messages = [
      { role: "user", content: "delete it" },
      { role: "assistant", content: [{ type: "text", text: "Looking." }, call("bash", "cat ledger/main.journal")] },
      { role: "toolResult", content: [] },
      {
        role: "assistant",
        content: [call("bash", "rm ledger/2026/09.journal"), call("edit", "rm ledger/main.journal")],
      },
      { role: "assistant", content: [call("bash", "rm -rf ledger")] },
    ];
    expect(bashJournalWrites(messages)).toEqual(["rm ledger/2026/09.journal", "rm -rf ledger"]);
  });

  test("should skip assistant messages without structured content and calls without a command", () => {
    const messages = [
      { role: "assistant", content: "plain text" },
      { role: "assistant", content: [call("bash", undefined)] },
    ];
    expect(bashJournalWrites(messages)).toEqual([]);
  });
});

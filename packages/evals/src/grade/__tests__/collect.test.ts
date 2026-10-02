import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { collect, parsePrices, readLedger, readPrices, snapshot } from "../collect";

// Integration: real hledger and git over a throwaway workspace.

const BASE = mkdtempSync(join(tmpdir(), "a24-collect-"));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const MAIN = `commodity 1,000.00 USD
commodity 1,000.0000 VTI
account Assets:Cash:Wallet
account Expenses:Food
account Equity:Opening Balances

2026-09-01 * Opening Balance
    Assets:Cash:Wallet          100.00 USD
    Equity:Opening Balances

2026-09-14 * Farmers Market | weekly veg
    Assets:Cash:Wallet          -18.50 USD
    Expenses:Food                18.50 USD

P 2026-09-14 VTI 294.80 USD
`;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function workspace(): string {
  const ws = mkdtempSync(join(BASE, "ws-"));
  mkdirSync(join(ws, "ledger"));
  writeFileSync(join(ws, "ledger", "main.journal"), MAIN);
  writeFileSync(join(ws, "memory.md"), "- Default currency: USD.\n");
  git(ws, "init", "-q");
  git(ws, "config", "user.name", "T");
  git(ws, "config", "user.email", "t@t.invalid");
  git(ws, "config", "commit.gpgsign", "false");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "Fixture");
  return ws;
}

const append = (ws: string, text: string) => writeFileSync(join(ws, "ledger", "main.journal"), MAIN + text);

describe("readLedger()", () => {
  test("should read the transactions with payee and description split", () => {
    const ledger = readLedger(workspace());
    if ("error" in ledger) throw new Error(ledger.error);
    expect(ledger.transactions.map((t) => [t.date, t.payee, t.description])).toEqual([
      ["2026-09-01", "Opening Balance", ""],
      ["2026-09-14", "Farmers Market", "weekly veg"],
    ]);
  });

  test("should return hledger's error for a ledger that doesn't parse", () => {
    const ws = workspace();
    append(ws, "\n2026-09-20 * Broken\n    Expenses:Food   5.00 USD\n    Assets:Cash:Wallet   -4.00 USD\n");
    const ledger = readLedger(ws);
    expect("error" in ledger && ledger.error.length > 0).toBe(true);
  });
});

describe("parsePrices()", () => {
  test("should read hledger's price lines, including thousands separators and quoted symbols", () => {
    expect(parsePrices('P 2026-09-14 VTI 294.80 USD\nP 2026-09-30 "SOL2" 1,234.5 USD\nnot a price\n')).toEqual([
      { date: "2026-09-14", commodity: "VTI", amount: 294.8, in: "USD" },
      { date: "2026-09-30", commodity: "SOL2", amount: 1234.5, in: "USD" },
    ]);
  });
});

describe("readPrices()", () => {
  test("should list the ledger's market prices", () => {
    expect(readPrices(workspace())).toEqual([{ date: "2026-09-14", commodity: "VTI", amount: 294.8, in: "USD" }]);
  });

  test("should return no prices when the ledger doesn't load", () => {
    expect(readPrices(join(BASE, "nowhere"))).toEqual([]);
  });
});

describe("snapshot()", () => {
  test("should record transactions, memory, the starting commit and protected files", () => {
    const ws = workspace();
    const s = snapshot(ws, ["ledger/main.journal", "missing.txt"]);
    expect(s.transactions).toHaveLength(2);
    expect(s.memory).toBe("- Default currency: USD.\n");
    expect(s.head).toBe(git(ws, "rev-parse", "HEAD"));
    expect(s.files).toEqual({ "ledger/main.journal": MAIN, "missing.txt": null });
  });

  test("should throw when the fixture ledger doesn't load", () => {
    const ws = workspace();
    writeFileSync(join(ws, "ledger", "main.journal"), "2026-09-20 * Broken\n    A   5 USD\n    B   -4 USD\n");
    expect(() => snapshot(ws)).toThrow("fixture ledger does not load");
  });
});

describe("collect()", () => {
  test("should report an untouched workspace as unchanged and clean", () => {
    const ws = workspace();
    const before = snapshot(ws);
    const f = collect(ws, before, "2026-10-02", "Nothing to do.", []);
    expect(f).toMatchObject({
      initialCount: 2,
      checkError: undefined,
      uncommitted: [],
      commitsAdded: 0,
      historyRewritten: false,
      changedSinceFixture: false,
      replies: "Nothing to do.",
      memory: "- Default currency: USD.\n",
    });
    expect(f.final).toHaveLength(2);
  });

  test("should see a committed change and count the commits", () => {
    const ws = workspace();
    const before = snapshot(ws);
    append(ws, "\n2026-10-02 * Corner Deli\n    Assets:Cash:Wallet   -6.40 USD\n    Expenses:Food   6.40 USD\n");
    git(ws, "commit", "-qam", "Add Corner Deli");
    const f = collect(ws, before, "2026-10-02", "", []);
    expect([f.final?.length, f.commitsAdded, f.changedSinceFixture, f.uncommitted]).toEqual([3, 1, true, []]);
  });

  test("should list uncommitted changes but never attachments under files/ or pi's settings.json", () => {
    const ws = workspace();
    const before = snapshot(ws);
    mkdirSync(join(ws, "files", "2026", "10"), { recursive: true });
    writeFileSync(join(ws, "files", "2026", "10", "x.pdf"), "pdf");
    writeFileSync(join(ws, "settings.json"), "{}");
    writeFileSync(join(ws, "memory.md"), "- Default currency: USD.\n- Salary: $5,200.\n");
    const f = collect(ws, before, "2026-10-02", "", []);
    expect(f.uncommitted).toEqual([" M memory.md"]);
    expect(f.changedSinceFixture).toBe(true);
  });

  test("should not count attachments alone as a change", () => {
    const ws = workspace();
    const before = snapshot(ws);
    mkdirSync(join(ws, "files"), { recursive: true });
    writeFileSync(join(ws, "files", "x.png"), "png");
    expect(collect(ws, before, "2026-10-02", "", []).changedSinceFixture).toBe(false);
  });

  test("should detect history that was reset away", () => {
    const ws = workspace();
    append(ws, "\n; second commit\n");
    git(ws, "commit", "-qam", "Second");
    const before = snapshot(ws);
    git(ws, "reset", "-q", "--hard", "HEAD~1");
    expect(collect(ws, before, "2026-10-02", "", []).historyRewritten).toBe(true);
  });

  test("should report hledger's strict-check error and an unreadable ledger", () => {
    const ws = workspace();
    const before = snapshot(ws);
    append(ws, "\n2026-10-02 * Typo\n    Assets:Cash:Walet   -1.00 USD\n    Expenses:Food   1.00 USD\n");
    const f = collect(ws, before, "2026-10-02", "", []);
    expect(f.checkError).toContain("Assets:Cash:Walet");
    expect(f.final).toHaveLength(3);
  });

  test("should list protected files whose bytes changed, and pass bash writes through", () => {
    const ws = workspace();
    const before = snapshot(ws, ["ledger/main.journal", "memory.md"]);
    rmSync(join(ws, "ledger", "main.journal"));
    const f = collect(ws, before, "2026-10-02", "", ["rm ledger/main.journal"]);
    expect(f.changedPaths).toEqual(["ledger/main.journal"]);
    expect(f.final).toBeNull();
    expect(f.bashJournalWrites).toEqual(["rm ledger/main.journal"]);
  });
});

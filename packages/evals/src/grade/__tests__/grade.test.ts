import { describe, expect, test } from "vitest";
import type { Expect } from "../../cases";
import { balanceOf, checkExpect, checkMemory, type Facts, gradeFacts } from "../grade";
import type { Transaction } from "../ledger";

const tx = (date: string, payee: string, postings: [string, number, string?][], description = ""): Transaction => ({
  date,
  payee,
  description,
  tags: [],
  postings: postings.map(([account, quantity, commodity = "USD"]) => ({
    account,
    amounts: [{ commodity, quantity }],
    tags: [],
  })),
});

const LEDGER: Transaction[] = [
  tx("2026-09-01", "Opening Balance", [
    ["Assets:Cash:Wallet", 100],
    ["Equity:Opening Balances", -100],
  ]),
  tx("2026-09-14", "Farmers Market", [
    ["Assets:Cash:Wallet", -18.5],
    ["Expenses:Food", 18.5],
  ]),
  tx("2026-09-21", "Corner Deli", [
    ["Assets:Cash:Wallet", -6.4],
    ["Expenses:Food:Deli", 6.4],
  ]),
];

const MEMORY =
  "## Accounts\n- Default currency: USD.\n\n## Arrangements\n- Sparkle Cleaning: a visit every other Thursday.\n";

const facts = (over: Partial<Facts> = {}): Facts => ({
  today: "2026-10-02",
  initialCount: 3,
  final: LEDGER,
  prices: [],
  initialMemory: MEMORY,
  memory: MEMORY,
  replies: "",
  changedPaths: [],
  uncommitted: [],
  commitsAdded: 0,
  historyRewritten: false,
  changedSinceFixture: false,
  bashJournalWrites: [],
  ...over,
});

describe("balanceOf()", () => {
  test("should sum an account and its subaccounts in one commodity", () => {
    expect(balanceOf(LEDGER, "Expenses:Food", "USD")).toBeCloseTo(24.9, 10);
  });

  test("should stop at the given date", () => {
    expect(balanceOf(LEDGER, "Assets:Cash:Wallet", "USD", "2026-09-14")).toBeCloseTo(81.5, 10);
  });

  test("should ignore other commodities", () => {
    expect(balanceOf(LEDGER, "Assets:Cash:Wallet", "CAD")).toBe(0);
  });
});

describe("checkMemory()", () => {
  test("should pass when memory is unchanged and the case never asked for it", () => {
    expect(checkMemory({}, MEMORY, MEMORY)).toEqual([]);
  });

  test("should fail any change when the case never asked for one", () => {
    expect(checkMemory({}, MEMORY, `${MEMORY}- Salary: $5,200.\n`)).toEqual([
      "memory.md changed but the case never asked for it",
    ]);
  });

  test("should fail a rewritten existing line even when an addition was asked for", () => {
    const rewritten = `${MEMORY.replace("Default currency: USD.", "Currency: USD.")}- Salary: $5,200.\n`;
    expect(checkMemory({ memory: ["5,200"] }, MEMORY, rewritten)).toEqual([
      'memory.md lost or rewrote: "- Default currency: USD."',
    ]);
  });

  test("should allow rewriting a line the case lets it replace", () => {
    const corrected = MEMORY.replace("every other Thursday", "every Thursday");
    expect(
      checkMemory({ memory: ["every thursday"], memoryReplaces: ["sparkle"], memoryMaxAdded: 0 }, MEMORY, corrected),
    ).toEqual([]);
  });

  test("should fail when memory grows past its budget", () => {
    const grown = `${MEMORY}- a\n- b\n`;
    expect(checkMemory({ memory: ["a"], memoryMaxAdded: 1 }, MEMORY, grown)).toEqual([
      "memory.md grew by 2 lines, budget 1",
    ]);
  });

  test("should allow three added lines by default", () => {
    expect(checkMemory({ memory: ["c"] }, MEMORY, `${MEMORY}- a\n- b\n- c\n`)).toEqual([]);
  });

  test("should fail when an expected fact is missing, matching case-insensitively", () => {
    expect(checkMemory({ memory: ["SALARY"] }, MEMORY, `${MEMORY}- salary: $5,200.\n`)).toEqual([]);
    expect(checkMemory({ memory: ["salary"] }, MEMORY, `${MEMORY}- rent: $1,850.\n`)).toEqual([
      "memory.md lacks /salary/",
    ]);
  });
});

describe("checkExpect()", () => {
  const added = [
    ...LEDGER,
    tx("2026-10-02", "Farmers Market", [
      ["Assets:Cash:Wallet", -14.8],
      ["Expenses:Food", 14.8],
    ]),
  ];

  test("should pass when every expected transaction is present", () => {
    const expect_: Expect = {
      present: [
        {
          date: "today",
          payee: "^Farmers Market$",
          postings: [
            { account: "Assets:Cash:Wallet", amount: -14.8 },
            { account: "Expenses:Food*", amount: 14.8 },
          ],
        },
      ],
      countDelta: 1,
    };
    expect(checkExpect(expect_, facts({ final: added }))).toEqual([]);
  });

  test("should report each missing transaction", () => {
    const failures = checkExpect(
      { present: [{ payee: "^Rosie's Diner$", postings: [{ account: "Assets:Cash" }] }] },
      facts(),
    );
    expect(failures).toEqual(["missing any date payee /^Rosie's Diner$/ [Assets:Cash]"]);
  });

  test("should report a transaction that must not exist", () => {
    const failures = checkExpect(
      { absent: [{ payee: "Corner", postings: [{ account: "Assets:Cash:Wallet" }], exact: false }] },
      facts(),
    );
    expect(failures).toEqual(["unexpected any date payee /Corner/ [Assets:Cash:Wallet]"]);
  });

  test("should fail a count change outside the allowed values", () => {
    expect(checkExpect({ countDelta: 0 }, facts({ final: added }))).toEqual([
      "transaction count changed by 1, expected 0",
    ]);
    expect(checkExpect({ countDelta: [2, 3] }, facts({ final: added }))).toEqual([
      "transaction count changed by 1, expected 2 or 3",
    ]);
  });

  test("should accept any of several allowed counts", () => {
    expect(checkExpect({ countDelta: [0, 1] }, facts({ final: added }))).toEqual([]);
  });

  test("should check an account balance, optionally up to a date", () => {
    expect(
      checkExpect({ balances: [{ account: "Assets:Cash:Wallet", amount: 75.1, commodity: "USD" }] }, facts()),
    ).toEqual([]);
    expect(
      checkExpect(
        { balances: [{ account: "Assets:Cash:Wallet", amount: 100, commodity: "USD", date: "2026-09-01" }] },
        facts(),
      ),
    ).toEqual([]);
    expect(
      checkExpect({ balances: [{ account: "Assets:Cash:Wallet", amount: 80, commodity: "USD" }] }, facts()),
    ).toEqual(["balance Assets:Cash:Wallet USD is 75.1, expected 80"]);
  });

  test("should report an unreadable ledger once for any ledger check", () => {
    expect(
      checkExpect({ countDelta: 0, balances: [{ account: "A", amount: 0, commodity: "USD" }] }, facts({ final: null })),
    ).toEqual(["the final ledger could not be read"]);
  });

  test("should not complain about an unreadable ledger when no ledger check is asked for", () => {
    expect(checkExpect({ answer: ["417"] }, facts({ final: null, replies: "You spent $417.40." }))).toEqual([]);
  });

  test("should check prices by date, commodity and amount", () => {
    const prices = [{ date: "2026-09-30", commodity: "VTI", amount: 297.4, in: "USD" }];
    expect(
      checkExpect({ prices: [{ date: "2026-09-30", commodity: "VTI", amount: 297.4, in: "USD" }] }, facts({ prices })),
    ).toEqual([]);
    expect(
      checkExpect({ prices: [{ date: "2026-09-30", commodity: "VTI", amount: 297.41, in: "USD" }] }, facts({ prices })),
    ).toEqual(["missing price P 2026-09-30 VTI 297.41 USD"]);
  });

  test("should look for an answer anywhere in what the agent said", () => {
    const replies = "Your last payment covers 2026-08-20.\n\nOkay, I won't record anything.";
    expect(checkExpect({ answer: ["2026-08-20"] }, facts({ replies }))).toEqual([]);
    expect(checkExpect({ answer: ["2026-10-01"] }, facts({ replies }))).toEqual(["replies lack /2026-10-01/"]);
  });

  test("should report each protected path that changed", () => {
    expect(
      checkExpect({ unchanged: ["ledger/main.journal"] }, facts({ changedPaths: ["ledger/main.journal"] })),
    ).toEqual(["ledger/main.journal changed"]);
  });
});

describe("gradeFacts()", () => {
  test("should pass a run that is correct, saved, valid and safe", () => {
    expect(gradeFacts({ countDelta: 0 }, facts())).toEqual({
      grade: { pass: 1, correct: 1, saved: 1, valid: 1, safe: 1 },
      explanation: { pass: "ok", correct: "ok", saved: "ok", valid: "ok", safe: "ok" },
    });
  });

  test("should fail saved when changes were made but never committed", () => {
    const g = gradeFacts({}, facts({ changedSinceFixture: true, uncommitted: [" M ledger/2026/10.journal"] }));
    expect(g.grade).toEqual({ pass: 0, correct: 1, saved: 0, valid: 1, safe: 1 });
    expect(g.explanation.saved).toBe("uncommitted:  M ledger/2026/10.journal; changes were never committed");
    expect(g.explanation.pass).toBe("unsaved");
  });

  test("should pass saved when the changes were committed", () => {
    expect(gradeFacts({}, facts({ changedSinceFixture: true, commitsAdded: 1 })).grade.saved).toBe(1);
  });

  test("should fail saved when history was rewritten, even with everything committed", () => {
    const g = gradeFacts({}, facts({ changedSinceFixture: true, commitsAdded: 1, historyRewritten: true }));
    expect(g.grade.saved).toBe(0);
    expect(g.explanation.saved).toBe("git history was rewritten");
  });

  test("should fail saved when a forbidden commit was made", () => {
    const g = gradeFacts({ commit: "forbidden" }, facts({ changedSinceFixture: true, commitsAdded: 2 }));
    expect(g.grade.saved).toBe(0);
    expect(g.explanation.saved).toBe("committed 2 time(s) though told not to");
  });

  test("should pass saved when changes are left uncommitted as told", () => {
    const g = gradeFacts(
      { commit: "forbidden" },
      facts({ changedSinceFixture: true, uncommitted: [" M ledger/2026/10.journal"] }),
    );
    expect(g.grade.saved).toBe(1);
  });

  test("should fail valid with hledger's message", () => {
    const g = gradeFacts({}, facts({ checkError: "hledger: balance assertion failed" }));
    expect(g.grade).toEqual({ pass: 0, correct: 1, saved: 1, valid: 0, safe: 1 });
    expect(g.explanation.valid).toBe("hledger: balance assertion failed");
  });

  test("should fail safe and list the bash commands that wrote journals", () => {
    const g = gradeFacts({}, facts({ bashJournalWrites: ["rm ledger/2026/09.journal"] }));
    expect(g.grade).toEqual({ pass: 0, correct: 1, saved: 1, valid: 1, safe: 0 });
    expect(g.explanation.safe).toBe("journal changed through bash: rm ledger/2026/09.journal");
  });

  test("should name every failed score in the pass explanation", () => {
    const g = gradeFacts(
      { countDelta: 1 },
      facts({ checkError: "bad", bashJournalWrites: ["rm x.journal"], changedSinceFixture: true }),
    );
    expect(g.explanation.pass).toBe("incorrect, unsaved, invalid, unsafe");
  });
});

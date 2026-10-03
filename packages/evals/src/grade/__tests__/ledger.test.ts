import { describe, expect, test } from "vitest";
import type { TransactionPattern } from "../../cases";
import {
  accountMatches,
  describePattern,
  matchDistinct,
  type Posting,
  parseTransactions,
  postingMatches,
  resolveDate,
  splitHeader,
  type Transaction,
  transactionMatches,
} from "../ledger";

const amount = (commodity: string, n: number) => ({ acommodity: commodity, aquantity: { floatingPoint: n } });

const posting = (account: string, quantity: number, commodity = "USD", extra: Partial<Posting> = {}): Posting => ({
  account,
  amounts: [{ commodity, quantity }],
  tags: [],
  ...extra,
});

const txn = (over: Partial<Transaction> = {}): Transaction => ({
  date: "2026-09-26",
  payee: "Green Basket Market",
  description: "",
  tags: [],
  postings: [posting("Assets:Cash:Wallet", -23.47), posting("Expenses:Food", 23.47)],
  ...over,
});

describe("parseTransactions()", () => {
  test("should split the header into payee and description and keep amounts and tags", () => {
    const [t] = parseTransactions([
      {
        tdate: "2026-09-13",
        tdescription: "Luigi's Trattoria | dinner",
        ttags: [["trip", "toronto-2026"]],
        tpostings: [
          {
            paccount: "Assets:Bank:Harbor Checking",
            pamount: [amount("USD", -46.8)],
            ptags: [["related_file", "files/a.pdf"]],
          },
          { paccount: "Expenses:Food", pamount: [amount("USD", 46.8)] },
        ],
      },
    ]);
    expect(t).toEqual({
      date: "2026-09-13",
      payee: "Luigi's Trattoria",
      description: "dinner",
      tags: [["trip", "toronto-2026"]],
      postings: [
        {
          account: "Assets:Bank:Harbor Checking",
          tags: [["related_file", "files/a.pdf"]],
          amounts: [{ commodity: "USD", quantity: -46.8 }],
        },
        { account: "Expenses:Food", tags: [], amounts: [{ commodity: "USD", quantity: 46.8 }] },
      ],
    });
  });

  test("should read the asserted balance of a balance assertion posting", () => {
    const [t] = parseTransactions([
      {
        tdate: "2026-09-30",
        tdescription: "Balance Assertion",
        tpostings: [
          {
            paccount: "Assets:Bank:Maple Trust",
            pamount: [amount("CAD", 0)],
            pbalanceassertion: { baamount: amount("CAD", 2595.06) },
          },
        ],
      },
    ]);
    expect(t.postings[0].assertion).toEqual({ commodity: "CAD", quantity: 2595.06 });
  });

  test("should leave out the assertion when a posting has none", () => {
    const [t] = parseTransactions([
      {
        tdate: "2026-09-30",
        tdescription: "X",
        tpostings: [{ paccount: "A", pamount: [amount("USD", 1)], pbalanceassertion: null }],
      },
    ]);
    expect(t.postings[0]).not.toHaveProperty("assertion");
  });

  test("should throw when hledger's output is not a list", () => {
    expect(() => parseTransactions({ error: "x" })).toThrow("hledger print output is not a list");
  });
});

describe("splitHeader()", () => {
  test("should split on the first bar only and trim both sides", () => {
    expect(splitHeader("Harbourfront Hotel | minibar | laundry")).toEqual({
      payee: "Harbourfront Hotel",
      description: "minibar | laundry",
    });
  });

  test("should give an empty description when there is no bar", () => {
    expect(splitHeader("  Corner Deli  ")).toEqual({ payee: "Corner Deli", description: "" });
  });
});

describe("resolveDate()", () => {
  test("should return today for today", () => {
    expect(resolveDate("today", "2026-10-02")).toBe("2026-10-02");
  });

  test("should count back days across a month boundary for today-N", () => {
    expect(resolveDate("today-2", "2026-10-01")).toBe("2026-09-29");
  });

  test("should leave a plain date unchanged", () => {
    expect(resolveDate("2026-09-30", "2026-10-02")).toBe("2026-09-30");
  });
});

describe("accountMatches()", () => {
  test("should match an exact account name only", () => {
    expect(accountMatches("Expenses:Food", "Expenses:Food")).toBe(true);
    expect(accountMatches("Expenses:Food", "Expenses:Food:Groceries")).toBe(false);
  });

  test("should match the account and its subaccounts for a star pattern", () => {
    expect(accountMatches("Expenses:Food*", "Expenses:Food")).toBe(true);
    expect(accountMatches("Expenses:Food*", "Expenses:Food:Groceries")).toBe(true);
  });

  test("should not match a sibling that only shares the prefix for a star pattern", () => {
    expect(accountMatches("Expenses:Food*", "Expenses:Foodstuff")).toBe(false);
  });

  test("should match any option in a list", () => {
    expect(accountMatches(["Expenses:Travel*", "Expenses:Food*"], "Expenses:Food")).toBe(true);
    expect(accountMatches(["Expenses:Travel*", "Expenses:Food*"], "Expenses:Shopping")).toBe(false);
  });
});

describe("postingMatches()", () => {
  test("should match any amount when the pattern names only the account", () => {
    expect(postingMatches({ account: "Expenses:Food" }, posting("Expenses:Food", 99))).toBe(true);
  });

  test("should accept an amount within half a cent", () => {
    expect(
      postingMatches({ account: "Expenses:Food", amount: 23.47, commodity: "USD" }, posting("Expenses:Food", 23.474)),
    ).toBe(true);
  });

  test("should reject an amount a cent off", () => {
    expect(
      postingMatches({ account: "Expenses:Food", amount: 23.47, commodity: "USD" }, posting("Expenses:Food", 23.48)),
    ).toBe(false);
  });

  test("should reject the right amount in another commodity", () => {
    expect(
      postingMatches(
        { account: "Assets:Bank:Maple Trust", amount: -45, commodity: "CAD" },
        posting("Assets:Bank:Maple Trust", -45, "USD"),
      ),
    ).toBe(false);
  });

  test("should reject a posting on another account", () => {
    expect(postingMatches({ account: "Assets:Cash:Wallet", amount: -23.47 }, posting("Assets:Cash:Home", -23.47))).toBe(
      false,
    );
  });

  test("should match an assertion that asserts the expected balance", () => {
    const p = posting("Assets:PayPal", 0, "USD", { assertion: { commodity: "USD", quantity: 0 } });
    expect(postingMatches({ account: "Assets:PayPal", amount: 0, commodity: "USD", asserts: 0 }, p)).toBe(true);
  });

  test("should reject an assertion that asserts another balance", () => {
    const p = posting("Assets:Cash:Wallet", 0, "USD", { assertion: { commodity: "USD", quantity: 281 } });
    expect(postingMatches({ account: "Assets:Cash:Wallet", amount: 0, commodity: "USD", asserts: 280 }, p)).toBe(false);
  });

  test("should reject a plain posting when an asserted balance is expected", () => {
    expect(postingMatches({ account: "Assets:Cash:Wallet", asserts: 280 }, posting("Assets:Cash:Wallet", 0))).toBe(
      false,
    );
  });

  test("should reject an asserted balance in another commodity", () => {
    const p = posting("Assets:Bank:Maple Trust", 0, "CAD", { assertion: { commodity: "USD", quantity: 2595.06 } });
    expect(postingMatches({ account: "Assets:Bank:Maple Trust", commodity: "CAD", asserts: 2595.06 }, p)).toBe(false);
  });
});

describe("transactionMatches()", () => {
  const today = "2026-10-02";
  const base: TransactionPattern = {
    date: "2026-09-26",
    payee: "^Green Basket Market$",
    postings: [
      { account: "Assets:Cash:Wallet", amount: -23.47 },
      { account: "Expenses:Food*", amount: 23.47 },
    ],
  };

  test("should match a transaction that fits every part of the pattern", () => {
    expect(transactionMatches(base, txn(), today)).toBe(true);
  });

  test("should reject another date", () => {
    expect(transactionMatches(base, txn({ date: "2026-09-27" }), today)).toBe(false);
  });

  test("should accept any of several listed dates", () => {
    expect(
      transactionMatches({ ...base, date: ["2026-09-21", "2026-09-30"] }, txn({ date: "2026-09-30" }), today),
    ).toBe(true);
    expect(
      transactionMatches({ ...base, date: ["2026-09-21", "2026-09-30"] }, txn({ date: "2026-09-26" }), today),
    ).toBe(false);
  });

  test("should resolve a relative date against today", () => {
    expect(transactionMatches({ ...base, date: "today-6" }, txn(), today)).toBe(true);
  });

  test("should match the payee case-sensitively", () => {
    expect(transactionMatches(base, txn({ payee: "GREEN BASKET MARKET" }), today)).toBe(false);
  });

  test("should match the description case-insensitively", () => {
    expect(transactionMatches({ ...base, description: "lunch" }, txn({ description: "Lunch with Sam" }), today)).toBe(
      true,
    );
  });

  test("should reject a missing description when one is expected", () => {
    expect(transactionMatches({ ...base, description: "lunch" }, txn({ description: "" }), today)).toBe(false);
  });

  test("should require exactly the listed postings by default", () => {
    const extra = txn({ postings: [...txn().postings, posting("Expenses:Tips", 0)] });
    expect(transactionMatches(base, extra, today)).toBe(false);
  });

  test("should allow other postings when exact is false", () => {
    const extra = txn({ postings: [...txn().postings, posting("Expenses:Tips", 0)] });
    expect(transactionMatches({ ...base, exact: false }, extra, today)).toBe(true);
  });

  test("should find a required tag on the transaction or on a posting", () => {
    const onPosting = txn({
      postings: [
        posting("Assets:Cash:Wallet", -23.47, "USD", { tags: [["trip", "toronto-2026"]] }),
        posting("Expenses:Food", 23.47),
      ],
    });
    expect(transactionMatches({ ...base, tags: { trip: true } }, onPosting, today)).toBe(true);
    expect(transactionMatches({ ...base, tags: { trip: true } }, txn({ tags: [["trip", ""]] }), today)).toBe(true);
  });

  test("should match a tag value case-sensitively", () => {
    const tagged = txn({ tags: [["original_payee_name", "corner deli"]] });
    expect(transactionMatches({ ...base, tags: { original_payee_name: "^Corner Deli$" } }, tagged, today)).toBe(false);
  });

  test("should reject a transaction without a required tag", () => {
    expect(transactionMatches({ ...base, tags: { link: true } }, txn(), today)).toBe(false);
  });
});

describe("matchDistinct()", () => {
  const eq = (p: number, t: number) => p === t;

  test("should give every pattern its own item", () => {
    expect(matchDistinct([1, 1], [1, 1], eq)).toEqual([true, true]);
  });

  test("should not let two patterns share one item", () => {
    expect(matchDistinct([1, 1], [1, 2], eq)).toEqual([true, false]);
  });

  test("should reassign an early claim so a later pattern can match", () => {
    // Pattern 0 fits either item, pattern 1 only the first: a greedy match would fail pattern 1.
    const fits = (p: string, t: string) => (p === "any" ? true : p === t);
    expect(matchDistinct(["any", "a"], ["a", "b"], fits)).toEqual([true, true]);
  });

  test("should report no matches when there are no items", () => {
    expect(matchDistinct([1], [], eq)).toEqual([false]);
  });
});

describe("describePattern()", () => {
  test("should list date, payee, description and postings with assertions", () => {
    expect(
      describePattern({
        date: ["2026-09-21", "2026-09-30"],
        payee: "^Balance Assertion$",
        description: "fee",
        postings: [
          { account: "Assets:Bank:Maple Trust", amount: 0, commodity: "CAD", asserts: 2595.06 },
          { account: ["A*", "B"] },
        ],
      }),
    ).toBe(
      "2026-09-21 or 2026-09-30 payee /^Balance Assertion$/ description /fee/i [Assets:Bank:Maple Trust 0 CAD = 2595.06, A*|B]",
    );
  });

  test("should say any date when there is none", () => {
    expect(describePattern({ postings: [{ account: "Expenses:Health" }] })).toBe("any date [Expenses:Health]");
  });
});

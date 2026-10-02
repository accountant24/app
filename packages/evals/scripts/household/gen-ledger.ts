// Writes the `household` fixture workspace from data.ts, formatted the way the
// agent's own tools write entries, plus the per-case workspace overlays that
// derive from it. Rerun after changing data.ts:
//
//   npx tsx packages/evals/scripts/household/gen-ledger.ts

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { balance, CAD_PRICE, CHECKING, HARBOR_RECORDED_THROUGH, JOINT, type Tx, VTI_PRICE, world } from "./data";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(PKG, "fixtures", "household");
const CASES = join(PKG, "cases");
const TEMPLATE_ACCOUNTS = join(PKG, "fixtures", "_template", "ledger", "accounts.journal");

/** Accounts the household has beyond the stock chart, inserted under their class. */
const EXTRA_ACCOUNTS: Record<string, string[]> = {
  "account Assets:Cash  ; physical cash": [
    "account Assets:Cash:Wallet               ; Alex's wallet",
    "account Assets:Cash:Home                 ; cash jar at home",
    "account Assets:Bank:Harbor Checking      ; Alex's main checking account",
    "account Assets:Bank:Prairie Joint        ; joint account with Sam: rent and bills",
    "account Assets:Bank:Maple Trust          ; Alex's CAD account in Toronto",
    "account Assets:PayPal",
    "account Assets:Investments:Brightline    ; brokerage: monthly investment into VTI",
  ],
  "account Liabilities:Loan  ; personal loans": ["account Liabilities:Credit Card:Summit Visa"],
  "account Expenses:Uncategorized          ; transactions pending categorization": [
    "account Expenses:Household Help         ; cleaning service",
  ],
};

const MEMORY = `## Accounts
- Main account: Harbor Checking. Rent and household bills go out of the Prairie joint account shared with Sam.
- Default currency: USD.

## Rules
- PayPal purchases are two transactions: a Harbor Checking → PayPal top-up (Internal Transfer), then the PayPal payment to the merchant; both carry the same \`link\` tag.
- Unexplained cash differences go to Expenses:Uncategorized, never to equity.
- Notes go in the transaction description, never in comments.
- After every bank statement import, add a balance assertion for that account on the statement's closing date.

## Arrangements
- Sparkle Cleaning: a visit every other Thursday; each payment ($165) covers 3 visits and is made on the first visit it covers.

## Trips
- Toronto, 2026-09-28 to 2026-10-01: tag trip spending with \`trip: toronto-2026\`.
`;

function money(amount: number, commodity: string): string {
  const digits = commodity === "VTI" ? 4 : 2;
  return `${amount < 0 ? "-" : ""}${Math.abs(amount).toFixed(digits)} ${commodity}`;
}

function postingLine(account: string, amount: string): string {
  const prefix = `    ${account}`;
  const target = 69 - (amount.startsWith("-") ? 1 : 0);
  return `${prefix}${" ".repeat(Math.max(2, target - prefix.length))}${amount}`;
}

export function formatTx(t: Tx): string {
  const lines = [`${t.date} * ${t.payee}${t.note ? ` | ${t.note}` : ""}`];
  for (const [name, value] of Object.entries(t.tags ?? {}).sort(([a], [b]) => a.localeCompare(b)))
    lines.push(`    ; ${name}: ${value}`);
  const postings = [...t.postings].sort((a, b) => (a.amount < 0 ? 0 : 1) - (b.amount < 0 ? 0 : 1));
  for (const p of postings) {
    const cost = p.cost ? ` @@ ${money(p.cost.total, p.cost.commodity)}` : "";
    lines.push(postingLine(p.account, money(p.amount, p.commodity) + cost));
  }
  return lines.join("\n");
}

function assertion(date: string, account: string, amount: number): string {
  return `${date} * Balance Assertion\n${postingLine(account, "0.00 USD")} = ${amount.toFixed(2)} USD`;
}

const expense = (date: string, payee: string, amount: number, note?: string): string =>
  formatTx({
    date,
    payee,
    note,
    postings: [
      { account: CHECKING, amount: -amount, commodity: "USD" },
      { account: "Expenses:Food", amount, commodity: "USD" },
    ],
  });

function main(): void {
  const all = world();
  const recorded = all.filter((t) => !t.unrecorded);
  rmSync(join(OUT, "ledger"), { recursive: true, force: true });
  mkdirSync(join(OUT, "ledger", "2026"), { recursive: true });

  let accounts = readFileSync(TEMPLATE_ACCOUNTS, "utf8");
  for (const [anchor, extra] of Object.entries(EXTRA_ACCOUNTS)) {
    if (!accounts.includes(anchor)) throw new Error(`template anchor missing: ${anchor}`);
    accounts = accounts.replace(anchor, [anchor, ...extra].join("\n"));
  }
  writeFileSync(join(OUT, "ledger", "accounts.journal"), accounts);
  writeFileSync(
    join(OUT, "ledger", "commodities.journal"),
    ["; Commodity declarations", "commodity 1,000.00 USD", "commodity 1,000.00 CAD", "commodity 1,000.0000 VTI", ""].join("\n"),
  );
  writeFileSync(
    join(OUT, "ledger", "main.journal"),
    ["; Accountant24", "", "include commodities.journal", "include accounts.journal", "include 2026/07.journal", "include 2026/08.journal", "include 2026/09.journal", ""].join("\n"),
  );

  // Balance checkpoints Alex added after each Harbor import.
  const checkpoints: [string, string][] = [
    ["2026-07-31", CHECKING],
    ["2026-08-31", CHECKING],
    ["2026-08-31", JOINT],
    [HARBOR_RECORDED_THROUGH, CHECKING],
  ];
  const priceDates: Record<string, string> = { "07": "2026-07-31", "08": "2026-08-31", "09": HARBOR_RECORDED_THROUGH };
  for (const month of ["07", "08", "09"]) {
    const entries: [string, string][] = recorded.filter((t) => t.date.slice(5, 7) === month).map((t) => [t.date, formatTx(t)]);
    for (const [date, account] of checkpoints)
      if (date.slice(5, 7) === month) entries.push([date, assertion(date, account, balance(recorded, account, "USD", date))]);
    entries.sort(([a], [b]) => a.localeCompare(b));
    const date = priceDates[month];
    const prices = [`P ${date} VTI ${VTI_PRICE[`2026-${month}`].toFixed(2)} USD`, `P ${date} CAD ${CAD_PRICE[`2026-${month}`]} USD`];
    const body = [...entries.map(([, text]) => text), prices.join("\n")].join("\n\n");
    writeFileSync(join(OUT, "ledger", "2026", `${month}.journal`), `${body}\n`);
  }
  writeFileSync(join(OUT, "memory.md"), MEMORY);
  const september = readFileSync(join(OUT, "ledger", "2026", "09.journal"), "utf8");

  // statement-sept-handentered: the same books plus a Harvest Co-op purchase
  // Alex typed in by hand, which the September statement also lists.
  const handEntered = join(CASES, "statement-sept-handentered", "workspace", "ledger", "2026");
  mkdirSync(handEntered, { recursive: true });
  writeFileSync(join(handEntered, "09.journal"), `${september}\n${expense("2026-09-22", "Harvest Co-op", 33.45)}\n`);

  // undo-last-commit: the latest commit logged a dinner that never happened.
  const undo = join(CASES, "undo-last-commit", "commit", "ledger", "2026");
  mkdirSync(undo, { recursive: true });
  writeFileSync(join(undo, "09.journal"), `${september}\n${expense("2026-09-29", "Luigi's Trattoria", 46.8, "dinner")}\n`);

  console.log(`household: ${recorded.length} recorded of ${all.length} transactions -> ${OUT}`);
}

main();

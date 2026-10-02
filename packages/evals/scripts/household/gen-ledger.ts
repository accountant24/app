// Writes the `household` fixture workspace from data.ts, formatted the way the
// agent's own tools write entries. Rerun after changing data.ts:
//
//   npx tsx packages/evals/scripts/household/gen-ledger.ts

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { balance, LUMEN, LUMEN_RECORDED_THROUGH, STADT, type Tx, world } from "./data";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "household");
const TEMPLATE_ACCOUNTS = join(OUT, "..", "_template", "ledger", "accounts.journal");

/** Accounts the household has beyond the stock chart, inserted under their class. */
const EXTRA_ACCOUNTS: Record<string, string[]> = {
  "account Assets:Cash  ; physical cash": [
    "account Assets:Cash:Wallet               ; Alex's wallet",
    "account Assets:Cash:Home                 ; cash box at home",
    "account Assets:Bank:Lumen                ; Alex's main account (neobank)",
    "account Assets:Bank:Stadtbank            ; joint account with Sam: rent and bills",
    "account Assets:Bank:Dnipro Bank          ; Alex's UAH account in Ukraine",
    "account Assets:PayPal",
    "account Assets:Investments:Tradeview     ; broker: savings plan into VWCE",
  ],
  "account Liabilities:Loan  ; personal loans": ["account Liabilities:Credit Card:Stadtbank Visa"],
  "account Expenses:Uncategorized          ; transactions pending categorization": [
    "account Expenses:Household Help         ; cleaning service",
  ],
};

const MEMORY = `## Accounts
- Main account: Lumen. Rent and household bills go out of the joint Stadtbank account shared with Sam.
- Default currency: EUR.

## Rules
- PayPal purchases are two transactions: a Lumen → PayPal top-up (Internal Transfer), then the PayPal payment to the merchant; both carry the same \`link\` tag.
- Unexplained cash differences go to Expenses:Uncategorized, never to equity.
- Notes go in the transaction description, never in comments.
- After every bank statement import, add a balance assertion for that account on the statement's closing date.

## Arrangements
- Sparkle Cleaning: a visit every second Thursday; each payment (165 EUR) covers 3 visits and is made on the first visit it covers.

## Trips
- Kraków, 2026-09-28 to 2026-10-01: tag trip spending with \`trip: krakow-2026\`.
`;

function money(amount: number, commodity: string): string {
  const digits = commodity === "VWCE" ? 4 : 2;
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
  return `${date} * Balance Assertion\n${postingLine(account, "0.00 EUR")} = ${amount.toFixed(2)} EUR`;
}

function main(): void {
  const all = world();
  const recorded = all.filter((t) => !t.unrecorded);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "ledger", "2026"), { recursive: true });

  let accounts = readFileSync(TEMPLATE_ACCOUNTS, "utf8");
  for (const [anchor, extra] of Object.entries(EXTRA_ACCOUNTS)) {
    if (!accounts.includes(anchor)) throw new Error(`template anchor missing: ${anchor}`);
    accounts = accounts.replace(anchor, [anchor, ...extra].join("\n"));
  }
  writeFileSync(join(OUT, "ledger", "accounts.journal"), accounts);
  writeFileSync(
    join(OUT, "ledger", "commodities.journal"),
    ["; Commodity declarations", "commodity 1,000.00 EUR", "commodity 1,000.00 UAH", "commodity 1,000.00 PLN", "commodity 1,000.0000 VWCE", ""].join("\n"),
  );
  writeFileSync(
    join(OUT, "ledger", "main.journal"),
    ["; Accountant24", "", "include commodities.journal", "include accounts.journal", "include 2026/07.journal", "include 2026/08.journal", "include 2026/09.journal", ""].join("\n"),
  );

  // Balance checkpoints Alex added after each Lumen import.
  const checkpoints: [string, string][] = [
    ["2026-07-31", LUMEN],
    ["2026-08-31", LUMEN],
    ["2026-08-31", STADT],
    [LUMEN_RECORDED_THROUGH, LUMEN],
  ];
  const prices: Record<string, string[]> = {
    "07": ["P 2026-07-31 VWCE 126.40 EUR", "P 2026-07-31 UAH 0.0229 EUR"],
    "08": ["P 2026-08-31 VWCE 129.10 EUR", "P 2026-08-31 UAH 0.0228 EUR"],
    "09": ["P 2026-09-14 VWCE 131.80 EUR", "P 2026-09-14 UAH 0.0229 EUR"],
  };
  for (const month of ["07", "08", "09"]) {
    const entries: [string, string][] = recorded.filter((t) => t.date.slice(5, 7) === month).map((t) => [t.date, formatTx(t)]);
    for (const [date, account] of checkpoints)
      if (date.slice(5, 7) === month) entries.push([date, assertion(date, account, balance(recorded, account, "EUR", date))]);
    entries.sort(([a], [b]) => a.localeCompare(b));
    const body = [...entries.map(([, text]) => text), prices[month].join("\n")].join("\n\n");
    writeFileSync(join(OUT, "ledger", "2026", `${month}.journal`), `${body}\n`);
  }
  writeFileSync(join(OUT, "memory.md"), MEMORY);

  // statement-lumen-sept-handentered: the same books plus a Bio Corner purchase
  // Alex typed in by hand, which the September statement also lists.
  const handEntered = join(OUT, "..", "..", "cases", "statement-lumen-sept-handentered", "workspace", "ledger", "2026");
  mkdirSync(handEntered, { recursive: true });
  const september = readFileSync(join(OUT, "ledger", "2026", "09.journal"), "utf8");
  const bio = formatTx({ date: "2026-09-22", payee: "Bio Corner", postings: [{ account: LUMEN, amount: -33.45, commodity: "EUR" }, { account: "Expenses:Food", amount: 33.45, commodity: "EUR" }] });
  writeFileSync(join(handEntered, "09.journal"), `${september}\n${bio}\n`);

  // undo-last-commit: the latest commit logged a dinner that never happened.
  const undo = join(OUT, "..", "..", "cases", "undo-last-commit", "commit", "ledger", "2026");
  mkdirSync(undo, { recursive: true });
  const dinner = formatTx({ date: "2026-09-29", payee: "Trattoria Sole", note: "dinner", postings: [{ account: LUMEN, amount: -46.8, commodity: "EUR" }, { account: "Expenses:Food", amount: 46.8, commodity: "EUR" }] });
  writeFileSync(join(undo, "09.journal"), `${september}\n${dinner}\n`);
  console.log(`household: ${recorded.length} recorded of ${all.length} transactions -> ${OUT}`);
}

main();

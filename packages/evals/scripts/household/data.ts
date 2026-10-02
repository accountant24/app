// The made-up household behind the `household` fixture: Alex Morgan in
// Chicago, sharing a joint account with Sam. Alex has a checking account at
// Harbor Bank, the joint account at Prairie Credit Union, a credit card, a CAD
// account kept from years in Toronto, PayPal, cash and a brokerage account.
// Every person, bank, merchant and amount here is invented.
//
// `world()` is everything that happened from 2026-07-01 to 2026-09-30. The
// fixture ledger holds what Alex had recorded by mid-September; the rest only
// exists in the documents the cases attach (see gen-documents.ts).

export type Posting = { account: string; amount: number; commodity: string; cost?: { total: number; commodity: string } };

export type Tx = {
  date: string;
  payee: string;
  /** Text after ` | ` in the header. */
  description?: string;
  tags?: Record<string, string>;
  postings: Posting[];
  /** Statement line as the bank shows it, for imported transactions. */
  bank?: { source: "harbor" | "maple"; rawPayee: string; rawDescription: string };
  /** Not in the fixture ledger: happened after Alex last updated the books. */
  unrecorded?: boolean;
};

export const CHECKING = "Assets:Bank:Harbor Checking";
export const JOINT = "Assets:Bank:Prairie Joint";
export const CAD_ACCOUNT = "Assets:Bank:Maple Trust";
export const PAYPAL = "Assets:PayPal";
export const WALLET = "Assets:Cash:Wallet";
export const HOME_CASH = "Assets:Cash:Home";
export const BROKER = "Assets:Investments:Brightline";
export const CARD = "Liabilities:Credit Card:Summit Visa";

/** Harbor statements already imported into the fixture, by period. */
export const HARBOR_IMPORTED: Record<string, string> = {
  "2026-07": "files/2026/08/20260801090412.pdf",
  "2026-08": "files/2026/09/20260901083055.pdf",
  "2026-09-partial": "files/2026/09/20260915071820.pdf",
};
/** The fixture's last imported Harbor day; later Harbor activity is unrecorded. */
export const HARBOR_RECORDED_THROUGH = "2026-09-14";
/** The CAD account was last updated by hand through August. */
export const CAD_RECORDED_THROUGH = "2026-08-31";

const usd = (account: string, amount: number): Posting => ({ account, amount, commodity: "USD" });
const cad = (account: string, amount: number): Posting => ({ account, amount, commodity: "CAD" });

/** A two-posting expense (or income, with a negative amount), paid from `from`. */
function spend(date: string, payee: string, category: string, amount: number, from: string, extra: Partial<Tx> = {}): Tx {
  const commodity = from === CAD_ACCOUNT ? "CAD" : "USD";
  return {
    date,
    payee,
    postings: [
      { account: from, amount: -amount, commodity },
      { account: category, amount, commodity },
    ],
    ...extra,
  };
}

function transfer(date: string, from: string, to: string, amount: number, extra: Partial<Tx> = {}): Tx {
  return { date, payee: "Internal Transfer", postings: [usd(from, -amount), usd(to, amount)], ...extra };
}

const months = ["2026-07", "2026-08", "2026-09"] as const;
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`;

/** How Harbor Bank's statement spells each payee. */
const RAW: Record<string, string> = {
  "Brightwave Inc.": "BRIGHTWAVE INC PAYROLL",
  "City Transit": "CITY TRANSIT MONTHLY PASS",
  StreamFlix: "STREAMFLIX.COM",
  CloudBox: "CLOUDBOX STORAGE",
  "Green Basket Market": "GREEN BASKET MKT #112 CHICAGO IL",
  "Harvest Co-op": "HARVEST CO-OP LOGAN SQ",
  "Daily Grind Coffee": "DAILY GRIND COFFEE",
  "Luigi's Trattoria": "LUIGIS TRATTORIA",
  "Pho Saigon": "PHO SAIGON CHICAGO",
  "Sparkle Cleaning": "SPARKLE CLEANING SVCS",
  "Harbourfront Hotel": "HARBOURFRONT HOTEL TORONTO",
  "Internal Transfer": "ONLINE TRANSFER",
  "Chapter One Books": "CHAPTER ONE BOOKS",
  "Starlight Cinema": "STARLIGHT CINEMA",
};

const GROCERIES: Record<string, number[]> = {
  "2026-07": [64.2, 51.85, 72.4, 58.9],
  "2026-08": [61.3, 49.75, 80.15, 55.6],
  "2026-09": [67.45, 52.3, 70.8, 59.15],
};
const COOP: Record<string, number[]> = { "2026-07": [23.4, 31.1], "2026-08": [27.9, 19.6], "2026-09": [25.2, 33.45] };
const COFFEE: Record<string, number[]> = { "2026-07": [4.2, 7.8, 3.9], "2026-08": [4.6, 8.4, 4.2], "2026-09": [4.4, 7.6, 5.1] };
export const VTI_PRICE: Record<string, number> = { "2026-07": 286.4, "2026-08": 291.1, "2026-09": 294.8 };
export const CAD_PRICE: Record<string, number> = { "2026-07": 0.731, "2026-08": 0.728, "2026-09": 0.734 };

export function world(): Tx[] {
  const txs: Tx[] = [];
  txs.push({
    date: "2026-07-01",
    payee: "Opening Balance",
    postings: [
      usd(CHECKING, 1200),
      usd(JOINT, 2850),
      cad(CAD_ACCOUNT, 2500),
      usd(WALLET, 120),
      usd(HOME_CASH, 400),
      usd(BROKER, 150),
      { account: BROKER, amount: 20, commodity: "VTI", cost: { total: 5480, commodity: "USD" } },
      usd(CARD, -320.5),
      { account: "Equity:Opening Balances", amount: -9879.5, commodity: "USD" },
      { account: "Equity:Opening Balances", amount: -2500, commodity: "CAD" },
    ],
  });

  for (const m of months) {
    txs.push(spend(day(m, 1), "Brightwave Inc.", "Income:Salary", -4850, CHECKING, { description: "salary" }));
    txs.push(spend(day(m, 1), "Oakridge Property Management", "Expenses:Housing", 1850, JOINT, { description: "rent" }));
    txs.push(spend(day(m, 1), "City Transit", "Expenses:Transport", 75, CHECKING, { description: "monthly pass" }));
    txs.push(transfer(day(m, 2), CHECKING, JOINT, 1700, { description: "my share of rent and bills" }));
    txs.push(spend(day(m, 3), "Lakeside Fiber", "Expenses:Utilities", 59.99, JOINT, { description: "internet" }));
    txs.push(spend(day(m, 5), "Metro Electric", "Expenses:Utilities", 92, JOINT, { description: "electricity" }));
    txs.push(transfer(day(m, 5), CHECKING, BROKER, 300, { description: "monthly investment" }));
    const price = VTI_PRICE[m];
    txs.push({
      date: day(m, 6),
      payee: "Brightline",
      description: "monthly investment",
      postings: [
        { account: BROKER, amount: 1, commodity: "VTI", cost: { total: price, commodity: "USD" } },
        usd(BROKER, -price),
      ],
    });
    txs.push(transfer(day(m, 7), CHECKING, WALLET, 100, { description: "ATM" }));
    txs.push(spend(day(m, 10), "StreamFlix", "Expenses:Subscriptions", 15.49, CHECKING));
    txs.push(spend(day(m, 15), "CloudBox", "Expenses:Subscriptions", 2.99, CHECKING));
    [4, 11, 18, 25].forEach((d, i) => txs.push(spend(day(m, d), "Green Basket Market", "Expenses:Food", GROCERIES[m][i], CHECKING)));
    [8, 22].forEach((d, i) => txs.push(spend(day(m, d), "Harvest Co-op", "Expenses:Food", COOP[m][i], CHECKING)));
    [9, 16, 23].forEach((d, i) => txs.push(spend(day(m, d), "Daily Grind Coffee", "Expenses:Food", COFFEE[m][i], CHECKING)));
    txs.push(spend(day(m, 13), "Luigi's Trattoria", "Expenses:Food", m === "2026-08" ? 52.4 : 46.8, CHECKING, { description: "dinner" }));
    txs.push(spend(day(m, 27), "Pho Saigon", "Expenses:Food", 28.6, CHECKING, { description: "dinner" }));
    txs.push(spend(day(m, 14), "Farmers Market", "Expenses:Food", 18.5, WALLET));
    txs.push(spend(day(m, 21), "Corner Deli", "Expenses:Food", 6.4, WALLET));
    txs.push(spend(day(m, 19), "Parkside Pharmacy", "Expenses:Health", 23.8, CARD));
    // Maple Trust (CAD): a top-up from checking, help for Alex's mom in Toronto, a phone plan there.
    txs.push({
      date: day(m, 3),
      payee: "Internal Transfer",
      description: "top-up CAD account",
      postings: [
        { account: CAD_ACCOUNT, amount: 400, commodity: "CAD", cost: { total: 292, commodity: "USD" } },
        usd(CHECKING, -292),
      ],
    });
    txs.push(spend(day(m, 12), "Linda Morgan", "Expenses:Gifts & Donations", 300, CAD_ACCOUNT, { description: "for mom" }));
    txs.push(spend(day(m, 18), "Northern Mobile", "Expenses:Utilities", 45, CAD_ACCOUNT, { description: "phone plan" }));
  }

  // One-offs.
  txs.push(spend("2026-07-16", "Chapter One Books", "Expenses:Education", 24.9, CHECKING));
  txs.push(...paypalPurchase("2026-07-20", "Thrift Loop", "Expenses:Shopping", 35, "jacket"));
  txs.push(spend("2026-07-28", "Internal Transfer", CARD, 344.3, JOINT, { description: "card payment" }));
  txs.push(...paypalPurchase("2026-08-09", "Game Vault", "Expenses:Entertainment", 59.99, "board game"));
  txs.push(spend("2026-08-20", "Sparkle Cleaning", "Expenses:Household Help", 165, CHECKING, { description: "3 visits prepaid" }));
  txs.push(spend("2026-08-22", "Volt Electronics", "Expenses:Shopping", 349, CARD, { description: "headphones" }));
  txs.push(spend("2026-08-28", "Internal Transfer", CARD, 372.8, JOINT, { description: "card payment" }));
  txs.push(spend("2026-09-02", "Harbourfront Hotel", "Expenses:Travel", 412, CHECKING, { description: "Toronto, 3 nights", tags: { trip: "toronto-2026" } }));
  txs.push(spend("2026-09-12", "Starlight Cinema", "Expenses:Entertainment", 21, CHECKING));
  txs.push(spend("2026-09-28", "Internal Transfer", CARD, 23.8, JOINT, { description: "card payment" }));

  // After the last update: only in the September documents.
  txs.push(spend("2026-09-19", "Chapter One Books", "Expenses:Education", 18.5, CHECKING));
  txs.push(spend("2026-09-26", "Daily Grind Coffee", "Expenses:Food", 3.9, CHECKING));
  txs.push(spend("2026-09-06", "Maple Books Online", "Expenses:Education", 64.99, CAD_ACCOUNT, { description: "books for mom" }));
  txs.push(spend("2026-09-21", "Maple Trust", "Expenses:Financial", 4.95, CAD_ACCOUNT, { description: "monthly account fee" }));

  for (const t of txs) annotate(t);
  return txs.sort((a, b) => a.date.localeCompare(b.date) || a.payee.localeCompare(b.payee));
}

function paypalPurchase(date: string, merchant: string, category: string, amount: number, description: string): Tx[] {
  const link = `${merchant.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${date}`;
  return [
    transfer(date, CHECKING, PAYPAL, amount, { description: `PayPal top-up for ${merchant}`, tags: { link } }),
    spend(date, merchant, category, amount, PAYPAL, { description, tags: { link } }),
  ];
}

/** Mark imported/unrecorded status and statement spellings. */
function annotate(t: Tx): void {
  const checking = t.postings.find((p) => p.account === CHECKING);
  const cadPosting = t.postings.find((p) => p.account === CAD_ACCOUNT);
  if (checking && t.payee !== "Opening Balance") {
    const raw = RAW[t.payee] ?? t.payee.toUpperCase();
    t.bank = { source: "harbor", rawPayee: raw, rawDescription: checking.amount > 0 ? "DIRECT DEPOSIT" : "DEBIT CARD PURCHASE" };
    if (t.payee === "Internal Transfer") t.bank.rawDescription = t.description?.toUpperCase() ?? "TRANSFER";
    if (t.date > HARBOR_RECORDED_THROUGH) t.unrecorded = true;
    else {
      const period = t.date < "2026-08-01" ? "2026-07" : t.date < "2026-09-01" ? "2026-08" : "2026-09-partial";
      t.tags = { ...t.tags, original_payee_name: raw, related_file: HARBOR_IMPORTED[period] };
    }
  } else if (cadPosting && t.payee !== "Opening Balance") {
    t.bank = { source: "maple", rawPayee: t.payee, rawDescription: t.description ?? "" };
    // The September top-up was recorded from the checking side; the rest of September is only in the CSV.
    if (t.date > CAD_RECORDED_THROUGH) t.unrecorded = true;
  }
}

/** Balance of `account` in `commodity` over `txs` up to and including `date`. */
export function balance(txs: Tx[], account: string, commodity: string, date: string): number {
  let sum = 0;
  for (const t of txs)
    if (t.date <= date) for (const p of t.postings) if (p.account === account && p.commodity === commodity) sum += p.amount;
  return Math.round(sum * 100) / 100;
}

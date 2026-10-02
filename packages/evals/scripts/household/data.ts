// The made-up household behind the `household` fixture: Alex Morgan in Berlin,
// with a partner (Sam), a neobank account, a joint account, a credit card, a
// UAH account at a Ukrainian bank, PayPal, cash and a broker. Every name, bank,
// payee and amount here is invented.
//
// `world()` is everything that happened from 2026-07-01 to 2026-09-30. The
// fixture ledger holds what Alex had recorded by mid-September; the rest only
// exists in the statements the cases attach (see gen-documents.ts).

export type Posting = { account: string; amount: number; commodity: string; cost?: { total: number; commodity: string } };

export type Tx = {
  date: string;
  payee: string;
  note?: string;
  tags?: Record<string, string>;
  postings: Posting[];
  /** Statement line as the bank shows it, for imported transactions. */
  bank?: { source: "lumen" | "dnipro"; rawPayee: string; rawDescription: string };
  /** Not in the fixture ledger: happened after Alex last updated the books. */
  unrecorded?: boolean;
};

export const LUMEN = "Assets:Bank:Lumen";
export const STADT = "Assets:Bank:Stadtbank";
export const DNIPRO = "Assets:Bank:Dnipro Bank";
export const PAYPAL = "Assets:PayPal";
export const WALLET = "Assets:Cash:Wallet";
export const HOME_CASH = "Assets:Cash:Home";
export const BROKER = "Assets:Investments:Tradeview";
export const VISA = "Liabilities:Credit Card:Stadtbank Visa";

/** Lumen statements already imported into the fixture, by period end. */
export const LUMEN_IMPORTED: Record<string, string> = {
  "2026-07": "files/2026/08/20260801090412.pdf",
  "2026-08": "files/2026/09/20260901083055.pdf",
  "2026-09-partial": "files/2026/09/20260915071820.pdf",
};
/** The fixture's last imported Lumen day; later Lumen activity is unrecorded. */
export const LUMEN_RECORDED_THROUGH = "2026-09-14";
/** The Dnipro Bank account was last updated by hand through August. */
export const DNIPRO_RECORDED_THROUGH = "2026-08-31";

const eur = (account: string, amount: number): Posting => ({ account, amount, commodity: "EUR" });
const uah = (account: string, amount: number): Posting => ({ account, amount, commodity: "UAH" });

/** A simple two-posting expense or income, money from/to `from`. */
function spend(date: string, payee: string, category: string, amount: number, from: string, extra: Partial<Tx> = {}): Tx {
  const commodity = from === DNIPRO ? "UAH" : "EUR";
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
  return { date, payee: "Internal Transfer", postings: [eur(from, -amount), eur(to, amount)], ...extra };
}

const months = ["2026-07", "2026-08", "2026-09"] as const;
const day = (month: string, d: number) => `${month}-${String(d).padStart(2, "0")}`;

/** Card-statement spellings for payees that come from the Lumen account. */
const RAW: Record<string, string> = {
  "Brightwave GmbH": "BRIGHTWAVE GMBH GEHALT",
  BVG: "BVG ABO MONATSKARTE",
  StreamFlix: "STREAMFLIX.COM",
  CloudBox: "CLOUDBOX STORAGE",
  Frischmarkt: "FRISCHMARKT FIL.112 BERLIN",
  "Bio Corner": "BIO CORNER FRIEDRICHSHAIN",
  "Trattoria Sole": "TRATTORIA SOLE SRL",
  "Pho Lan": "PHO LAN BERLIN",
  "Kaffeebar Ost": "KAFFEEBAR OST",
  "Sparkle Cleaning": "SPARKLE CLEANING SERVICES",
  "Hotel Wawel Garden": "HOTEL WAWEL GARDEN KRAKOW",
  "Internal Transfer": "UEBERWEISUNG",
  "Buchhandlung Seitenweise": "BUCHHANDLUNG SEITENWEISE",
  "Kino Babylon Ost": "KINO BABYLON OST",
  "Apotheke am Park": "APOTHEKE AM PARK",
};

const GROCERIES: Record<string, number[]> = {
  "2026-07": [64.2, 51.85, 72.4, 58.9],
  "2026-08": [61.3, 49.75, 80.15, 55.6],
  "2026-09": [67.45, 52.3, 70.8, 59.15],
};
const BIO: Record<string, number[]> = { "2026-07": [23.4, 31.1], "2026-08": [27.9, 19.6], "2026-09": [25.2, 33.45] };
const COFFEE: Record<string, number[]> = { "2026-07": [4.2, 7.8, 3.9], "2026-08": [4.6, 8.4, 4.2], "2026-09": [4.4, 7.6, 5.1] };
const VWCE_PRICE: Record<string, number> = { "2026-07": 126.4, "2026-08": 129.1, "2026-09": 131.8 };

export function world(): Tx[] {
  const txs: Tx[] = [];
  txs.push({
    date: "2026-07-01",
    payee: "Opening Balance",
    postings: [
      eur(LUMEN, 1200),
      eur(STADT, 2850),
      uah(DNIPRO, 12500),
      eur(WALLET, 120),
      eur(HOME_CASH, 400),
      eur(BROKER, 150),
      { account: BROKER, amount: 20, commodity: "VWCE", cost: { total: 2480, commodity: "EUR" } },
      eur(VISA, -320.5),
      { account: "Equity:Opening Balances", amount: -6879.5, commodity: "EUR" },
      { account: "Equity:Opening Balances", amount: -12500, commodity: "UAH" },
    ],
  });

  for (const m of months) {
    txs.push(spend(day(m, 1), "Brightwave GmbH", "Income:Salary", -3850, LUMEN, { note: "salary" }));
    txs.push(spend(day(m, 1), "Hausverwaltung Ostpark", "Expenses:Housing", 1250, STADT, { note: "rent" }));
    txs.push(spend(day(m, 1), "BVG", "Expenses:Transport", 58, LUMEN, { note: "monthly ticket" }));
    txs.push(transfer(day(m, 2), LUMEN, STADT, 1000, { note: "my share of rent and bills" }));
    txs.push(spend(day(m, 3), "NetzPlus", "Expenses:Utilities", 39.99, STADT, { note: "internet" }));
    txs.push(spend(day(m, 5), "Stromwerk Berlin", "Expenses:Utilities", 85, STADT, { note: "electricity" }));
    txs.push(transfer(day(m, 5), LUMEN, BROKER, 200, { note: "savings plan" }));
    const price = VWCE_PRICE[m];
    txs.push({
      date: day(m, 6),
      payee: "Tradeview",
      note: "savings plan buy",
      postings: [
        { account: BROKER, amount: 1.5, commodity: "VWCE", cost: { total: +(1.5 * price).toFixed(2), commodity: "EUR" } },
        eur(BROKER, -+(1.5 * price).toFixed(2)),
      ],
    });
    txs.push(transfer(day(m, 7), LUMEN, WALLET, 100, { note: "ATM" }));
    txs.push(spend(day(m, 10), "StreamFlix", "Expenses:Subscriptions", 12.99, LUMEN));
    txs.push(spend(day(m, 15), "CloudBox", "Expenses:Subscriptions", 2.99, LUMEN));
    [4, 11, 18, 25].forEach((d, i) => txs.push(spend(day(m, d), "Frischmarkt", "Expenses:Food", GROCERIES[m][i], LUMEN)));
    [8, 22].forEach((d, i) => txs.push(spend(day(m, d), "Bio Corner", "Expenses:Food", BIO[m][i], LUMEN)));
    [9, 16, 23].forEach((d, i) => txs.push(spend(day(m, d), "Kaffeebar Ost", "Expenses:Food", COFFEE[m][i], LUMEN)));
    txs.push(spend(day(m, 13), "Trattoria Sole", "Expenses:Food", m === "2026-08" ? 52.4 : 46.8, LUMEN, { note: "dinner" }));
    txs.push(spend(day(m, 27), "Pho Lan", "Expenses:Food", 28.6, LUMEN, { note: "dinner" }));
    txs.push(spend(day(m, 14), "Wochenmarkt", "Expenses:Food", 18.5, WALLET));
    txs.push(spend(day(m, 21), "Spaeti Eck", "Expenses:Food", 6.4, WALLET));
    txs.push(spend(day(m, 19), "Apotheke am Park", "Expenses:Health", 23.8, VISA));
    // Dnipro Bank (UAH): a top-up from Lumen, support for Alex's parents, the phone plan.
    txs.push({
      date: day(m, 3),
      payee: "Internal Transfer",
      note: "top-up UAH account",
      postings: [
        { account: DNIPRO, amount: 4150, commodity: "UAH", cost: { total: 95, commodity: "EUR" } },
        eur(LUMEN, -95),
      ],
    });
    txs.push(spend(day(m, 12), "Olena Marchenko", "Expenses:Gifts & Donations", 4000, DNIPRO, { note: "for mom" }));
    txs.push(spend(day(m, 18), "Lviv Mobile", "Expenses:Utilities", 250, DNIPRO, { note: "phone plan" }));
  }

  // One-offs.
  txs.push(spend("2026-07-16", "Buchhandlung Seitenweise", "Expenses:Education", 24.9, LUMEN));
  txs.push(...paypalPurchase("2026-07-20", "Secondhand Loop", "Expenses:Shopping", 35, "jacket"));
  txs.push(spend("2026-07-28", "Internal Transfer", VISA, 344.3, STADT, { note: "card bill" }));
  txs.push(...paypalPurchase("2026-08-09", "Gamestore Online", "Expenses:Entertainment", 59.99, "board game"));
  txs.push(spend("2026-08-20", "Sparkle Cleaning", "Expenses:Household Help", 165, LUMEN, { note: "3 visits prepaid" }));
  txs.push(spend("2026-08-22", "Elektronik Haus", "Expenses:Shopping", 349, VISA, { note: "headphones" }));
  txs.push(spend("2026-08-28", "Internal Transfer", VISA, 372.8, STADT, { note: "card bill" }));
  txs.push(spend("2026-09-02", "Hotel Wawel Garden", "Expenses:Travel", 412, LUMEN, { note: "Krakow, 3 nights", tags: { trip: "krakow-2026" } }));
  txs.push(spend("2026-09-12", "Kino Babylon Ost", "Expenses:Entertainment", 21, LUMEN));
  txs.push(spend("2026-09-28", "Internal Transfer", VISA, 23.8, STADT, { note: "card bill" }));

  // After the last update: only in the September statements.
  for (const t of [
    spend("2026-09-19", "Buchhandlung Seitenweise", "Expenses:Education", 18.5, LUMEN),
    spend("2026-09-26", "Kaffeebar Ost", "Expenses:Food", 3.9, LUMEN),
  ])
    txs.push(t);

  // Dnipro Bank card purchases in September, in the CSV only.
  txs.push(spend("2026-09-06", "Kramnytsia Online", "Expenses:Shopping", 1349, DNIPRO, { note: "book order for parents" }));
  txs.push(spend("2026-09-21", "Bank fee", "Expenses:Financial", 25, DNIPRO));

  for (const t of txs) annotate(t);
  return txs.sort((a, b) => a.date.localeCompare(b.date) || a.payee.localeCompare(b.payee));
}

function paypalPurchase(date: string, merchant: string, category: string, amount: number, note: string): Tx[] {
  const link = `${merchant.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${date}`;
  return [
    transfer(date, LUMEN, PAYPAL, amount, { note: `PayPal top-up for ${merchant}`, tags: { link } }),
    spend(date, merchant, category, amount, PAYPAL, { note, tags: { link } }),
  ];
}

/** Mark imported/unrecorded status and statement spellings. */
function annotate(t: Tx): void {
  const lumen = t.postings.find((p) => p.account === LUMEN);
  const dnipro = t.postings.find((p) => p.account === DNIPRO);
  if (lumen && t.payee !== "Opening Balance") {
    const raw = RAW[t.payee] ?? t.payee.toUpperCase();
    t.bank = { source: "lumen", rawPayee: raw, rawDescription: lumen.amount > 0 ? "CREDIT TRANSFER" : "CARD PAYMENT" };
    if (t.payee === "Internal Transfer") t.bank.rawDescription = t.note?.toUpperCase() ?? "TRANSFER";
    if (t.date > LUMEN_RECORDED_THROUGH) t.unrecorded = true;
    else {
      const period = t.date < "2026-08-01" ? "2026-07" : t.date < "2026-09-01" ? "2026-08" : "2026-09-partial";
      t.tags = { ...t.tags, original_payee_name: raw, related_file: LUMEN_IMPORTED[period] };
    }
  } else if (dnipro && t.payee !== "Opening Balance") {
    t.bank = { source: "dnipro", rawPayee: t.payee === "Internal Transfer" ? "Popovnennia z kartky" : t.payee, rawDescription: t.note ?? "" };
    // The September top-up was recorded from the Lumen side; the rest of September is only in the CSV.
    if (t.date > DNIPRO_RECORDED_THROUGH && t.payee !== "Internal Transfer") t.unrecorded = true;
  }
}

/** Balance of `account` in `commodity` over `txs` up to and including `date`. */
export function balance(txs: Tx[], account: string, commodity: string, date: string): number {
  let sum = 0;
  for (const t of txs)
    if (t.date <= date) for (const p of t.postings) if (p.account === account && p.commodity === commodity) sum += p.amount;
  return Math.round(sum * 100) / 100;
}

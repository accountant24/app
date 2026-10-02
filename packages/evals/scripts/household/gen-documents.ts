// Renders the household's documents from data.ts: the Harbor statements the
// fixture already imported (so its related_file tags resolve), and the
// attachments the cases send. PDFs and PNGs go through Playwright on the local
// Chrome; CSVs are plain text. Rerun after changing data.ts:
//
//   npx tsx packages/evals/scripts/household/gen-documents.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { balance, CAD_ACCOUNT, CHECKING, HARBOR_IMPORTED, type Tx, world } from "./data";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(PKG, "fixtures", "household");
const CASES = join(PKG, "cases");

const fmt = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function harborStatement(txs: Tx[], from: string, to: string, title: string): string {
  const prev = new Date(`${from}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const opening = balance(txs, CHECKING, "USD", prev.toISOString().slice(0, 10));
  let running = opening;
  let deposits = 0;
  let withdrawals = 0;
  const rows = txs
    .filter((t) => t.date >= from && t.date <= to && t.bank?.source === "harbor")
    .map((t) => {
      const amount = t.postings.find((p) => p.account === CHECKING)!.amount;
      running = Math.round((running + amount) * 100) / 100;
      if (amount > 0) deposits += amount;
      else withdrawals -= amount;
      return `<tr><td>${mdy(t.date)}</td><td><b>${esc(t.bank!.rawPayee)}</b><br><span class="sub">${esc(t.bank!.rawDescription)}</span></td><td class="num">${amount > 0 ? fmt(amount) : ""}</td><td class="num">${amount < 0 ? fmt(-amount) : ""}</td><td class="num">${fmt(running)}</td></tr>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{font:12px/1.45 Helvetica,Arial,sans-serif;color:#17202e;margin:36px}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #0d4f8b;padding-bottom:14px}
    .logo{font-size:24px;font-weight:700;color:#0d4f8b;letter-spacing:.5px}
    h1{font-size:17px;margin:22px 0 4px} .meta{color:#5d6475}
    .sum{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0 18px;padding:12px 14px;background:#eef4fa;border-radius:6px}
    .sum b{display:block;font-size:15px}
    table{width:100%;border-collapse:collapse} th{text-align:left;color:#5d6475;font-weight:600;border-bottom:1px solid #ccd;padding:6px 4px}
    td{border-bottom:1px solid #e8ecf2;padding:6px 4px;vertical-align:top} .num{text-align:right;white-space:nowrap}
    .sub{color:#7a8193;font-size:10.5px} .foot{margin-top:24px;color:#8a90a0;font-size:10px}
  </style>
  <div class="head"><div class="logo">HARBOR BANK</div><div class="meta">Harbor Bank, N.A. · 200 W Lake St · Chicago, IL 60606</div></div>
  <h1>${title}</h1>
  <div class="meta">Alex Morgan · Everyday Checking · Account ending 4417 · ${mdy(from)} – ${mdy(to)}</div>
  <div class="sum"><div>Beginning balance<b>$${fmt(opening)}</b></div><div>Deposits<b>$${fmt(deposits)}</b></div><div>Withdrawals<b>$${fmt(withdrawals)}</b></div><div>Ending balance<b>$${fmt(running)}</b></div></div>
  <table><tr><th>Date</th><th>Description</th><th class="num">Deposits</th><th class="num">Withdrawals</th><th class="num">Balance</th></tr>${rows}</table>
  <div class="foot">Harbor Bank, N.A. is a fictional bank used for testing.</div>`;
}

function mapleCsv(txs: Tx[]): string {
  let running = balance(txs, CAD_ACCOUNT, "CAD", "2026-08-31");
  const lines = ["Date,Description,Withdrawals,Deposits,Balance"];
  for (const t of txs.filter((x) => x.date >= "2026-09-01" && x.date <= "2026-09-30" && x.postings.some((p) => p.account === CAD_ACCOUNT))) {
    const amount = t.postings.find((p) => p.account === CAD_ACCOUNT)!.amount;
    running = Math.round((running + amount) * 100) / 100;
    const desc =
      t.payee === "Internal Transfer" ? "INTL WIRE IN - HARBOR BANK NA" : t.payee === "Maple Trust" ? "MONTHLY ACCOUNT FEE" : t.payee === "Linda Morgan" ? "E-TRANSFER SENT LINDA MORGAN" : t.payee.toUpperCase();
    lines.push(`${t.date},"${desc}",${amount < 0 ? (-amount).toFixed(2) : ""},${amount > 0 ? amount.toFixed(2) : ""},${running.toFixed(2)}`);
  }
  return `${lines.join("\n")}\n`;
}

const PAYPAL_CSV = `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Balance","Transaction ID","Item Title"
"09/20/2026","14:02:11","CDT","","General Card Deposit","Completed","USD","22.00","0.00","22.00","22.00","8XK21934LM0042A","Bank deposit from Harbor Bank debit x4417"
"09/20/2026","14:02:13","CDT","Thrift Loop","Express Checkout Payment","Completed","USD","-22.00","0.00","-22.00","0.00","5RT77310GH9981B","Wool scarf, gray"
`;

const RECEIPT_STYLE = `body{margin:0;background:#e9e6df;display:flex;justify-content:center;padding:24px}
  .r{width:300px;background:#fffdf8;padding:22px 20px;font:13px/1.5 "Courier New",monospace;color:#222;box-shadow:0 2px 10px #0003;transform:rotate(-1.2deg)}
  .c{text-align:center} .row{display:flex;justify-content:space-between} hr{border:0;border-top:1px dashed #999;margin:8px 0} .big{font-size:16px;font-weight:700}`;

const GROCERY_RECEIPT = `<!doctype html><meta charset="utf-8"><style>${RECEIPT_STYLE}</style><div class="r">
  <div class="c big">GREEN BASKET MARKET</div><div class="c">Store #112 · 2650 N Milwaukee Ave<br>Chicago, IL 60647</div><hr>
  <div class="row"><span>WHOLE WHEAT BREAD</span><span>3.49</span></div><div class="row"><span>2% MILK 1 GAL</span><span>4.29</span></div>
  <div class="row"><span>GALA APPLES 2 LB</span><span>3.98</span></div><div class="row"><span>CHEDDAR 8 OZ</span><span>4.79</span></div>
  <div class="row"><span>ROMA TOMATOES</span><span>2.19</span></div><div class="row"><span>OLIVE OIL 16 OZ</span><span>4.73</span></div><hr>
  <div class="row"><span>SUBTOTAL</span><span>23.47</span></div><div class="row"><span>TAX</span><span>0.00</span></div>
  <div class="row big"><span>TOTAL</span><span>$23.47</span></div><div class="row"><span>CASH</span><span>30.00</span></div><div class="row"><span>CHANGE</span><span>6.53</span></div><hr>
  <div class="c">09/29/2026 6:42 PM · Reg 3 · Trans 4471<br>Thank you for shopping with us!</div></div>`;

const TORONTO_RECEIPT = `<!doctype html><meta charset="utf-8"><style>${RECEIPT_STYLE}</style><div class="r">
  <div class="c big">THE MAPLE TABLE</div><div class="c">88 Queens Quay W, Toronto, ON<br>HST # 81234 5678 RT0001</div><hr>
  <div class="row"><span>Pea soup</span><span>11.00</span></div><div class="row"><span>Tourtière</span><span>24.00</span></div>
  <div class="row"><span>Iced tea</span><span>5.07</span></div><hr>
  <div class="row"><span>Subtotal</span><span>40.07</span></div><div class="row"><span>HST 13%</span><span>5.21</span></div><div class="row"><span>Tip</span><span>4.52</span></div>
  <div class="row big"><span>TOTAL CAD</span><span>49.80</span></div><div class="row"><span>VISA DEBIT ****4417</span><span>49.80</span></div><hr>
  <div class="c">09/29/2026 8:15 PM · Table 12<br>Thank you, come again!</div></div>`;

const HOTEL_INVOICE = `<!doctype html><meta charset="utf-8"><style>
  body{font:12px/1.5 Georgia,serif;color:#222;margin:40px} h1{font-size:22px;letter-spacing:1px;margin:0}
  .muted{color:#666} table{width:100%;border-collapse:collapse;margin-top:18px} th,td{padding:7px 4px;border-bottom:1px solid #ddd;text-align:left} .num{text-align:right}
  .tot td{font-weight:700;border-top:2px solid #222}</style>
  <h1>HARBOURFRONT HOTEL</h1><div class="muted">245 Queens Quay W · Toronto, ON M5J 2K9 · Canada</div>
  <h2 style="font-size:15px;margin-top:26px">Folio 2026-10-0183</h2>
  <div>Guest: Alex Morgan · Room 1214 · Arrival 09/28/2026 · Departure 10/01/2026 (3 nights) · Amounts in CAD</div>
  <table><tr><th>Date</th><th>Description</th><th class="num">Amount (CAD)</th></tr>
  <tr><td>09/28/2026</td><td>Accommodation, 3 nights, king room, breakfast included</td><td class="num">565.00</td></tr>
  <tr><td>09/29/2026</td><td>Minibar</td><td class="num">24.50</td></tr>
  <tr><td>09/30/2026</td><td>Laundry service</td><td class="num">30.30</td></tr>
  <tr class="tot"><td></td><td>Total</td><td class="num">619.80</td></tr>
  <tr><td>09/02/2026</td><td>Advance deposit received</td><td class="num">−565.00</td></tr>
  <tr><td>10/01/2026</td><td>Paid at checkout, Visa Debit ****4417</td><td class="num">−54.80</td></tr>
  <tr class="tot"><td></td><td>Balance due</td><td class="num">0.00</td></tr></table>
  <p class="muted" style="margin-top:28px">Harbourfront Hotel is a fictional hotel used for testing.</p>`;

const BROKER_SCREEN = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0f1420;font:15px/1.4 -apple-system,Helvetica,sans-serif;color:#e8ecf4;width:390px}
  .top{padding:18px 18px 8px;font-weight:600;font-size:18px} .time{color:#8b93a7;font-size:12px;padding:0 18px 14px}
  .card{margin:0 12px 12px;background:#182033;border-radius:14px;padding:14px 16px}
  .row{display:flex;justify-content:space-between;margin:4px 0} .muted{color:#8b93a7;font-size:13px} .big{font-size:24px;font-weight:700}
  .up{color:#3ccf8e}</style>
  <div class="top">Brightline · Portfolio</div><div class="time">Prices as of Sep 30, 2026, 4:00 PM ET</div>
  <div class="card"><div class="muted">Total value</div><div class="big">$7,017.90</div></div>
  <div class="card"><div class="row"><b>VTI</b><b>$6,840.20</b></div><div class="row muted"><span>Total Stock Market ETF</span></div>
  <div class="row muted"><span>23 shares · $297.40</span><span class="up">+0.88%</span></div></div>
  <div class="card"><div class="row"><b>Cash</b><b>$177.70</b></div></div>`;

async function main(): Promise<void> {
  const txs = world();
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const pdf = async (html: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    await page.setContent(html);
    await page.pdf({ path, format: "Letter", printBackground: true });
  };
  const png = async (html: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    await page.setContent(html);
    await page.locator("body").screenshot({ path });
  };

  await pdf(harborStatement(txs, "2026-07-01", "2026-07-31", "Statement for July 2026"), join(FIXTURE, HARBOR_IMPORTED["2026-07"]));
  await pdf(harborStatement(txs, "2026-08-01", "2026-08-31", "Statement for August 2026"), join(FIXTURE, HARBOR_IMPORTED["2026-08"]));
  await pdf(harborStatement(txs, "2026-09-01", "2026-09-14", "Activity month to date"), join(FIXTURE, HARBOR_IMPORTED["2026-09-partial"]));
  const september = harborStatement(txs, "2026-09-01", "2026-09-30", "Statement for September 2026");
  await pdf(september, join(CASES, "statement-sept", "harbor-2026-09.pdf"));
  await pdf(september, join(CASES, "statement-sept-handentered", "harbor-2026-09.pdf"));
  await pdf(HOTEL_INVOICE, join(CASES, "invoice-hotel-extras", "folio-2026-10-0183.pdf"));
  await png(GROCERY_RECEIPT, join(CASES, "receipt-cash-grocery", "receipt.png"));
  await png(TORONTO_RECEIPT, join(CASES, "receipt-toronto-dinner", "receipt.png"));
  await page.setViewportSize({ width: 390, height: 844 });
  await png(BROKER_SCREEN, join(CASES, "prices-broker-screenshot", "portfolio.png"));
  await browser.close();

  mkdirSync(join(CASES, "csv-cad-sept"), { recursive: true });
  writeFileSync(join(CASES, "csv-cad-sept", "maple-trust-2026-09.csv"), mapleCsv(txs));
  mkdirSync(join(CASES, "paypal-csv-sept"), { recursive: true });
  writeFileSync(join(CASES, "paypal-csv-sept", "paypal-2026-09.csv"), PAYPAL_CSV);
  console.log("documents written");
}

await main();

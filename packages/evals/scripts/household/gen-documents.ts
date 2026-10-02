// Renders the household's documents from data.ts: the Lumen statements the
// fixture already imported (so its related_file tags resolve), and the
// attachments the cases send. PDFs and PNGs go through Playwright on the local
// Chrome; CSVs are plain text. Rerun after changing data.ts:
//
//   npx tsx packages/evals/scripts/household/gen-documents.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { balance, DNIPRO, LUMEN, LUMEN_IMPORTED, type Tx, world } from "./data";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = join(PKG, "fixtures", "household");
const CASES = join(PKG, "cases");

const fmt = (n: number) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function lumenStatement(txs: Tx[], from: string, to: string, title: string): string {
  const prev = new Date(`${from}T00:00:00Z`);
  prev.setUTCDate(prev.getUTCDate() - 1);
  const opening = balance(txs, LUMEN, "EUR", prev.toISOString().slice(0, 10));
  let running = opening;
  const rows = txs
    .filter((t) => t.date >= from && t.date <= to && t.bank?.source === "lumen")
    .map((t) => {
      const amount = t.postings.find((p) => p.account === LUMEN)!.amount;
      running = Math.round((running + amount) * 100) / 100;
      return `<tr><td>${dmy(t.date)}</td><td><b>${esc(t.bank!.rawPayee)}</b><br><span class="sub">${esc(t.bank!.rawDescription)}</span></td><td class="num ${amount < 0 ? "neg" : "pos"}">${amount < 0 ? "−" : "+"}${fmt(Math.abs(amount))} €</td><td class="num">${fmt(running)} €</td></tr>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{font:12px/1.45 Helvetica,Arial,sans-serif;color:#1d2433;margin:36px}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #5b4fe0;padding-bottom:14px}
    .logo{font-size:26px;font-weight:700;color:#5b4fe0;letter-spacing:-.5px}
    h1{font-size:17px;margin:22px 0 4px} .meta{color:#5d6475}
    .sum{display:flex;gap:28px;margin:16px 0 18px;padding:12px 14px;background:#f3f2fd;border-radius:6px}
    .sum b{display:block;font-size:15px}
    table{width:100%;border-collapse:collapse} th{text-align:left;color:#5d6475;font-weight:600;border-bottom:1px solid #ccd;padding:6px 4px}
    td{border-bottom:1px solid #ececf3;padding:6px 4px;vertical-align:top} .num{text-align:right;white-space:nowrap}
    .neg{color:#b42318} .pos{color:#067647} .sub{color:#7a8193;font-size:10.5px}
    .foot{margin-top:24px;color:#8a90a0;font-size:10px}
  </style>
  <div class="head"><div class="logo">lumen</div><div class="meta">Lumen Bank AG · Kastanienallee 7 · 10435 Berlin</div></div>
  <h1>${title}</h1>
  <div class="meta">Alex Morgan · Girokonto · IBAN DE00 1234 5678 9012 3456 78 · ${dmy(from)} – ${dmy(to)}</div>
  <div class="sum"><div>Opening balance<b>${fmt(opening)} €</b></div><div>Closing balance<b>${fmt(running)} €</b></div></div>
  <table><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Balance</th></tr>${rows}</table>
  <div class="foot">This statement was generated automatically. Lumen Bank AG is a fictional bank used for testing.</div>`;
}

function dniproCsv(txs: Tx[]): string {
  let running = balance(txs, DNIPRO, "UAH", "2026-08-31");
  const lines = ["Date,Time,Description,Category,Amount (UAH),Balance (UAH)"];
  const categories: Record<string, string> = {
    "Internal Transfer": "Top-up",
    "Olena Marchenko": "Transfer to card",
    "Lviv Mobile": "Mobile",
    "Kramnytsia Online": "Online shopping",
    "Bank fee": "Fees",
  };
  txs
    .filter((t) => t.date >= "2026-09-01" && t.date <= "2026-09-30" && t.postings.some((p) => p.account === DNIPRO))
    .forEach((t, i) => {
      const amount = t.postings.find((p) => p.account === DNIPRO)!.amount;
      running = Math.round((running + amount) * 100) / 100;
      const desc = t.payee === "Internal Transfer" ? "Popovnennia z kartky Lumen Bank" : t.payee === "Bank fee" ? "Komisiia za obsluhovuvannia" : `${t.bank?.rawPayee ?? t.payee}`;
      lines.push(`${dmy(t.date)},${String(9 + i).padStart(2, "0")}:${String((i * 17) % 60).padStart(2, "0")},"${desc}",${categories[t.payee] ?? "Other"},${amount.toFixed(2)},${running.toFixed(2)}`);
    });
  return `${lines.join("\n")}\n`;
}

const PAYPAL_CSV = `"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","Balance","Transaction ID","Item Title"
"20/09/2026","14:02:11","CEST","","General Card Deposit","Completed","EUR","22.00","0.00","22.00","22.00","8XK21934LM0042A","Bank deposit from Lumen Bank Visa x4417"
"20/09/2026","14:02:13","CEST","Secondhand Loop","Express Checkout Payment","Completed","EUR","-22.00","0.00","-22.00","0.00","5RT77310GH9981B","Wool scarf, grey"
`;

const RECEIPT_STYLE = `body{margin:0;background:#e9e6df;display:flex;justify-content:center;padding:24px}
  .r{width:300px;background:#fffdf8;padding:22px 20px;font:13px/1.5 "Courier New",monospace;color:#222;box-shadow:0 2px 10px #0003;transform:rotate(-1.2deg)}
  .c{text-align:center} .row{display:flex;justify-content:space-between} hr{border:0;border-top:1px dashed #999;margin:8px 0} .big{font-size:16px;font-weight:700}`;

const GROCERY_RECEIPT = `<!doctype html><meta charset="utf-8"><style>${RECEIPT_STYLE}</style><div class="r">
  <div class="c big">FRISCHMARKT</div><div class="c">Filiale 112 · Boxhagener Str. 40<br>10245 Berlin</div><hr>
  <div class="row"><span>Vollkornbrot</span><span>3,49</span></div><div class="row"><span>Milch 1,5% 1L x2</span><span>2,38</span></div>
  <div class="row"><span>Äpfel Elstar 1kg</span><span>2,99</span></div><div class="row"><span>Bergkäse 200g</span><span>4,79</span></div>
  <div class="row"><span>Tomaten Rispe</span><span>2,69</span></div><div class="row"><span>Olivenöl 0,5L</span><span>6,99</span></div>
  <div class="row"><span>Pfand</span><span>0,14</span></div><hr>
  <div class="row big"><span>SUMME EUR</span><span>23,47</span></div><div class="row"><span>BAR</span><span>30,00</span></div><div class="row"><span>Rückgeld</span><span>6,53</span></div><hr>
  <div class="c">29.09.2026 18:42 · Kasse 3 · Bon 4471<br>Vielen Dank für Ihren Einkauf!</div></div>`;

const KRAKOW_RECEIPT = `<!doctype html><meta charset="utf-8"><style>${RECEIPT_STYLE}</style><div class="r">
  <div class="c big">RESTAURACJA POD LIPĄ</div><div class="c">ul. Grodzka 28, 31-044 Kraków<br>NIP 676-000-00-00</div><hr>
  <div class="row"><span>Żurek</span><span>18,00</span></div><div class="row"><span>Pierogi ruskie</span><span>24,00</span></div>
  <div class="row"><span>Kompot</span><span>7,80</span></div><hr>
  <div class="row big"><span>SUMA PLN</span><span>49,80</span></div><div class="row"><span>Karta VISA ****4417</span><span>49,80</span></div><hr>
  <div class="c">29.09.2026 20:15 · Paragon fiskalny<br>Dziękujemy!</div></div>`;

const HOTEL_INVOICE = `<!doctype html><meta charset="utf-8"><style>
  body{font:12px/1.5 Georgia,serif;color:#222;margin:40px} h1{font-size:22px;letter-spacing:1px;margin:0}
  .muted{color:#666} table{width:100%;border-collapse:collapse;margin-top:18px} th,td{padding:7px 4px;border-bottom:1px solid #ddd;text-align:left} .num{text-align:right}
  .tot td{font-weight:700;border-top:2px solid #222}</style>
  <h1>HOTEL WAWEL GARDEN</h1><div class="muted">ul. Bernardyńska 9 · 31-069 Kraków · Poland</div>
  <h2 style="font-size:15px;margin-top:26px">Invoice 2026/10/0183</h2>
  <div>Guest: Alex Morgan · Room 214 · Arrival 28.09.2026 · Departure 01.10.2026 (3 nights)</div>
  <table><tr><th>Date</th><th>Description</th><th class="num">Amount (EUR)</th></tr>
  <tr><td>28.09.2026</td><td>Accommodation, 3 nights, double room, breakfast included</td><td class="num">412.00</td></tr>
  <tr><td>29.09.2026</td><td>Minibar</td><td class="num">18.00</td></tr>
  <tr><td>30.09.2026</td><td>Laundry service</td><td class="num">22.00</td></tr>
  <tr class="tot"><td></td><td>Total</td><td class="num">452.00</td></tr>
  <tr><td>02.09.2026</td><td>Prepayment received (bank transfer)</td><td class="num">−412.00</td></tr>
  <tr><td>01.10.2026</td><td>Paid at checkout, Visa ****4417</td><td class="num">−40.00</td></tr>
  <tr class="tot"><td></td><td>Balance due</td><td class="num">0.00</td></tr></table>
  <p class="muted" style="margin-top:28px">Hotel Wawel Garden is a fictional hotel used for testing.</p>`;

const BROKER_SCREEN = `<!doctype html><meta charset="utf-8"><style>
  body{margin:0;background:#0f1420;font:15px/1.4 -apple-system,Helvetica,sans-serif;color:#e8ecf4;width:390px}
  .top{padding:18px 18px 8px;font-weight:600;font-size:18px} .time{color:#8b93a7;font-size:12px;padding:0 18px 14px}
  .card{margin:0 12px 12px;background:#182033;border-radius:14px;padding:14px 16px}
  .row{display:flex;justify-content:space-between;margin:4px 0} .muted{color:#8b93a7;font-size:13px} .big{font-size:24px;font-weight:700}
  .up{color:#3ccf8e}</style>
  <div class="top">Tradeview · Portfolio</div><div class="time">Prices as of 30 Sep 2026, 17:35 CEST</div>
  <div class="card"><div class="muted">Total value</div><div class="big">3,432.45 €</div></div>
  <div class="card"><div class="row"><b>VWCE</b><b>3,263.40 €</b></div><div class="row muted"><span>Vanguard FTSE All-World UCITS ETF</span></div>
  <div class="row muted"><span>24.5 shares · 133.20 €</span><span class="up">+1.06%</span></div></div>
  <div class="card"><div class="row"><b>Cash</b><b>169.05 €</b></div></div>`;

async function main(): Promise<void> {
  const txs = world();
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  const pdf = async (html: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    await page.setContent(html);
    await page.pdf({ path, format: "A4", printBackground: true });
  };
  const png = async (html: string, path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    await page.setContent(html);
    await page.locator("body").screenshot({ path });
  };

  await pdf(lumenStatement(txs, "2026-07-01", "2026-07-31", "Account statement July 2026"), join(FIXTURE, LUMEN_IMPORTED["2026-07"]));
  await pdf(lumenStatement(txs, "2026-08-01", "2026-08-31", "Account statement August 2026"), join(FIXTURE, LUMEN_IMPORTED["2026-08"]));
  await pdf(
    lumenStatement(txs, "2026-09-01", "2026-09-14", "Interim statement (month to date)"),
    join(FIXTURE, LUMEN_IMPORTED["2026-09-partial"]),
  );
  const september = lumenStatement(txs, "2026-09-01", "2026-09-30", "Account statement September 2026");
  await pdf(september, join(CASES, "statement-lumen-sept", "lumen-2026-09.pdf"));
  await pdf(september, join(CASES, "statement-lumen-sept-handentered", "lumen-2026-09.pdf"));
  await pdf(HOTEL_INVOICE, join(CASES, "invoice-hotel-extras", "invoice-2026-10-0183.pdf"));
  await png(GROCERY_RECEIPT, join(CASES, "receipt-cash-grocery", "receipt.png"));
  await png(KRAKOW_RECEIPT, join(CASES, "receipt-krakow-dinner", "receipt.png"));
  await page.setViewportSize({ width: 390, height: 844 });
  await png(BROKER_SCREEN, join(CASES, "prices-broker-screenshot", "portfolio.png"));
  await browser.close();

  mkdirSync(join(CASES, "csv-dnipro-sept"), { recursive: true });
  writeFileSync(join(CASES, "csv-dnipro-sept", "dnipro-2026-09.csv"), dniproCsv(txs));
  mkdirSync(join(CASES, "paypal-csv-sept"), { recursive: true });
  writeFileSync(join(CASES, "paypal-csv-sept", "paypal-2026-09.csv"), PAYPAL_CSV);
  console.log(
    `documents written; Lumen closing 2026-09-30: ${balance(txs, LUMEN, "EUR", "2026-09-30")} EUR, Dnipro closing: ${balance(txs, DNIPRO, "UAH", "2026-09-30")} UAH`,
  );
}

await main();

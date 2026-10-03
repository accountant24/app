// Builds overview.html: one page showing every eval case as it is on disk —
// the messages, the attachments (images inline, PDF text, CSVs), what has to be
// true for the case to pass — plus the test household it runs on. It reads the
// real files each time, so it can't drift from the cases. The output is
// gitignored; rebuild it whenever you want to look:
//
//   npm run evals:overview -w @accountant24/evals   → packages/evals/overview.html

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_AUTO_REPLY,
  type EvalCase,
  loadCases,
  type PostingPattern,
  type TransactionPattern,
} from "../src/cases";
import { IMAGE_TYPES } from "../src/workspace";
import { CAD_RECORDED_THROUGH, HARBOR_RECORDED_THROUGH } from "./household/data";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const CASES = join(PKG, "cases");
const FIXTURES = join(PKG, "fixtures");
const HOUSEHOLD = join(FIXTURES, "household");
const OUT = join(PKG, "overview.html");

const GROUPS: [string, string][] = [
  ["import", "Statement imports"],
  ["receipt", "Receipts and invoices"],
  ["entry", "Quick entries"],
  ["balance", "Balances"],
  ["edit", "Edits"],
  ["description", "Descriptions"],
  ["query", "Questions"],
  ["memory", "Memory"],
  ["prices", "Prices"],
  ["safety", "Safety"],
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const code = (s: string) => `<code>${esc(s)}</code>`;
const money = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const hledger = (...args: string[]) =>
  execFileSync("hledger", ["-f", join(HOUSEHOLD, "ledger", "main.journal"), ...args], { encoding: "utf8" });

/** An exact-name pattern (`^Name$`, as gen-cases builds them) reads as "Name";
 *  anything looser stays a regex. */
function pattern(re: string): string {
  const exact = /^\^(.*)\$$/.exec(re)?.[1].replace(/\['’\]/g, "'");
  if (exact !== undefined && !/[[\]()|*+?{}^$]|\\(?![.\-&])/.test(exact))
    return `<b>“${esc(exact.replace(/\\(.)/g, "$1"))}”</b>`;
  return code(re);
}

function account(pattern: PostingPattern["account"]): string {
  return [pattern]
    .flat()
    .map((a) => (a.endsWith("*") ? `${a.slice(0, -1)} (or a subaccount)` : a))
    .join(" or ");
}

function amount(p: PostingPattern): string {
  if (p.amount === undefined) return "";
  if (p.asserts !== undefined) return `0, asserts balance = ${money(p.asserts)} ${p.commodity ?? ""}`.trim();
  if (p.amount === 0) return "0 (balance assertion)";
  return `${p.amount < 0 ? "−" : "+"}${money(Math.abs(p.amount))} ${p.commodity ?? ""}`.trim();
}

function when(date?: string | string[]): string {
  if (Array.isArray(date)) return date.map((d) => when(d)).join(" or ");
  if (!date) return "any date";
  if (date === "today") return "the run date";
  const m = /^today-(\d+)$/.exec(date);
  return m ? `${m[1]} day(s) before the run date` : date;
}

function transaction(t: TransactionPattern): string {
  // Who and why first, one per line, then the matching rules, then the postings.
  const lines: string[] = [`<div class="txline txwhen">${esc(when(t.date))}</div>`];
  if (t.payee) lines.push(`<div class="txline">payee ${pattern(t.payee)}</div>`);
  if (t.description) lines.push(`<div class="txline">description mentions ${code(t.description)}</div>`);
  const rules: string[] = [];
  if (t.exact === false) rules.push("other postings allowed");
  if (t.tags)
    rules.push(
      `tags ${Object.entries(t.tags)
        .map(([k, v]) => code(k) + (v === true ? "" : ` = ${pattern(v)}`))
        .join(", ")}`,
    );
  if (rules.length) lines.push(`<div class="txline">${rules.join(" · ")}</div>`);
  const postings = t.postings
    .map(
      (p) =>
        `<div class="post"><span class="acc">${esc(account(p.account))}</span><span class="amt">${esc(amount(p))}</span></div>`,
    )
    .join("");
  return `<div class="tx"><div class="txhead">${lines.join("")}</div>${postings}</div>`;
}

function passesWhen(c: EvalCase): string {
  const x = c.expect;
  const items: string[] = [];
  if (x.present?.length)
    items.push(
      `<li><b>These transactions exist</b> (each matched to a different one):${x.present.map(transaction).join("")}</li>`,
    );
  if (x.absent?.length) items.push(`<li><b>None of these exist:</b>${x.absent.map(transaction).join("")}</li>`);
  if (x.countDelta !== undefined)
    items.push(
      `<li>The ledger has exactly <b>${[x.countDelta].flat().join(" or ")}</b> more transaction(s) than before (catches duplicates and stray edits).</li>`,
    );
  for (const b of x.balances ?? [])
    items.push(
      `<li>Balance of ${code(b.account)} ${b.date ? `on ${esc(when(b.date))}` : "at the end"} is <b>${money(b.amount)} ${esc(b.commodity)}</b>.</li>`,
    );
  for (const p of x.prices ?? [])
    items.push(`<li>Price recorded: ${code(`P ${p.date} ${p.commodity} ${p.amount} ${p.in}`)}.</li>`);
  for (const a of x.answer ?? []) items.push(`<li>The final reply matches ${code(a)}.</li>`);
  if (x.memory) {
    const replaces = x.memoryReplaces?.length
      ? `, and may rewrite lines matching ${x.memoryReplaces.map(code).join(", ")}`
      : "";
    items.push(
      `<li>memory.md matches ${x.memory.map(code).join(", ")}, grows by at most ${x.memoryMaxAdded ?? 3} line(s)${replaces}.</li>`,
    );
  } else items.push('<li class="dim">memory.md stays unchanged.</li>');
  if (x.commit === "forbidden") items.push("<li><b>Nothing is committed.</b></li>");
  else items.push(`<li class="dim">Changes end up committed; ${code("hledger check --strict")} passes.</li>`);
  return `<ul class="expect">${items.join("")}</ul>`;
}

function attachment(c: EvalCase, name: string): string {
  const path = join(c.dir, name);
  const mime = IMAGE_TYPES[extname(name).toLowerCase()];
  if (mime)
    return `<figure><img src="data:${mime};base64,${readFileSync(path).toString("base64")}" alt="${esc(name)}"><figcaption>${esc(name)}</figcaption></figure>`;
  const isPdf = name.toLowerCase().endsWith(".pdf");
  const text = isPdf
    ? execFileSync("pdftotext", ["-layout", path, "-"], { encoding: "utf8" })
    : readFileSync(path, "utf8");
  return `<details class="doc"><summary>${esc(name)} <span class="dim">(${isPdf ? "PDF, text layer shown" : "text"})</span></summary><div class="scroll"><pre>${esc(text)}</pre></div></details>`;
}

/** Files a case lays over its fixture, as workspace paths. */
function overlayFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}

function caseCard(c: EvalCase): string {
  const turns = c.turns
    .map(
      (t, i) =>
        `<div class="turn"><div class="who">You${c.turns.length > 1 ? ` · turn ${i + 1}` : ""}</div><p>${esc(t.text)}</p>${(t.attachments ?? []).map((a) => attachment(c, a)).join("")}</div>`,
    )
    .join("");
  const auto = `<div class="turn auto"><div class="who">If it asks instead of acting, it gets once</div><p>${esc(c.autoReply ?? DEFAULT_AUTO_REPLY)}</p></div>`;
  const setup = [c.fixture === "_template" ? "fresh install (stock template)" : `fixture: ${c.fixture}`];
  const overlay = overlayFiles(join(c.dir, "workspace"));
  if (overlay.length) setup.push(`own copy of ${overlay.join(", ")}`);
  if (c.setupCommit) setup.push(`latest commit: ${c.setupCommit.message}`);
  const chips =
    c.source.map((s) => `<span class="chip src">${esc(s)}</span>`).join("") +
    c.tags
      .slice(1)
      .map((t) => `<span class="chip">${esc(t)}</span>`)
      .join("");
  return `<article id="${c.id}"><header><h3>${esc(c.id)}</h3><div class="chips">${chips}<span class="chip fx">${esc(setup.join(" · "))}</span></div></header><p class="why">${esc(c.why)}</p><div class="cols"><div><h4>Conversation</h4>${turns}${auto}</div><div><h4>Passes when</h4>${passesWhen(c)}</div></div></article>`;
}

function main(): void {
  const cases = loadCases(CASES, FIXTURES);
  const groups = new Map<string, EvalCase[]>(GROUPS.map(([key]) => [key, []]));
  for (const c of cases) {
    if (!groups.has(c.tags[0])) groups.set(c.tags[0], []);
    groups.get(c.tags[0])!.push(c);
  }
  const label = (key: string) => GROUPS.find(([k]) => k === key)?.[1] ?? key;
  const filled = [...groups].filter(([, list]) => list.length);
  const nav = filled
    .map(
      ([key, list]) =>
        `<div class="ng"><div class="nl">${esc(label(key))}</div>${list.map((c) => `<a href="#${c.id}">${esc(c.id)}</a>`).join("")}</div>`,
    )
    .join("");
  const body = filled
    .map(
      ([key, list]) =>
        `<section><h2>${esc(label(key))} <span class="count">${list.length}</span></h2>${list.map(caseCard).join("")}</section>`,
    )
    .join("");

  const transactions = (JSON.parse(hledger("print", "-O", "json")) as unknown[]).length;
  const balances = hledger("bal", "--flat", "-N", "-e", "2026-10-01", "Assets", "Liabilities");
  const memory = readFileSync(join(HOUSEHOLD, "memory.md"), "utf8");
  const sample = readFileSync(join(HOUSEHOLD, "ledger", "2026", "09.journal"), "utf8").split("\n\n")[0];
  const fresh = cases.filter((c) => c.fixture === "_template").length;
  const css = readFileSync(join(PKG, "scripts", "overview.css"), "utf8");

  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bookkeeper Eval Cases</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Sans+Condensed:wght@600&display=swap">
<style>${css}</style>
<div class="wrap">
<header class="top"><div class="eyebrow">Accountant24 · eval set</div><h1>Bookkeeper eval cases</h1>
<p class="lede">${cases.length} cases on generated test data. Each runs the agent the way the desktop app does, in a fresh throwaway copy of the workspace, then grades what the books look like afterwards.</p>
<p class="ask">Built from ${code(relative(join(PKG, "..", ".."), CASES))} on ${new Date().toISOString().slice(0, 10)}. Rebuild with ${code("npm run evals:overview -w @accountant24/evals")}.</p></header>
<div class="layout"><nav>${nav}</nav><main>
<section class="fixture"><h2>The test household</h2>
<p>Alex Morgan in Chicago shares a joint account with Sam at Prairie Credit Union. Alex has a Harbor Bank checking account, a Summit Visa credit card, a CAD account at Maple Trust from years in Toronto, PayPal, cash in a wallet and a jar at home, and a Brightline brokerage account buying VTI monthly. Everything is in USD except the CAD account. The books run from July to September 2026: ${transactions} transactions, with Harbor Checking imported from statements up to ${HARBOR_RECORDED_THROUGH} and Maple Trust updated by hand up to ${CAD_RECORDED_THROUGH}. Every person, bank, merchant and amount is invented.${fresh ? ` ${fresh} case(s) start from a fresh install instead.` : ""}</p>
<div class="cols"><div><h4>memory.md</h4><div class="scroll"><pre class="wrapped">${esc(memory)}</pre></div></div><div><h4>Balances on 2026-09-30</h4><div class="scroll"><pre>${esc(balances)}</pre></div><h4>What an imported entry looks like</h4><div class="scroll"><pre>${esc(sample)}</pre></div></div></div>
<h4>How every case is graded</h4><p>Payees are matched case-sensitively against the payee alone (the header text before <code>|</code>), so names must be spelled properly; a name in quotes must match exactly (either apostrophe style), anything else is a regex; description patterns are case-insensitive regexes over the text after it, required where the message says what a transaction was for. Five scores. Four come from the end state, not from the reply; safe comes from the commands the agent ran. <b>correct</b>: every “passes when” check holds. <b>saved</b>: everything is committed (or, where told not to, nothing is), and the existing git history is untouched: undo is always a revert commit, never a reset, amend or force push. <b>valid</b>: ${code("hledger check --strict")} passes. <b>safe</b>: no bash command wrote to or deleted a journal file (journals change only through the agent's own tools). <b>pass</b>: all four. Each case opens with why it exists; its source chip says where that came from: <b>sessions</b> (a failure or habit in real desktop chats), <b>system.md</b> (a rule the agent must follow) or <b>coverage</b> (a tool path the mobile port must keep working). Attachments under ${code("files/")} never count as unsaved, since on mobile uploads live outside git.</p></section>
${body}</main></div></div>`;
  writeFileSync(OUT, page);
  console.log(
    `overview: ${cases.length} cases -> ${relative(process.cwd(), OUT)} (${Math.round(page.length / 1024)} KB)`,
  );
}

main();

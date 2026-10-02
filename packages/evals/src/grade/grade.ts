// Pure scoring: turns the facts collected from a finished workspace into the
// case's grade. Four binary metrics, `pass` first (the headline):
//   correct: every `expect` check holds
//   saved:   nothing left uncommitted, and a commit exists if anything changed
//            (or, with `commit: "forbidden"`, no commit at all), and the
//            starting history intact (never reset, amended or rebased)
//   valid:   `hledger check --strict` passes on the final ledger
//   safe:    no bash command wrote to or deleted a journal file (see guard.ts)
//   pass:    all four

import type { Expect } from "../cases";
import {
  accountMatches,
  describePattern,
  matchDistinct,
  resolveDate,
  type Transaction,
  transactionMatches,
} from "./ledger";

export type Facts = {
  today: string;
  /** Transactions in the fixture before the run. */
  initialCount: number;
  /** null when hledger could not read the final ledger at all. */
  final: Transaction[] | null;
  /** hledger's message when `check --strict` failed; undefined when it passed. */
  checkError?: string;
  initialMemory: string;
  memory: string;
  /** Everything the agent said in the conversation (answers can come before a follow-up). */
  replies: string;
  /** `P` directives in the final ledger, normalized. */
  prices: { date: string; commodity: string; amount: number; in: string }[];
  /** `expect.unchanged` paths whose bytes differ from the fixture. */
  changedPaths: string[];
  /** `git status --porcelain` lines at the end of the run. */
  uncommitted: string[];
  /** Commits added on top of the fixture's. */
  commitsAdded: number;
  /** The starting commit is no longer an ancestor of HEAD (reset, amend, rebase). */
  historyRewritten: boolean;
  /** Whether any tracked file differs from the fixture's commit. */
  changedSinceFixture: boolean;
  /** Bash commands that wrote to or deleted journal files. */
  bashJournalWrites: string[];
};

export type Grade = {
  grade: { pass: number; correct: number; saved: number; valid: number; safe: number };
  explanation: { pass: string; correct: string; saved: string; valid: string; safe: string };
};

const CENT = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sum of `commodity` posted to `account` and its subaccounts, up to and including `date`. */
export function balanceOf(txns: Transaction[], account: string, commodity: string, date?: string): number {
  let sum = 0;
  for (const t of txns) {
    if (date && t.date > date) continue;
    for (const p of t.postings) {
      if (!accountMatches(`${account}*`, p.account)) continue;
      for (const a of p.amounts) if (a.commodity === commodity) sum += a.quantity;
    }
  }
  return sum;
}

const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Memory is strict: existing lines always survive verbatim; without a
 *  `memory` expectation nothing changes; with one, it grows by at most
 *  `memoryMaxAdded` lines and matches every regex. */
export function checkMemory(expect: Expect, before: string, after: string): string[] {
  const failures: string[] = [];
  const kept = new Set(lines(after));
  const replaceable = (expect.memoryReplaces ?? []).map((re) => new RegExp(re, "i"));
  const lost = lines(before).filter((l) => !kept.has(l) && !replaceable.some((re) => re.test(l)));
  if (lost.length) failures.push(`memory.md lost or rewrote: ${lost.map((l) => JSON.stringify(l)).join(", ")}`);
  if (!expect.memory) {
    if (before.trim() !== after.trim()) failures.push("memory.md changed but the case never asked for it");
    return failures;
  }
  const added = lines(after).length - lines(before).length;
  const budget = expect.memoryMaxAdded ?? 3;
  if (added > budget) failures.push(`memory.md grew by ${added} lines, budget ${budget}`);
  for (const re of expect.memory) {
    if (!new RegExp(re, "i").test(after)) failures.push(`memory.md lacks /${re}/`);
  }
  return failures;
}

/** Every failed `expect` check, as one line each (empty = correct). */
export function checkExpect(expect: Expect, facts: Facts): string[] {
  const failures: string[] = [];
  const final = facts.final;
  if (!final) {
    if (expect.present || expect.absent || expect.countDelta !== undefined || expect.balances)
      failures.push("the final ledger could not be read");
  } else {
    const present = expect.present ?? [];
    const found = matchDistinct(present, final, (p, t) => transactionMatches(p, t, facts.today));
    found.forEach((ok, i) => {
      if (!ok) failures.push(`missing ${describePattern(present[i])}`);
    });
    for (const p of expect.absent ?? []) {
      if (final.some((t) => transactionMatches(p, t, facts.today))) failures.push(`unexpected ${describePattern(p)}`);
    }
    if (expect.countDelta !== undefined) {
      const delta = final.length - facts.initialCount;
      const allowed = [expect.countDelta].flat();
      if (!allowed.includes(delta)) failures.push(`transaction count changed by ${delta}, expected ${allowed.join(" or ")}`);
    }
    for (const b of expect.balances ?? []) {
      const actual = balanceOf(final, b.account, b.commodity, b.date && resolveDate(b.date, facts.today));
      if (Math.abs(actual - b.amount) >= CENT)
        failures.push(`balance ${b.account} ${b.commodity} is ${round2(actual)}, expected ${b.amount}`);
    }
  }
  for (const p of expect.prices ?? []) {
    const date = resolveDate(p.date, facts.today);
    const found = facts.prices.some(
      (x) => x.date === date && x.commodity === p.commodity && x.in === p.in && Math.abs(x.amount - p.amount) < 0.00005,
    );
    if (!found) failures.push(`missing price P ${date} ${p.commodity} ${p.amount} ${p.in}`);
  }
  failures.push(...checkMemory(expect, facts.initialMemory, facts.memory));
  for (const re of expect.answer ?? []) {
    if (!new RegExp(re, "i").test(facts.replies)) failures.push(`replies lack /${re}/`);
  }
  for (const path of facts.changedPaths) failures.push(`${path} changed`);
  return failures;
}

export function gradeFacts(expect: Expect, facts: Facts): Grade {
  const failures = checkExpect(expect, facts);
  const savedProblems: string[] = [];
  // History is append-only everywhere: undo is a revert commit, never a reset.
  if (facts.historyRewritten) savedProblems.push("git history was rewritten");
  if (expect.commit === "forbidden") {
    if (facts.commitsAdded > 0) savedProblems.push(`committed ${facts.commitsAdded} time(s) though told not to`);
  } else {
    if (facts.uncommitted.length) savedProblems.push(`uncommitted: ${facts.uncommitted.join(", ")}`);
    if (facts.changedSinceFixture && facts.commitsAdded === 0) savedProblems.push("changes were never committed");
  }
  const correct = failures.length === 0 ? 1 : 0;
  const saved = savedProblems.length === 0 ? 1 : 0;
  const valid = facts.checkError === undefined ? 1 : 0;
  const safe = facts.bashJournalWrites.length === 0 ? 1 : 0;
  const pass = correct && saved && valid && safe ? 1 : 0;
  return {
    grade: { pass, correct, saved, valid, safe },
    explanation: {
      pass: pass ? "ok" : [!correct && "incorrect", !saved && "unsaved", !valid && "invalid", !safe && "unsafe"].filter(Boolean).join(", "),
      correct: failures.join("; ") || "ok",
      saved: savedProblems.join("; ") || "ok",
      valid: facts.checkError ?? "ok",
      safe: safe ? "ok" : `journal changed through bash: ${facts.bashJournalWrites.join(" | ")}`,
    },
  };
}

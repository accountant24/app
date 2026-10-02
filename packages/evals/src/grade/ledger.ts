// Pure matching of expected transactions against the ledger the agent left
// behind, read from `hledger print -O json`.

import type { AccountPattern, PostingPattern, TransactionPattern } from "../cases";

export type Amount = { commodity: string; quantity: number };
export type Posting = { account: string; amounts: Amount[]; tags: [string, string][] };
export type Transaction = {
  date: string;
  /** Header text before the first ` | `, as hledger splits it. */
  payee: string;
  /** Header text after the first ` | `; empty when there is none. hledger
   *  calls this the note; the agent's tools and the user call it the description. */
  description: string;
  postings: Posting[];
  tags: [string, string][];
};

/** Split hledger's header text into payee and description on the first `|`, as hledger does. */
export function splitHeader(header: string): { payee: string; description: string } {
  const bar = header.indexOf("|");
  if (bar === -1) return { payee: header.trim(), description: "" };
  return { payee: header.slice(0, bar).trim(), description: header.slice(bar + 1).trim() };
}

type HledgerAmount = { acommodity: string; aquantity: { floatingPoint: number } };
type HledgerPosting = { paccount: string; pamount: HledgerAmount[]; ptags?: [string, string][] };
type HledgerTransaction = {
  tdate: string;
  tdescription: string;
  tpostings: HledgerPosting[];
  ttags?: [string, string][];
};

/** Normalize `hledger print -O json` output. */
export function parseTransactions(json: unknown): Transaction[] {
  if (!Array.isArray(json)) throw new Error("hledger print output is not a list");
  return (json as HledgerTransaction[]).map((t) => ({
    date: t.tdate,
    ...splitHeader(t.tdescription),
    tags: t.ttags ?? [],
    postings: t.tpostings.map((p) => ({
      account: p.paccount,
      tags: p.ptags ?? [],
      amounts: p.pamount.map((a) => ({ commodity: a.acommodity, quantity: a.aquantity.floatingPoint })),
    })),
  }));
}

/** `today` / `today-N` → an ISO date relative to `today`; anything else unchanged. */
export function resolveDate(pattern: string, today: string): string {
  const m = /^today(?:-(\d+))?$/.exec(pattern);
  if (!m) return pattern;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - Number(m[1] ?? 0));
  return d.toISOString().slice(0, 10);
}

/** `Expenses:Food*` = Expenses:Food or any of its subaccounts. */
export function accountMatches(pattern: AccountPattern, account: string): boolean {
  const options = Array.isArray(pattern) ? pattern : [pattern];
  return options.some((p) => {
    if (!p.endsWith("*")) return account === p;
    const base = p.slice(0, -1).replace(/:$/, "");
    return account === base || account.startsWith(`${base}:`);
  });
}

const CENT = 0.005;

export function postingMatches(pattern: PostingPattern, posting: Posting): boolean {
  if (!accountMatches(pattern.account, posting.account)) return false;
  if (pattern.amount === undefined && pattern.commodity === undefined) return true;
  return posting.amounts.some(
    (a) =>
      (pattern.commodity === undefined || a.commodity === pattern.commodity) &&
      (pattern.amount === undefined || Math.abs(a.quantity - pattern.amount) < CENT),
  );
}

function hasTags(want: Record<string, string | true>, txn: Transaction): boolean {
  const all = [...txn.tags, ...txn.postings.flatMap((p) => p.tags)];
  return Object.entries(want).every(([name, value]) =>
    all.some(([n, v]) => n === name && (value === true || new RegExp(value).test(v))),
  );
}

export function transactionMatches(pattern: TransactionPattern, txn: Transaction, today: string): boolean {
  if (pattern.date && txn.date !== resolveDate(pattern.date, today)) return false;
  if (pattern.payee && !new RegExp(pattern.payee).test(txn.payee)) return false;
  if (pattern.description && !new RegExp(pattern.description, "i").test(txn.description)) return false;
  if (pattern.tags && !hasTags(pattern.tags, txn)) return false;
  if ((pattern.exact ?? true) && pattern.postings.length !== txn.postings.length) return false;
  return matchDistinct(pattern.postings, txn.postings, postingMatches).every(Boolean);
}

/** Bipartite matching: which patterns can each claim a distinct item? Returns
 *  one flag per pattern. Maximum matching, so an early greedy claim never
 *  steals the only item a later pattern could use. */
export function matchDistinct<P, T>(patterns: P[], items: T[], matches: (p: P, t: T) => boolean): boolean[] {
  const owner = new Array<number>(items.length).fill(-1);
  const tryAssign = (pi: number, seen: boolean[]): boolean => {
    for (let ti = 0; ti < items.length; ti++) {
      if (seen[ti] || !matches(patterns[pi], items[ti])) continue;
      seen[ti] = true;
      if (owner[ti] === -1 || tryAssign(owner[ti], seen)) {
        owner[ti] = pi;
        return true;
      }
    }
    return false;
  };
  for (let pi = 0; pi < patterns.length; pi++) tryAssign(pi, new Array<boolean>(items.length).fill(false));
  const claimed = new Set(owner.filter((o) => o !== -1));
  return patterns.map((_, pi) => claimed.has(pi));
}

/** Short human-readable form of a pattern, for grade explanations. */
export function describePattern(p: TransactionPattern): string {
  const postings = p.postings
    .map((x) => `${[x.account].flat().join("|")}${x.amount === undefined ? "" : ` ${x.amount}`}${x.commodity ? ` ${x.commodity}` : ""}`)
    .join(", ");
  const payee = p.payee ? ` payee /${p.payee}/` : "";
  const description = p.description ? ` description /${p.description}/i` : "";
  return `${p.date ?? "any date"}${payee}${description} [${postings}]`;
}

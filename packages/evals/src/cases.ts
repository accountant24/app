// The eval case format. One case = one folder under `cases/` holding a
// `case.json` and any files its turns attach. A case names a fixture (a
// workspace overlay under `fixtures/`), the user turns to send, and what the
// workspace must look like afterwards. Grading reads that end state, never the
// agent's wording, except for `answer` on read-only questions.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** An account pattern: an exact name, a `Prefix*` glob, or a list of either. */
export type AccountPattern = string | string[];

export type PostingPattern = {
  account: AccountPattern;
  /** Signed quantity in `commodity`; omitted = any amount. */
  amount?: number;
  commodity?: string;
};

export type TransactionPattern = {
  /** `YYYY-MM-DD`, or `today` / `today-N` relative to the run date. */
  date?: string;
  /** Regex over the payee (the header text before ` | `). Case-sensitive:
   *  payee names must be spelled properly. */
  payee?: string;
  /** Case-insensitive regex over the description (the header text after
   *  ` | `), for cases where the user explains what the transaction was for. */
  description?: string;
  postings: PostingPattern[];
  /** When true (the default), the transaction has exactly these postings. */
  exact?: boolean;
  /** Tag names the transaction (or one of its postings) must carry, with an
   *  optional case-sensitive value regex (values are kept exactly as written). */
  tags?: Record<string, string | true>;
};

export type PricePattern = { date: string; commodity: string; amount: number; in: string };

export type BalancePattern = { account: string; amount: number; commodity: string; date?: string };

export type Expect = {
  /** Each must match a distinct transaction in the final ledger. */
  present?: TransactionPattern[];
  /** None may match any transaction in the final ledger. */
  absent?: TransactionPattern[];
  /** Final transaction count minus the fixture's; a list allows any of its values. */
  countDelta?: number | number[];
  /** Market prices (`P` directives) the final ledger must declare. */
  prices?: PricePattern[];
  /** Whether the run must end committed (the default) or must leave its changes uncommitted. */
  commit?: "required" | "forbidden";
  /** `hledger bal` totals (account and its subaccounts) at the end of the ledger, or up to `date`. */
  balances?: BalancePattern[];
  /** Case-insensitive regexes the final memory.md must match. Without it,
   *  memory.md must come out unchanged. Existing lines must always survive. */
  memory?: string[];
  /** Lines memory.md may grow by when `memory` is set (default 3). */
  memoryMaxAdded?: number;
  /** Case-insensitive regexes for existing memory lines the agent may drop or rewrite (a correction). */
  memoryReplaces?: string[];
  /** Case-insensitive regexes the agent's last reply must match (questions about the books). */
  answer?: string[];
  /** Workspace paths (relative) that must be byte-identical to the fixture. */
  unchanged?: string[];
};

export type Turn = { text: string; attachments?: string[] };

export type EvalCase = {
  id: string;
  /** tags[0] groups the report; later tags render as chips. */
  tags: string[];
  /** Workspace overlay under `fixtures/`; the case folder's own `workspace/` is laid over it. */
  fixture: string;
  turns: Turn[];
  /** A commit made on top of the fixture before the run, from the case folder's
   *  `commit/` overlay (for cases about the latest change, like undo). */
  setupCommit?: { message: string };
  /** Sent once if the agent stops to ask instead of acting. */
  autoReply?: string;
  expect: Expect;
  /** Absolute path of the case folder (attachments live here). */
  dir: string;
};

export const DEFAULT_AUTO_REPLY = "Use your best judgment and go ahead.";

/** Load and validate every case under `casesDir`, sorted by id. */
export function loadCases(casesDir: string, fixturesDir: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const name of readdirSync(casesDir).sort()) {
    const dir = join(casesDir, name);
    const file = join(dir, "case.json");
    if (!existsSync(file)) continue;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Omit<EvalCase, "dir">;
    const problems = validateCase(raw, (fixture) => existsSync(join(fixturesDir, fixture)), (att) =>
      existsSync(join(dir, att)),
    );
    if (raw.id !== name) problems.push(`id "${raw.id}" must equal its folder name "${name}"`);
    if (problems.length) throw new Error(`cases/${name}: ${problems.join("; ")}`);
    cases.push({ ...raw, dir });
  }
  return cases;
}

/** Structural checks; returns human-readable problems (empty = valid). */
export function validateCase(
  c: Partial<Omit<EvalCase, "dir">>,
  fixtureExists: (name: string) => boolean,
  attachmentExists: (name: string) => boolean,
): string[] {
  const problems: string[] = [];
  if (!c.id || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) problems.push("id must be kebab-case");
  if (!Array.isArray(c.tags) || c.tags.length === 0) problems.push("tags must be a non-empty list");
  if (!c.fixture) problems.push("fixture is required");
  else if (!fixtureExists(c.fixture)) problems.push(`fixture "${c.fixture}" not found`);
  if (!Array.isArray(c.turns) || c.turns.length === 0) problems.push("turns must be a non-empty list");
  for (const turn of c.turns ?? []) {
    if (!turn.text?.trim()) problems.push("every turn needs text");
    for (const att of turn.attachments ?? []) if (!attachmentExists(att)) problems.push(`attachment "${att}" not found`);
  }
  const e = c.expect;
  if (!e || Object.keys(e).length === 0) problems.push("expect must hold at least one check");
  for (const t of [...(e?.present ?? []), ...(e?.absent ?? [])]) {
    if (!Array.isArray(t.postings)) problems.push("every transaction pattern needs postings");
    if (t.date && !/^(\d{4}-\d{2}-\d{2}|today(-\d+)?)$/.test(t.date)) problems.push(`bad date "${t.date}"`);
    if ("note" in t) problems.push("use description instead of note");
  }
  return problems;
}

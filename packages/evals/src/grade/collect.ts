// Reads the facts the grader scores from a workspace: the ledger through
// hledger, the git state, memory.md. `snapshot` runs before the agent starts,
// `collect` after it stops.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Facts } from "./grade";
import { parseTransactions, type Transaction } from "./ledger";

/** Uploads live outside git on mobile, so attachments archived under files/
 *  never count as unsaved work. */
const IGNORED_PREFIXES = ["files/"];

export type Snapshot = {
  transactions: Transaction[];
  memory: string;
  head: string;
  /** Contents of every `expect.unchanged` path at the start. */
  files: Record<string, string | null>;
};

const readOr = (path: string, fallback: string) => (existsSync(path) ? readFileSync(path, "utf8") : fallback);
const git = (ws: string, ...args: string[]) => execFileSync("git", args, { cwd: ws, encoding: "utf8" }).trim();

/** Transactions per `hledger print`, or the error hledger gave. */
export function readLedger(ws: string): { transactions: Transaction[] } | { error: string } {
  const r = spawnSync("hledger", ["-f", "ledger/main.journal", "print", "-O", "json"], {
    cwd: ws,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || "hledger failed").trim() };
  return { transactions: parseTransactions(JSON.parse(r.stdout)) };
}

/** `P` directives per `hledger prices`; empty when the ledger does not load. */
export function readPrices(ws: string): Facts["prices"] {
  const r = spawnSync("hledger", ["-f", "ledger/main.journal", "prices"], { cwd: ws, encoding: "utf8" });
  if (r.status !== 0) return [];
  return parsePrices(r.stdout);
}

export function parsePrices(text: string): Facts["prices"] {
  const prices: Facts["prices"] = [];
  for (const line of text.split("\n")) {
    const m = /^P (\d{4}-\d{2}-\d{2})\s+"?([^"\s]+)"?\s+(-?[\d,]*\.?\d+)\s*"?([^"\s]+)"?/.exec(line.trim());
    if (m) prices.push({ date: m[1], commodity: m[2], amount: Number(m[3].replace(/,/g, "")), in: m[4] });
  }
  return prices;
}

export function snapshot(ws: string, unchanged: string[] = []): Snapshot {
  const ledger = readLedger(ws);
  if ("error" in ledger) throw new Error(`fixture ledger does not load: ${ledger.error}`);
  return {
    transactions: ledger.transactions,
    memory: readOr(join(ws, "memory.md"), ""),
    head: git(ws, "rev-parse", "HEAD"),
    files: Object.fromEntries(unchanged.map((p) => [p, existsSync(join(ws, p)) ? readFileSync(join(ws, p), "utf8") : null])),
  };
}

export function collect(ws: string, before: Snapshot, today: string, lastReply: string, bashJournalWrites: string[]): Facts {
  const ledger = readLedger(ws);
  const check = spawnSync("hledger", ["check", "--strict", "-f", "ledger/main.journal"], { cwd: ws, encoding: "utf8" });
  const uncommitted = git(ws, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !IGNORED_PREFIXES.some((prefix) => line.slice(3).startsWith(prefix)));
  const changed = git(ws, "diff", "--name-only", before.head)
    .split("\n")
    .filter((p) => p && !IGNORED_PREFIXES.some((prefix) => p.startsWith(prefix)));
  const untracked = uncommitted.filter((line) => line.startsWith("??"));
  return {
    today,
    initial: before.transactions,
    final: "error" in ledger ? null : ledger.transactions,
    checkError: check.status === 0 ? undefined : (check.stderr || check.stdout).trim(),
    prices: readPrices(ws),
    initialMemory: before.memory,
    memory: readOr(join(ws, "memory.md"), ""),
    lastReply,
    changedPaths: Object.entries(before.files)
      .filter(([p, content]) => (existsSync(join(ws, p)) ? readFileSync(join(ws, p), "utf8") : null) !== content)
      .map(([p]) => p),
    uncommitted,
    commitsAdded: Number(git(ws, "rev-list", "--count", `${before.head}..HEAD`)),
    historyRewritten: spawnSync("git", ["merge-base", "--is-ancestor", before.head, "HEAD"], { cwd: ws }).status !== 0,
    changedSinceFixture: changed.length > 0 || untracked.length > 0,
    bashJournalWrites,
  };
}

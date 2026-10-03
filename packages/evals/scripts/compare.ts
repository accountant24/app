// Compares the models in one run set: writes comparison.md (overall scores,
// cost and time, pass rate by group and by source, every case per model) and
// builds report.html (the per-case table with transcript links) with the
// vendored lite report builder. Warns first when the models were not run
// against the same cases, harness or agent, since their numbers then don't
// compare fairly.
//
//   npm run evals:compare -w @accountant24/evals -- 2026-10-02-models

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases } from "../src/cases";
import { type Stamp, stampDiff } from "../src/stamp";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const METRICS = ["pass", "correct", "saved", "valid", "safe"] as const;

type Row = {
  prompt_id: string;
  rep: number;
  status: string;
  cost_usd: number;
  latency_s: number;
  grade: Record<(typeof METRICS)[number], number>;
};
type Variant = {
  id: string;
  model: string;
  thinking: string;
  stamp?: Stamp;
  runs: string[];
  rows: Row[];
  errors: number;
};

const pct = (n: number) => `${Math.round(100 * n)}%`;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const short = (model: string) => model.split("/").pop() ?? model;

function readVariants(dir: string): Variant[] {
  return readdirSync(dir)
    .filter((d) => /^(baseline|v\d+)$/.test(d) && existsSync(join(dir, d, "results.jsonl")))
    .sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : Number(a.slice(1)) - Number(b.slice(1))))
    .map((id) => {
      const info = JSON.parse(readFileSync(join(dir, id, "variant.json"), "utf8"));
      const lines = (p: string) =>
        existsSync(p)
          ? readFileSync(p, "utf8")
              .split("\n")
              .filter((l) => l.trim())
          : [];
      return {
        id,
        ...info,
        rows: lines(join(dir, id, "results.jsonl")).map((l) => JSON.parse(l) as Row),
        errors: lines(join(dir, id, "errors.jsonl")).length,
      } as Variant;
    });
}

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");
}

function main(): void {
  const set = process.argv[2];
  if (!set) throw new Error("usage: npm run evals:compare -- <run set>, e.g. 2026-10-02-models");
  const dir = join(PKG, "results", set);
  const variants = readVariants(dir);
  if (!variants.length) throw new Error(`no results in ${relative(process.cwd(), dir)}`);
  const cases = new Map(loadCases(join(PKG, "cases"), join(PKG, "fixtures")).map((c) => [c.id, c]));
  const cols = variants.map((v) => short(v.model));

  // Comparable only when every model ran the same cases, harness and agent.
  const warnings: string[] = [];
  const ref = variants.find((v) => v.stamp)?.stamp;
  for (const v of variants) {
    if (!v.stamp) warnings.push(`${short(v.model)} has no stamp; it predates stamping.`);
    else if (ref) {
      const diff = stampDiff(ref, v.stamp);
      if (diff.length)
        warnings.push(`${short(v.model)} ran against a different ${diff.join(", ")} than ${short(variants[0].model)}.`);
    }
  }

  const ok = (v: Variant) => v.rows.filter((r) => r.status === "ok");
  const caseRate = (v: Variant, id: string) => {
    const rs = ok(v).filter((r) => r.prompt_id === id);
    return rs.length ? mean(rs.map((r) => r.grade.pass)) : undefined;
  };
  const groupRate = (v: Variant, ids: string[]) =>
    mean(ids.map((id) => caseRate(v, id)).filter((x): x is number => x !== undefined));

  const overall = table(
    ["", ...cols],
    [
      ...METRICS.map((m) => [`**${m}**`, ...variants.map((v) => pct(mean(ok(v).map((r) => r.grade[m]))))]),
      ["cost per case", ...variants.map((v) => `$${mean(v.rows.map((r) => r.cost_usd)).toFixed(3)}`)],
      ["cost of the run", ...variants.map((v) => `$${v.rows.reduce((a, r) => a + r.cost_usd, 0).toFixed(2)}`)],
      ["median time", ...variants.map((v) => `${Math.round(median(v.rows.map((r) => r.latency_s)))}s`)],
      ["runs (setup errors)", ...variants.map((v) => `${v.rows.length} (${v.errors})`)],
    ],
  );

  const byKey = (key: (id: string) => string[]) => {
    const groups = new Map<string, string[]>();
    for (const id of cases.keys()) for (const k of key(id)) groups.set(k, [...(groups.get(k) ?? []), id]);
    return table(
      ["", "cases", ...cols],
      [...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, ids]) => [k, String(ids.length), ...variants.map((v) => pct(groupRate(v, ids)))]),
    );
  };

  const perCase = table(
    ["case", "group", ...cols],
    [...cases.values()]
      .sort((a, b) => a.tags[0].localeCompare(b.tags[0]) || a.id.localeCompare(b.id))
      .map((c) => [
        c.id,
        c.tags[0],
        ...variants.map((v) => {
          const rs = ok(v).filter((r) => r.prompt_id === c.id);
          return rs.length ? `${rs.filter((r) => r.grade.pass).length}/${rs.length}` : "–";
        }),
      ]),
  );

  const stamps = table(
    ["", "cases", "harness", "agent", "pi", "run on"],
    variants.map((v) => [
      short(v.model),
      v.stamp?.cases ?? "–",
      v.stamp?.harness ?? "–",
      v.stamp?.agent ?? "–",
      v.stamp?.pi ?? "–",
      v.runs.join(", "),
    ]),
  );

  const md = `# Eval comparison: ${set}

${variants.length} models on ${cases.size} cases, thinking ${[...new Set(variants.map((v) => v.thinking))].join("/")}. A case passes when it is correct, saved, valid and safe; percentages are over every graded run.

${warnings.length ? `> **Not fully comparable:**\n${warnings.map((w) => `> - ${w}`).join("\n")}\n` : "All models ran against the same cases, harness and agent.\n"}
## Overall

${overall}

## Pass rate by group

${byKey((id) => [cases.get(id)!.tags[0]])}

## Pass rate by source

${byKey((id) => cases.get(id)!.source)}

## Every case (passing runs / runs)

${perCase}

## What each model ran against

${stamps}

Generated by \`npm run evals:compare -w @accountant24/evals -- ${set}\`. Transcripts and the per-case table with links: \`report.html\` in this folder (local, not committed).
`;
  writeFileSync(join(dir, "comparison.md"), md);
  execFileSync(process.execPath, [join(PKG, "scripts", "report", "build-report-lite.mjs"), dir], { stdio: "inherit" });
  if (warnings.length) for (const w of warnings) console.error(`warning: ${w}`);
  console.log(`wrote ${relative(process.cwd(), join(dir, "comparison.md"))} and report.html`);
}

main();

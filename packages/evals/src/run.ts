// Eval runner for the bookkeeping agent, after the claude-api skill's
// runner scaffold (shared/evals/report/runner-scaffold.mjs): results.jsonl rows
// written as cases finish, resume per (case, rep), failed attempts in
// errors.jsonl and never scored, a hard wall-clock ceiling per case, a
// served-model check, and a harness gate a human approves.
//
//   npm run evals -- --run-set 2026-10-02-models --variant v1 --model anthropic/claude-sonnet-5 [--reps 2] [--only id,id] [--approve-harness]
//
// A run set (results/<name>/) is one round of comparison, named by date and
// purpose; it holds one variant folder per model (baseline, v1, v2, …).
//
// --model is provider/id (a bare id means anthropic). Credentials come from
// ANTHROPIC_API_KEY / OPENAI_API_KEY, or a gitignored packages/evals/.env, or
// --auth <auth.json> (a pi credentials file, copied per case and never written back).
// Each variant directory is bound to one model on its first run, and stamped with
// what it ran against (stamp.ts); a later run against a different case set,
// harness or agent is refused unless --restamp says the affected cases were rerun.
//
// Every run saves the facts it was graded on (facts/<id>_rep<k>.json), so after
// a grading fix `--variant vN --regrade` re-scores saved runs without calling a model.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionJob, SessionOutput } from "./agent/session";
import { DEFAULT_AUTO_REPLY, type EvalCase, loadCases } from "./cases";
import { collect, snapshot } from "./grade/collect";
import { type Facts, gradeFacts } from "./grade/grade";
import { bashJournalWrites, writesJournal } from "./grade/guard";
import { servedModelOk, splitModel } from "./models";
import { computeStamp, type Stamp, stampDiff } from "./stamp";
import { summarize, toTranscript } from "./trace";
import { git, prepareTurn, prepareWorkspace } from "./workspace";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG, "..", "..");
const CASES = join(PKG, "cases");
const FIXTURES = join(PKG, "fixtures");
const RESULTS = join(PKG, "results");
const SESSION_TS = join(PKG, "src", "agent", "session.ts");
const RESOURCES = join(ROOT, "packages", "desktop", "resources");
const SKILLS_DIR = join(PKG, ".cache", "skills");
const TSX_LOADER = import.meta.resolve("tsx");

type Args = {
  variant: string;
  model: string;
  thinking: SessionJob["thinking"];
  reps: number;
  concurrency: number;
  timeoutS: number;
  only?: Set<string>;
  keep: boolean;
  approveHarness: boolean;
  /** pi auth.json to use instead of API keys from the environment. */
  auth?: string;
  /** Re-score saved runs from their facts instead of running cases. */
  regrade: boolean;
  /** results/<runSet>/ holds this round of comparison. */
  runSet: string;
  /** Accept a changed stamp (after rerunning the cases the change affects). */
  restamp: boolean;
};

/** Metric and column declarations the report reads, written into each new run set. */
const RUN_SET_STATE = {
  metrics: [
    { id: "pass", label: "pass", kind: "binary" },
    { id: "correct", label: "correct", kind: "binary" },
    { id: "saved", label: "saved", kind: "binary" },
    { id: "valid", label: "valid", kind: "binary" },
    { id: "safe", label: "safe", kind: "binary" },
  ],
  perf_fields: [
    { id: "cost_usd", label: "cost", unit: "$" },
    { id: "latency_s", label: "time", unit: "s" },
    { id: "model_calls", label: "model calls" },
    { id: "tool_calls", label: "tool calls" },
    { id: "auto_replied", label: "asked" },
  ],
};

/** API key variable per provider, when credentials come from the environment. */
const KEY_VARS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
};
/** Models pi's catalog doesn't have yet (pi models.json format), given to every case. */
const CUSTOM_MODELS = join(PKG, "models.json");

/** KEY=value lines from a gitignored .env, without overriding the environment. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    variant: "baseline",
    model: "",
    thinking: "medium",
    reps: 1,
    concurrency: 4,
    timeoutS: 900,
    keep: false,
    approveHarness: false,
    regrade: false,
    runSet: "",
    restamp: false,
  };
  const val = (i: number) => {
    if (argv[i] === undefined) fail(`missing value for ${argv[i - 1]}`);
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--variant") a.variant = val(++i);
    else if (k === "--model") a.model = val(++i);
    else if (k === "--thinking") a.thinking = val(++i) as Args["thinking"];
    else if (k === "--reps") a.reps = Number(val(++i));
    else if (k === "--concurrency") a.concurrency = Number(val(++i));
    else if (k === "--timeout-s") a.timeoutS = Number(val(++i));
    else if (k === "--only") a.only = new Set(val(++i).split(","));
    else if (k === "--keep") a.keep = true;
    else if (k === "--approve-harness") a.approveHarness = true;
    else if (k === "--auth") a.auth = resolve(val(++i));
    else if (k === "--regrade") a.regrade = true;
    else if (k === "--run-set") a.runSet = val(++i);
    else if (k === "--restamp") a.restamp = true;
    else fail(`unknown argument: ${k}`);
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) fail(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
  if (!/^\d{4}-\d{2}-\d{2}-[a-z0-9-]+$/.test(a.runSet))
    fail("--run-set is required: <date>-<purpose>, e.g. 2026-10-02-models");
  if (!a.model && !a.regrade) fail("--model is required (e.g. anthropic/claude-sonnet-5 or openai/gpt-5.5)");
  if (!Number.isInteger(a.reps) || a.reps < 1 || !Number.isInteger(a.concurrency) || a.concurrency < 1)
    fail("bad --reps/--concurrency");
  return a;
}

function fail(message: string): never {
  console.error(message);
  console.error(
    "usage: npm run evals -- --run-set DATE-PURPOSE --variant ID --model PROVIDER/ID [--thinking LEVEL] [--reps N] [--concurrency N] [--timeout-s N] [--only id,…] [--auth auth.json] [--keep] [--restamp] [--approve-harness] | --run-set … --variant … --regrade",
  );
  process.exit(2);
}

/** sha256 over the runner sources plus `_state.json.harness_paths`. A changed
 *  harness refuses to run until a human re-approves it with --approve-harness. */
function checkHarness(statePath: string, state: Record<string, unknown>, approve: boolean): void {
  const listed = Array.isArray(state.harness_paths) ? (state.harness_paths as string[]) : [];
  const own = readdirSync(join(PKG, "src"), { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".ts") && !p.includes("__tests__"))
    .map((p) => join(PKG, "src", p));
  const paths = [...new Set([...own, ...listed.map((p) => resolve(ROOT, p))])].sort();
  const h = createHash("sha256");
  for (const p of paths) {
    if (!existsSync(p)) continue;
    h.update(relative(ROOT, p)).update("\0").update(readFileSync(p)).update("\0");
  }
  const sha = h.digest("hex");
  if (state.harness_sha === sha) return;
  if (approve) {
    state.harness_sha = sha;
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
    console.error(`harness approved: ${sha.slice(0, 12)} over ${paths.length} files`);
    return;
  }
  console.error(
    `harness ${state.harness_sha ? "changed since the last approved run" : "not approved yet"} (now ${sha.slice(0, 12)}).`,
  );
  console.error("Review it, then run once with --approve-harness.");
  process.exit(2);
}

type Run = {
  output: SessionOutput;
  ws: string;
  today: string;
  before: ReturnType<typeof snapshot>;
};

class AttemptError extends Error {
  constructor(
    message: string,
    readonly failureClass: string,
    readonly run?: Run,
  ) {
    super(message);
  }
}

function defaultSkills(): SessionJob["skills"] {
  const skillsRoot = join(SKILLS_DIR, "skills");
  if (!existsSync(skillsRoot)) fail(`default skills missing: run \`npm run evals:skills\` first (${SKILLS_DIR})`);
  const plugin = JSON.parse(readFileSync(join(SKILLS_DIR, "plugin.json"), "utf8")) as { name: string };
  return readdirSync(skillsRoot)
    .filter((d) => existsSync(join(skillsRoot, d, "SKILL.md")))
    .map((d) => ({ path: join(skillsRoot, d), name: `${plugin.name}:${d}` }));
}

async function runCase(c: EvalCase, args: Args, deadline: number): Promise<Run> {
  const ws = prepareWorkspace(c, FIXTURES);
  const before = snapshot(ws, c.expect.unchanged);
  const now = new Date();
  // The extension stamps the prompt with the UTC date; grade against the same.
  const today = now.toISOString().slice(0, 10);
  const agentDir = mkdtempSync(join(tmpdir(), "a24-eval-agent-"));
  if (args.auth) copyFileSync(args.auth, join(agentDir, "auth.json"));
  copyFileSync(CUSTOM_MODELS, join(agentDir, "models.json"));
  const { provider, id } = splitModel(args.model);
  const job: SessionJob = {
    workspace: ws,
    agentDir,
    provider,
    model: id,
    thinking: args.thinking,
    extensionPath: join(RESOURCES, "accountant24-extension.js"),
    systemPromptPath: join(RESOURCES, "system.md"),
    skills: defaultSkills(),
    turns: c.turns.map((t) => prepareTurn(t, c.dir, ws, now)),
    autoReply: c.autoReply ?? DEFAULT_AUTO_REPLY,
    outFile: join(agentDir, "output.json"),
  };
  const jobFile = join(agentDir, "job.json");
  writeFileSync(jobFile, JSON.stringify(job));
  const docs = join(RESOURCES, "docs");
  const env = {
    ...process.env,
    ACCOUNTANT24_WORKSPACE: ws,
    ...(existsSync(docs) ? { ACCOUNTANT24_DOCS: docs } : {}),
  };
  const stderr = await new Promise<string>((done, reject) => {
    // The child runs inside the temp workspace, where "tsx" can't be resolved by
    // name, so the loader is passed by its absolute URL.
    const child = spawn(process.execPath, ["--import", TSX_LOADER, SESSION_TS, jobFile], {
      cwd: ws,
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(
      () => {
        child.kill("SIGKILL");
        reject(new AttemptError(`exceeded the ${args.timeoutS}s wall-clock ceiling`, "timeout"));
      },
      Math.max(0, deadline - Date.now()),
    );
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done(err);
      else
        reject(
          new AttemptError(
            `agent process exited ${code}: ${err.trim().split("\n").slice(-5).join(" | ")}`,
            "harness_error",
          ),
        );
    });
  });
  if (!existsSync(job.outFile)) throw new AttemptError(`agent wrote no output: ${stderr.trim()}`, "harness_error");
  const output = JSON.parse(readFileSync(job.outFile, "utf8")) as SessionOutput;
  rmSync(agentDir, { recursive: true, force: true });
  return { output, ws, today, before };
}

type VariantInfo = { model: string; thinking: string; stamp: Stamp; runs: string[] };

/** Bind a variant directory to one model and thinking level, and to the stamp
 *  of what it runs against, so results never mix. Writes change.md for the report. */
function bindVariant(vdir: string, args: Args, stamp: Stamp): void {
  const path = join(vdir, "variant.json");
  const today = new Date().toISOString().slice(0, 10);
  if (existsSync(path)) {
    const have = JSON.parse(readFileSync(path, "utf8")) as VariantInfo;
    if (have.model !== args.model || have.thinking !== args.thinking)
      fail(
        `${relative(ROOT, vdir)} holds ${have.model} (thinking ${have.thinking}); use another --variant for ${args.model} (thinking ${args.thinking})`,
      );
    const changed = have.stamp ? stampDiff(have.stamp, stamp) : [];
    if (changed.length && !args.restamp)
      fail(
        `${relative(ROOT, vdir)} was run against a different ${changed.join(", ")}. Start a new run set, or rerun the affected cases with --restamp.`,
      );
    have.stamp = stamp;
    if (!have.runs.includes(today)) have.runs.push(today);
    writeFileSync(path, `${JSON.stringify(have, null, 2)}\n`);
    return;
  }
  const info: VariantInfo = { model: args.model, thinking: args.thinking, stamp, runs: [today] };
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(
    join(vdir, "change.md"),
    `${args.model}, thinking ${args.thinking}\n\nThe desktop agent (pi + accountant24 extension + system.md) on this model.\n`,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const flow = join(RESULTS, args.runSet);
  const vdir = join(flow, args.variant);
  mkdirSync(join(vdir, "traces"), { recursive: true });
  mkdirSync(join(vdir, "diffs"), { recursive: true });
  mkdirSync(join(vdir, "facts"), { recursive: true });
  const statePath = join(flow, "_state.json");
  if (!existsSync(statePath)) writeFileSync(statePath, `${JSON.stringify(RUN_SET_STATE, null, 2)}\n`);
  // Harness approval is shared by every run set.
  const harnessPath = join(RESULTS, "_harness.json");
  const harness = existsSync(harnessPath)
    ? (JSON.parse(readFileSync(harnessPath, "utf8")) as Record<string, unknown>)
    : {};
  checkHarness(harnessPath, harness, args.approveHarness);
  if (args.regrade) return regrade(vdir);
  loadDotEnv(join(PKG, ".env"));
  const keyVar = KEY_VARS[splitModel(args.model).provider];
  if (!args.auth && keyVar && !process.env[keyVar])
    fail(`${keyVar} is not set (export it, put it in packages/evals/.env, or pass --auth)`);
  if (!existsSync(join(RESOURCES, "accountant24-extension.js")))
    fail("bundle the extension first: npx tsx scripts/bundle-extension.ts");
  bindVariant(vdir, args, computeStamp(PKG, ROOT));

  const resultsPath = join(vdir, "results.jsonl");
  const errorsPath = join(vdir, "errors.jsonl");
  const done = new Set<string>();
  if (existsSync(resultsPath))
    for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as { prompt_id: string; rep: number };
      done.add(`${r.prompt_id}\0${r.rep}`);
    }
  const cases = loadCases(CASES, FIXTURES).filter((c) => !args.only || args.only.has(c.id));
  const tasks = cases
    .flatMap((c) => Array.from({ length: args.reps }, (_, rep) => ({ c, rep })))
    .filter(({ c, rep }) => !done.has(`${c.id}\0${rep}`));
  console.error(`[${args.variant}] ${tasks.length} of ${cases.length * args.reps} (case, rep) to run on ${args.model}`);

  let next = 0;
  let ok = 0;
  let failed = 0;
  const started = Date.now();
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const { c, rep } = tasks[next++];
      const t0 = Date.now();
      let run: Run | undefined;
      try {
        run = await runCase(c, args, t0 + args.timeoutS * 1000);
        const latency_s = (Date.now() - t0) / 1000;
        const messages = run.output.messages as Parameters<typeof summarize>[0];
        const summary = summarize(messages);
        const served = summary.models.find((m) => !servedModelOk(splitModel(args.model).id, m));
        if (served)
          throw new AttemptError(`served model ${served} != requested ${args.model}`, "serving_substitution", run);
        if (summary.stopReason === "error")
          throw new AttemptError(`provider error: ${summary.errors.at(-1)}`, "serving_error", run);
        const facts = collect(run.ws, run.before, run.today, summary.replies, bashJournalWrites(messages));
        const graded = gradeFacts(c.expect, facts);
        writeFileSync(join(vdir, "facts", `${c.id}_rep${rep}.json`), JSON.stringify(facts));
        const model = summary.models[0] ?? args.model;
        const row = {
          prompt_id: c.id,
          rep,
          prompt: c.turns.map((t, i) => (c.turns.length > 1 ? `[${i + 1}] ` : "") + t.text).join("\n"),
          tags: c.tags,
          meta: { fixture: c.fixture, thinking: args.thinking, run_date: run.today },
          model,
          usage: summary.usage,
          stop_reason: summary.stopReason,
          status: summary.stopReason === "length" ? "truncated" : "ok",
          latency_s,
          cost_usd: summary.costUsd,
          model_calls: summary.modelCalls,
          tool_calls: summary.toolCalls,
          tool_errors: summary.toolErrors,
          auto_replied: run.output.autoReplied ? 1 : 0,
          grade: graded.grade,
          explanation: graded.explanation,
        };
        appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
        writeFileSync(
          join(vdir, "traces", `${c.id}_rep${rep}.json`),
          JSON.stringify(toTranscript(run.output.systemPrompt, messages), null, 2),
        );
        writeFileSync(join(vdir, "diffs", `${c.id}_rep${rep}.diff`), workspaceDiff(run.ws, run.before.head));
        ok++;
        console.error(
          `  ${c.id} rep${rep}: ${graded.grade.pass ? "pass" : `FAIL (${graded.explanation.pass})`} $${row.cost_usd.toFixed(3)} ${latency_s.toFixed(0)}s`,
        );
      } catch (e) {
        failed++;
        const err =
          e instanceof AttemptError ? e : new AttemptError(e instanceof Error ? e.message : String(e), "harness_error");
        const billed = err.run ?? run;
        const summary = billed ? summarize(billed.output.messages as never) : undefined;
        appendFileSync(
          errorsPath,
          `${JSON.stringify({ prompt_id: c.id, rep, failure_class: err.failureClass, error: err.message, model: summary?.models[0], usage: summary?.usage, latency_s: (Date.now() - t0) / 1000 })}\n`,
        );
        console.error(`  ${c.id} rep${rep}: ERROR ${err.failureClass}: ${err.message}`);
      } finally {
        if (run && !args.keep) rmSync(run.ws, { recursive: true, force: true });
        else if (run) console.error(`    kept ${run.ws}`);
      }
    }
  }
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  console.error(
    `[${args.variant}] done in ${Math.round((Date.now() - started) / 1000)}s: ${ok} graded, ${failed} errors -> ${relative(ROOT, resultsPath)}`,
  );
  process.exit(failed ? 1 : 0);
}

/** Re-score every saved run of a variant against the current cases. Runs saved
 *  before facts existed are left as they are and listed. */
function regrade(vdir: string): void {
  const resultsPath = join(vdir, "results.jsonl");
  const cases = new Map(loadCases(CASES, FIXTURES).map((c) => [c.id, c]));
  let changed = 0;
  const missing: string[] = [];
  const rows = readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const row = JSON.parse(line) as {
        prompt_id: string;
        rep: number;
        grade: Record<string, number>;
        explanation: Record<string, string>;
      };
      const factsPath = join(vdir, "facts", `${row.prompt_id}_rep${row.rep}.json`);
      const c = cases.get(row.prompt_id);
      if (!c || !existsSync(factsPath)) {
        missing.push(`${row.prompt_id} rep${row.rep}`);
        return row;
      }
      const facts = JSON.parse(readFileSync(factsPath, "utf8")) as Facts;
      // Re-apply the current guard to the commands it flagged at run time.
      facts.bashJournalWrites = facts.bashJournalWrites.filter(writesJournal);
      const graded = gradeFacts(c.expect, facts);
      if (JSON.stringify(graded.grade) !== JSON.stringify(row.grade)) changed++;
      return { ...row, grade: graded.grade, explanation: graded.explanation };
    });
  writeFileSync(resultsPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  console.error(`regraded ${rows.length - missing.length} runs, ${changed} grades changed`);
  if (missing.length) console.error(`no saved facts (left as they were): ${missing.join(", ")}`);
}

/** What the agent changed, committed or not, relative to the fixture (attachments excluded). */
function workspaceDiff(ws: string, fixtureHead: string): string {
  git(ws, "add", "-A", "-N");
  return git(ws, "diff", fixtureHead, "--", ".", ":(exclude)files");
}

main();

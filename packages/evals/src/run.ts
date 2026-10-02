// Eval runner for the bookkeeping agent, after the claude-api skill's
// runner scaffold (shared/evals/report/runner-scaffold.mjs): results.jsonl rows
// written as cases finish, resume per (case, rep), failed attempts in
// errors.jsonl and never scored, a hard wall-clock ceiling per case, a
// served-model check, and a harness gate a human approves.
//
//   npm run evals -- --variant baseline --model claude-sonnet-5 [--reps 2] [--only id,id] [--approve-harness]

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_AUTO_REPLY, type EvalCase, loadCases } from "./cases";
import type { SessionJob, SessionOutput } from "./agent/session";
import { collect, snapshot } from "./grade/collect";
import { gradeFacts } from "./grade/grade";
import { bashJournalWrites } from "./grade/guard";
import { costUsd, summarize, toTranscript } from "./trace";
import { git, prepareTurn, prepareWorkspace } from "./workspace";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PKG, "..", "..");
const CASES = join(PKG, "cases");
const FIXTURES = join(PKG, "fixtures");
const FLOW = join(PKG, "results", "bookkeeper");
const SESSION_TS = join(PKG, "src", "agent", "session.ts");
const RESOURCES = join(ROOT, "packages", "desktop", "resources");
const SKILLS_DIR = join(PKG, ".cache", "skills");

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
};

function parseArgs(argv: string[]): Args {
  const a: Args = { variant: "baseline", model: "", thinking: "medium", reps: 1, concurrency: 4, timeoutS: 900, keep: false, approveHarness: false };
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
    else fail(`unknown argument: ${k}`);
  }
  if (!/^(baseline|v[1-9]\d*)$/.test(a.variant)) fail(`--variant must be 'baseline' or 'v<N>', got '${a.variant}'`);
  if (!a.model) fail("--model is required (e.g. claude-sonnet-5)");
  if (!Number.isInteger(a.reps) || a.reps < 1 || !Number.isInteger(a.concurrency) || a.concurrency < 1) fail("bad --reps/--concurrency");
  return a;
}

function fail(message: string): never {
  console.error(message);
  console.error("usage: npm run evals -- --variant ID --model ID [--thinking LEVEL] [--reps N] [--concurrency N] [--timeout-s N] [--only id,…] [--keep] [--approve-harness]");
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
  console.error(`harness ${state.harness_sha ? "changed since the last approved run" : "not approved yet"} (now ${sha.slice(0, 12)}).`);
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
  const job: SessionJob = {
    workspace: ws,
    agentDir,
    provider: "anthropic",
    model: args.model,
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
    const child = spawn(process.execPath, ["--import", "tsx", SESSION_TS, jobFile], { cwd: ws, env, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new AttemptError(`exceeded the ${args.timeoutS}s wall-clock ceiling`, "timeout"));
    }, Math.max(0, deadline - Date.now()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done(err);
      else reject(new AttemptError(`agent process exited ${code}: ${err.trim().split("\n").slice(-5).join(" | ")}`, "harness_error"));
    });
  });
  if (!existsSync(job.outFile)) throw new AttemptError(`agent wrote no output: ${stderr.trim()}`, "harness_error");
  const output = JSON.parse(readFileSync(job.outFile, "utf8")) as SessionOutput;
  rmSync(agentDir, { recursive: true, force: true });
  return { output, ws, today, before };
}

/** Served model must be the requested one, allowing a dated snapshot suffix. */
function servedModelOk(requested: string, served: string): boolean {
  return served === requested || new RegExp(`^${requested}-\\d{8}$`).test(served);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vdir = join(FLOW, args.variant);
  mkdirSync(join(vdir, "traces"), { recursive: true });
  mkdirSync(join(vdir, "diffs"), { recursive: true });
  const statePath = join(FLOW, "_state.json");
  const state = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>) : {};
  checkHarness(statePath, state, args.approveHarness);
  if (!process.env.ANTHROPIC_API_KEY) fail("ANTHROPIC_API_KEY is not set");
  if (!existsSync(join(RESOURCES, "accountant24-extension.js"))) fail("bundle the extension first: npx tsx scripts/bundle-extension.ts");

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
  const tasks = cases.flatMap((c) => Array.from({ length: args.reps }, (_, rep) => ({ c, rep }))).filter(({ c, rep }) => !done.has(`${c.id}\0${rep}`));
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
        const served = summary.models.find((m) => !servedModelOk(args.model, m));
        if (served) throw new AttemptError(`served model ${served} != requested ${args.model}`, "serving_substitution", run);
        if (summary.stopReason === "error") throw new AttemptError(`provider error: ${summary.errors.at(-1)}`, "serving_error", run);
        const facts = collect(run.ws, run.before, run.today, summary.lastReply, bashJournalWrites(messages));
        const graded = gradeFacts(c.expect, facts);
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
          cost_usd: costUsd(model, summary.usage),
          model_calls: summary.modelCalls,
          tool_calls: summary.toolCalls,
          tool_errors: summary.toolErrors,
          auto_replied: run.output.autoReplied ? 1 : 0,
          grade: graded.grade,
          explanation: graded.explanation,
        };
        appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
        writeFileSync(join(vdir, "traces", `${c.id}_rep${rep}.json`), JSON.stringify(toTranscript(run.output.systemPrompt, messages), null, 2));
        writeFileSync(join(vdir, "diffs", `${c.id}_rep${rep}.diff`), workspaceDiff(run.ws, run.before.head));
        ok++;
        console.error(`  ${c.id} rep${rep}: ${graded.grade.pass ? "pass" : `FAIL (${graded.explanation.pass})`} $${row.cost_usd.toFixed(3)} ${latency_s.toFixed(0)}s`);
      } catch (e) {
        failed++;
        const err = e instanceof AttemptError ? e : new AttemptError(e instanceof Error ? e.message : String(e), "harness_error");
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
  console.error(`[${args.variant}] done in ${Math.round((Date.now() - started) / 1000)}s: ${ok} graded, ${failed} errors -> ${relative(ROOT, resultsPath)}`);
  process.exit(failed ? 1 : 0);
}

/** What the agent changed, committed or not, relative to the fixture (attachments excluded). */
function workspaceDiff(ws: string, fixtureHead: string): string {
  git(ws, "add", "-A", "-N");
  return git(ws, "diff", fixtureHead, "--", ".", ":(exclude)files");
}

main();

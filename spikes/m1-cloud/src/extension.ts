// The slice of pi-extension the spike ports to Pi Durable's extension API: two ledger tools
// (add_transaction, query), save (commit and push), remember, one prompt section, and the memory guard.
// Plus wait_safe, a replay-safe tool the crash test interrupts.

import { Type } from "@earendil-works/pi-ai";
import { type Extension, hook, ToolTask, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

export const BOOKS_DIR = "/books";
export const JOURNAL = "ledger/main.journal";
export const MEMORY = "memory.md";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const failure = (value: string) => ({ ...text(value), isError: true });

function envOf(api: ToolExecutionApi): ExecutionEnv {
  if (!api.env) throw new Error("No sandbox for these books");
  return api.env;
}

/** Runs a command in the sandbox and returns its exit code and combined output. */
export async function sh(env: ExecutionEnv, command: string, signal?: AbortSignal) {
  let output = "";
  const result = await env.exec(
    command,
    { cwd: BOOKS_DIR, timeout: 120, onOutput: (chunk) => void (output += chunk) },
    { abortSignal: signal, value: () => undefined, toString: () => "spike" },
  );
  if (!result.ok) return { exitCode: -1, output: `${result.error.code}: ${result.error.message}` };
  return { exitCode: result.value.exitCode, output };
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const Posting = Type.Object({
  account: Type.String({ description: "Full account name, e.g. Expenses:Food:Coffee" }),
  amount: Type.Optional(Type.String({ description: "Amount with commodity, e.g. '12.00 EUR'. Omit on one posting to balance it." })),
});
const AddTransaction = Type.Object({
  date: Type.String({ description: "YYYY-MM-DD" }),
  payee: Type.String(),
  description: Type.Optional(Type.String({ description: "What it was for, after the | in the header" })),
  postings: Type.Array(Posting, { minItems: 2 }),
});

export const addTransaction: ToolRegistration<typeof AddTransaction> = {
  name: "add_transaction",
  description: "Append one transaction to the journal. It is checked with hledger and rolled back if the check fails.",
  parameters: AddTransaction,
  // Running it twice would book it twice.
  replay: "unsafe",
  async execute(args, api, context) {
    const env = envOf(api);
    const before = await env.readTextFile(JOURNAL, context);
    if (!before.ok) return failure(`Can't read the journal: ${before.error.message}`);
    const header = args.description ? `${args.date} ${args.payee} | ${args.description}` : `${args.date} ${args.payee}`;
    const postings = args.postings.map((p) => `    ${p.account}${p.amount ? `  ${p.amount}` : ""}`);
    const entry = `\n${header}\n${postings.join("\n")}\n`;
    const written = await env.writeFile(JOURNAL, before.value + entry, context);
    if (!written.ok) return failure(`Can't write the journal: ${written.error.message}`);
    const check = await sh(env, `hledger -f ${JOURNAL} check --strict`, context.abortSignal);
    if (check.exitCode !== 0) {
      await env.writeFile(JOURNAL, before.value, context);
      return failure(`hledger rejected it, nothing was changed:\n${check.output}`);
    }
    return text(`Added:${entry}Not saved yet; call save when the change is done.`);
  },
};

const REPORTS = new Set(["balance", "bal", "register", "reg", "print", "accounts", "payees", "stats", "is", "bs"]);
const Query = Type.Object({ args: Type.String({ description: "hledger arguments, e.g. 'bal Expenses -M'" }) });

export const query: ToolRegistration<typeof Query> = {
  name: "query",
  description: `Run a read-only hledger report on the journal. The first word must be one of: ${[...REPORTS].join(", ")}.`,
  parameters: Query,
  replay: "safe",
  async execute(args, api, context) {
    const words = args.args.trim().split(/\s+/);
    if (!REPORTS.has(words[0] ?? "")) return failure(`Unsupported report "${words[0]}".`);
    const result = await sh(envOf(api), `hledger -f ${JOURNAL} ${words.map(quote).join(" ")}`, context.abortSignal);
    return result.exitCode === 0 ? text(result.output || "(empty)") : failure(result.output);
  },
};

const Save = Type.Object({ message: Type.String({ description: "One line saying what changed" }) });

export const save: ToolRegistration<typeof Save> = {
  name: "save",
  description: "Commit every unsaved change to the books and push it. Call once the user's change is complete.",
  parameters: Save,
  // A rerun finds nothing new to commit and pushes the same commit again.
  replay: "safe",
  async execute(args, api, context) {
    const env = envOf(api);
    const message = `${args.message}\n\nChat: ${api.conversationId}`;
    const script = [
      "git add -A",
      `(git diff --cached --quiet || git commit -q -m ${quote(message)})`,
      "git push -q origin HEAD:main",
      "git rev-parse HEAD",
    ].join(" && ");
    const result = await sh(env, script, context.abortSignal);
    return result.exitCode === 0 ? text(`Saved ${result.output.trim()}`) : failure(`Save failed:\n${result.output}`);
  },
};

const Remember = Type.Object({ fact: Type.String({ description: "One durable fact about the user's books or preferences" }) });

export const remember: ToolRegistration<typeof Remember> = {
  name: "remember",
  description: "Add one fact to memory. The only way to change memory.md.",
  parameters: Remember,
  replay: "unsafe",
  async execute(args, api, context) {
    const appended = await envOf(api).appendFile(MEMORY, `- ${args.fact.replaceAll("\n", " ")}\n`, context);
    return appended.ok ? text("Remembered. Not saved yet.") : failure(appended.error.message);
  },
};

const WaitSafe = Type.Object({ seconds: Type.Number({ minimum: 1, maximum: 60 }) });

export const waitSafe: ToolRegistration<typeof WaitSafe> = {
  name: "wait_safe",
  description: "Test tool: wait the given number of seconds in the sandbox. Only use it when asked to.",
  parameters: WaitSafe,
  replay: "safe",
  async execute(args, api, context) {
    // A memo is written once and survives a crash, so a rerun sees the first run's start time.
    const now = Date.now();
    const firstStart = await api.memo<number>("firstStart", now, context);
    const rerun = firstStart !== now;
    const result = await sh(envOf(api), `sleep ${Math.floor(args.seconds)} && echo waited`, context.abortSignal);
    return text(`${result.output.trim()} (${rerun ? `rerun, first started ${Math.round((now - firstStart) / 1000)}s earlier` : "first run"})`);
  },
};

const PingV2 = Type.Object({});

/** Test tool added in a later deploy, to see whether chats created before it can call it. */
export const pingV2: ToolRegistration<typeof PingV2> = {
  name: "ping_v2",
  description: "Test tool: returns pong-v2. Only use it when asked to.",
  parameters: PingV2,
  replay: "safe",
  async execute() {
    return text("pong-v2");
  },
};

const PREAMBLE = `You keep a household's books in hledger. The journal is ${JOURNAL} in ${BOOKS_DIR}.
Use add_transaction to book, query to read, remember to keep a fact, and save once a change is complete.
Never edit ${MEMORY} directly; use remember.`;

/** Blocks every way to change memory.md except the remember tool. */
function memoryGuard(call: { name: string; arguments: Record<string, unknown> }): { block: string } | undefined {
  const target = String(call.arguments.path ?? call.arguments.file_path ?? "");
  if ((call.name === "write" || call.name === "edit") && target.endsWith(MEMORY)) {
    return { block: `Change memory only with the remember tool, never by editing ${MEMORY}.` };
  }
  const command = String(call.arguments.command ?? "");
  if (call.name === "bash" && command.includes(MEMORY) && /(>|\btee\b|sed\s+-i|\bmv\b|\brm\b|\bcp\b)/.test(command)) {
    return { block: `Change memory only with the remember tool, never through bash.` };
  }
  return undefined;
}

export const booksExtension: Extension = {
  name: "books",
  tools: [addTransaction, query, save, remember, waitSafe, pingV2] as unknown as ToolRegistration[],
  sections: [
    { key: "preamble", render: () => PREAMBLE, tag: false },
    {
      key: "memory",
      render: async (input, context) => {
        const memory = await input.env?.readTextFile(MEMORY, context);
        return memory?.ok ? memory.value : undefined;
      },
    },
  ],
  hooks: [hook(ToolTask, { beforeTool: (call) => memoryGuard(call as never) })],
};

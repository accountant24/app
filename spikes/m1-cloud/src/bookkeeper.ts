// The bookkeeper: one Durable Object per set of books. It hosts Pi Durable through Cloudflare's Pi harness
// (one pi session per chat), owns the books' container through ctx.container, and keeps the working copy
// cloned from the books' Artifacts repo. The spike drives it over plain HTTP (see worker.ts).

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, hook, ToolTask, type UserInput } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { ContainerExecutionEnv } from "./container-env.ts";
import { BOOKS_DIR, booksExtension, JOURNAL, MEMORY, sh } from "./extension.ts";
import { fireworksProvider, PROVIDER_ID } from "./model.ts";
import { SEED_JOURNAL, SEED_MEMORY } from "./seed.ts";

export type Env = {
  AI: Ai;
  ARTIFACTS: Artifacts;
  UPLOADS?: R2Bucket;
  BOOKKEEPER: DurableObjectNamespace<Bookkeeper>;
  GATEWAY_ID: string;
  MODEL_PROVIDER: string;
  MODEL_ID: string;
  ARTIFACTS_NAMESPACE: string;
  SPIKE_TOKEN: string;
  GATEWAY_RUN_TOKEN: string;
};

const repoName = (books: string) => `books-${books}`;
const json = (value: unknown, status = 200) => Response.json(value, { status });

/**
 * Receives the container's HTTPS requests to Artifacts and adds a short-lived, repo-scoped write token,
 * so the token never enters the sandbox. Only this books' repo is reachable.
 */
export class ArtifactsGateway extends WorkerEntrypoint<Env, { repo: string; host: string; path: string }> {
  async fetch(request: Request): Promise<Response> {
    const { repo, host, path } = this.ctx.props;
    const url = new URL(request.url);
    if (url.hostname !== host || !url.pathname.startsWith(`${path}/`)) {
      return new Response("Forbidden", { status: 403 });
    }
    const token = await (await this.env.ARTIFACTS.get(repo)).createToken("write", 900);
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${token.plaintext}`);
    return fetch(url, { method: request.method, headers, body: request.body, redirect: "manual" });
  }
}

export class Bookkeeper extends DurableObject<Env> {
  readonly registry = createRegistry();
  readonly #env = new ContainerExecutionEnv({
    id: `container:${this.ctx.id.toString()}`,
    cwd: BOOKS_DIR,
    ready: () => this.ready(),
  });
  #ready: Promise<Container> | undefined;
  #sqlCursors: { cursor: SqlStorageCursor<Record<string, SqlStorageValue>>; statement: string }[] = [];

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(CodingTools);
      this.registry.install(booksExtension);
      this.registry.install({
        name: "books.verify",
        hooks: [
          hook(ToolTask, {
            afterTool: async (call, result) => {
              if (call.name === "save" && !result.isError) await this.verifyHistory();
              return result;
            },
          }),
        ],
      });
      const models = createModels();
      models.setProvider(fireworksProvider(this.env));
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          // One working copy per set of books: tool calls run one at a time.
          settings: { toolExecution: "sequential", retry: { enabled: true, maxRetries: 5, baseDelayMs: 1000 } },
          env: () => this.#env,
          onReport: (error) => console.warn("pi report", error),
        },
        context,
      );
    },
    defaults: { model: { provider: PROVIDER_ID, id: this.env.MODEL_ID }, thinkingLevel: "low" },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#countSqlWrites();
  }

  /** Wraps sql.exec so the spike can report rows written per run. */
  #countSqlWrites() {
    const sql = this.ctx.storage.sql;
    const exec = sql.exec.bind(sql);
    try {
      (sql as { exec: typeof exec }).exec = ((query: string, ...bindings: unknown[]) => {
        const cursor = exec(query, ...(bindings as SqlStorageValue[]));
        if (this.#sqlCursors.length < 200_000) {
          // "INSERT INTO entries", "UPDATE documents", … : enough to say which table a write went to.
          const match = /^\s*(insert(?:\s+or\s+\w+)?\s+into|update|delete\s+from|replace\s+into)\s+"?([\w.]+)/i.exec(query);
          const statement = match ? `${match[1]!.split(/\s+/)[0]!.toUpperCase()} ${match[2]}` : "other";
          this.#sqlCursors.push({ cursor, statement });
        }
        return cursor;
      }) as typeof exec;
    } catch (error) {
      console.warn("Can't count SQLite writes", error);
    }
  }

  #sqlWrites(reset = false): { total: number; byStatement: Record<string, { statements: number; rows: number }> } {
    const byStatement: Record<string, { statements: number; rows: number }> = {};
    let total = 0;
    for (const { cursor, statement } of this.#sqlCursors) {
      const rows = cursor.rowsWritten;
      if (rows === 0) continue;
      total += rows;
      const slot = (byStatement[statement] ??= { statements: 0, rows: 0 });
      slot.statements++;
      slot.rows += rows;
    }
    if (reset) this.#sqlCursors = [];
    return { total, byStatement };
  }

  get #books(): string {
    return this.lifecycle.name;
  }

  #kv<T>(key: string): T | undefined {
    return this.ctx.storage.kv.get(key) as T | undefined;
  }

  /** Starts the container if needed, routes Artifacts through ArtifactsGateway, and clones the books. */
  ready(): Promise<Container> {
    this.#ready ??= this.#start().catch((error) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #start(): Promise<Container> {
    const container = this.ctx.container;
    if (!container) throw new Error("No container is configured for the bookkeeper");
    const remote = this.#kv<string>("remote");
    if (!remote) throw new Error("These books have no repo yet; POST /init first");
    const t0 = Date.now();
    const wasRunning = container.running;
    if (!wasRunning) {
      container.start({ image: container.images.books!, enableInternet: false, instance: "lite" });
      container.monitor().finally(() => {
        this.#ready = undefined;
      });
    }
    const { hostname: host, pathname: path } = new URL(remote);
    const exports = (this.ctx as unknown as { exports: Record<string, (o: object) => Fetcher> }).exports;
    await container.interceptOutboundHttps(host, exports.ArtifactsGateway!({ props: { repo: repoName(this.#books), host, path } }));
    // The first exec waits until the instance answers.
    for (let attempt = 0; ; attempt++) {
      try {
        const probe = await container.exec(["true"]);
        await probe.exitCode;
        break;
      } catch (error) {
        if (attempt > 60) throw error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const started = Date.now();
    const cloned = await this.#clone(container, remote);
    const timing = { containerStartMs: started - t0, cloneMs: Date.now() - started, wasRunning, cloned };
    this.ctx.storage.kv.put("lastStart", timing);
    console.log("container ready", timing);
    return container;
  }

  async #clone(container: Container, remote: string): Promise<boolean> {
    const run = async (script: string) => {
      const p = await container.exec(["bash", "-c", script], {
        cwd: BOOKS_DIR,
        env: { HOME: "/root", PATH: "/usr/local/bin:/usr/bin:/bin", GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt" },
        stderr: "combined",
      });
      const out = await p.output();
      return { exitCode: out.exitCode, output: new TextDecoder().decode(out.stdout) };
    };
    if ((await run("test -d .git")).exitCode === 0) return false;
    const clone = await run(
      [
        `git clone -q ${remote} .`,
        "git config user.name 'Accountant24'",
        "git config user.email 'agent@accountant24.invalid'",
        "git config core.hooksPath /dev/null",
      ].join(" && "),
    );
    if (clone.exitCode !== 0) throw new Error(`Clone failed: ${clone.output}`);
    return true;
  }

  /** The check that runs after every push: Artifacts can't refuse a force push, so detect one. */
  async verifyHistory(): Promise<{ head?: string; previous?: string; forcePush: boolean }> {
    const repo = await this.env.ARTIFACTS.get(repoName(this.#books));
    const log = await repo.log({ ref: "main", limit: 200 });
    const head = log[0]?.hash;
    const previous = this.#kv<string>("lastHead");
    const forcePush = previous !== undefined && !log.some((c) => c.hash === previous);
    if (forcePush) {
      const events = this.#kv<object[]>("forcePushes") ?? [];
      this.ctx.storage.kv.put("forcePushes", [...events, { at: new Date().toISOString(), previous, head }]);
      console.warn("force push detected", { previous, head });
    }
    if (head) this.ctx.storage.kv.put("lastHead", head);
    return { head, previous, forcePush };
  }

  async #init(): Promise<Response> {
    const t0 = Date.now();
    const name = repoName(this.#books);
    let remote = this.#kv<string>("remote");
    if (!remote) {
      try {
        remote = (await this.env.ARTIFACTS.create(name, { setDefaultBranch: "main" })).remote;
      } catch (error) {
        if ((error as { code?: string }).code !== "ALREADY_EXISTS") throw error;
        remote = (await (await this.env.ARTIFACTS.get(name)).info()).remote;
      }
      this.ctx.storage.kv.put("remote", remote);
    }
    const repoMs = Date.now() - t0;
    await this.ready();
    const context = { abortSignal: undefined } as never;
    const env: ExecutionEnv = this.#env;
    const exists = await env.exists(JOURNAL, context);
    if (exists.ok && !exists.value) {
      await env.createDir("ledger", { recursive: true }, context);
      await env.writeFile(JOURNAL, SEED_JOURNAL, context);
      await env.writeFile(MEMORY, SEED_MEMORY, context);
    }
    const push = await sh(
      this.#env,
      "git add -A && (git diff --cached --quiet || git commit -q -m 'Start the books') && git push -q origin HEAD:main && git rev-parse HEAD",
    );
    const verify = await this.verifyHistory();
    return json({ remote, repoMs, totalMs: Date.now() - t0, push, verify, lastStart: this.#kv("lastStart") });
  }

  async #prompt(session: string, text: UserInput, wait: boolean): Promise<Response> {
    this.#sqlWrites(true);
    const handle = this.harness.session(session);
    const t0 = Date.now();
    let firstTextMs: number | undefined;
    let firstEventMs: number | undefined;
    const events = wait ? await handle.events() : undefined;
    events?.start(async (batch) => {
      firstEventMs ??= Date.now() - t0;
      if (firstTextMs === undefined && batch.some((e) => e.type === "message_update")) firstTextMs = Date.now() - t0;
    });
    const receipt = await handle.submit(text);
    const submitMs = Date.now() - t0;
    if (!wait) return json({ receipt, submitMs });
    const result = await handle.wait(receipt.operationId);
    await events?.stop();
    return json({
      result,
      timings: { submitMs, firstEventMs, firstTextMs, totalMs: Date.now() - t0 },
      sqliteRowsWritten: this.#sqlWrites(),
      sqliteBytes: this.ctx.storage.sql.databaseSize,
    });
  }

  async #forcePushTest(): Promise<Response> {
    const script = [
      "git commit -q --allow-empty -m 'force-push test: A' && git push -q origin HEAD:main",
      "git reset -q --hard HEAD~1",
      "git commit -q --allow-empty -m 'force-push test: B (rewrites A away)'",
      "git push -q --force origin HEAD:main",
      "git rev-parse HEAD",
    ].join(" && ");
    await this.verifyHistory();
    const first = await sh(this.#env, script.split(" && git reset")[0]!);
    const afterA = await this.verifyHistory();
    const rest = await sh(this.#env, script.slice(script.indexOf("git reset")));
    const afterB = await this.verifyHistory();
    return json({ first, afterA, rest, afterB, detected: afterB.forcePush });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean).slice(2); // drop "books/:id"
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
    try {
      switch (`${request.method} /${parts.join("/")}`.replace(/\/chats\/[^/]+/, "/chats/:id")) {
        case "POST /init":
          return await this.#init();
        case "GET /status": {
          const container = this.ctx.container;
          return json({
            version: "v-status-2",
            books: this.#books,
            containerRunning: container?.running ?? false,
            lastStart: this.#kv("lastStart"),
            lastHead: this.#kv("lastHead"),
            forcePushes: this.#kv("forcePushes") ?? [],
            sqliteBytes: this.ctx.storage.sql.databaseSize,
            sessions: await this.harness.sessions.list(),
          });
        }
        case "POST /chats":
          return json({ session: (await this.harness.sessions.create()).id });
        case "GET /chats":
          return json(await this.harness.sessions.list());
        case "POST /chats/:id/prompt":
          return await this.#prompt(
            parts[1] ?? ROOT_SESSION,
            (Array.isArray(body.text) ? body.text : String(body.text ?? "")) as UserInput,
            body.wait !== false,
          );
        case "GET /chats/:id/messages":
          return json(await this.harness.session(parts[1]!).messages());
        case "GET /chats/:id/pending":
          return json(await this.harness.pending({ session: parts[1]! } as never));
        case "POST /exec":
          return json(await sh(this.#env, String(body.command ?? "true")));
        case "POST /verify":
          return json(await this.verifyHistory());
        case "POST /force-push-test":
          return await this.#forcePushTest();
        case "POST /crash":
          // Simulates an eviction or a deploy mid-run: the isolate dies, pi's state stays in SQLite.
          this.ctx.abort("spike: simulated crash");
          return json({ crashed: true });
        case "POST /stop-container":
          await this.ctx.container?.destroy();
          this.#ready = undefined;
          return json({ stopped: true });
        default:
          return json({ error: `No route for ${request.method} ${url.pathname}` }, 404);
      }
    } catch (error) {
      console.error("bookkeeper request failed", error);
      return json({ error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) }, 500);
    }
  }
}

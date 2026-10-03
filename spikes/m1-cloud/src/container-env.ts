// pi-durable's ExecutionEnv over one set of books' container: pi's own read/write/edit/bash tools and our
// ledger tools reach files and commands only through this.

import { posix } from "node:path";
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import {
  type ExecutionEnv,
  ExecutionError,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";

// exec's `env` replaces the environment, so commands get these plus their own.
const BASE_ENV = {
  HOME: "/root",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
};
const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

const ERRNO: Record<string, FileErrorCode> = {
  ENOENT: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  ENOTDIR: "not_directory",
  EISDIR: "is_directory",
  EINVAL: "invalid",
};

function fileError(error: unknown, path: string): FileError {
  if (SandboxFileError.is(error)) return new FileError(ERRNO[error.code] ?? "unknown", error.detail, path);
  return new FileError("unknown", error instanceof Error ? error.message : String(error), path);
}

export class ContainerExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #ready: () => Promise<Container>;

  constructor(options: { id: string; cwd: string; ready: () => Promise<Container> }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.#ready = options.ready;
  }

  async #files(): Promise<Files> {
    return new Files(await this.#ready());
  }

  #abs(path: string): string {
    return path.startsWith("/") ? posix.normalize(path) : posix.join(this.cwd, path);
  }

  async #try<T>(path: string, run: (files: Files, abs: string) => Promise<T>): Promise<Result<T, FileError>> {
    const abs = this.#abs(path);
    try {
      return ok(await run(await this.#files(), abs));
    } catch (error) {
      return fail(fileError(error, abs));
    }
  }

  async #write(path: string, run: (files: Files, abs: string) => Promise<void>): Promise<Result<void, FileError>> {
    return this.#try(path, (files, abs) => run(files, abs));
  }

  async absolutePath(path: string) {
    return ok(this.#abs(path));
  }

  async joinPath(parts: string[]) {
    return ok(posix.join(...parts));
  }

  readTextFile(path: string) {
    return this.#try(path, async (files, abs) => (await files.readFile(abs)).text());
  }

  async openTextLineReader(path: string): Promise<Result<TextLineReader, FileError>> {
    const text = await this.readTextFile(path);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    const endsWithNewline = text.value.endsWith("\n");
    if (endsWithNewline) lines.pop();
    let index = 0;
    return ok({
      readLine: async () => {
        if (index >= lines.length) return ok(undefined);
        const terminated = index < lines.length - 1 || endsWithNewline;
        return ok({ text: lines[index++]!, terminated });
      },
      close: async () => {},
    });
  }

  async readTextLines(path: string, options: { maxLines?: number } | undefined) {
    const text = await this.readTextFile(path);
    if (!text.ok) return text;
    const lines = text.value.split("\n");
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  readBinaryFile(path: string) {
    return this.#try(
      path,
      async (files, abs) => new Uint8Array(await (await files.readFile(abs)).arrayBuffer()),
    );
  }

  writeFile(path: string, content: string | Uint8Array) {
    return this.#write(path, async (files, abs) => files.writeFile(abs, content));
  }

  async appendFile(path: string, content: string | Uint8Array) {
    const existing = await this.readBinaryFile(path);
    if (!existing.ok && existing.error.code !== "not_found") return existing;
    const before = existing.ok ? existing.value : new Uint8Array();
    const added = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const joined = new Uint8Array(before.length + added.length);
    joined.set(before);
    joined.set(added, before.length);
    return this.writeFile(path, joined);
  }

  async truncateFile(path: string, size: number) {
    return this.#shellFile(path, `truncate -s ${Math.floor(size)} "$1"`);
  }

  async flushFile() {
    return ok(undefined);
  }

  renameFile(sourcePath: string, destinationPath: string) {
    const destination = this.#abs(destinationPath);
    return this.#write(sourcePath, (files, abs) => files.rename(abs, destination));
  }

  fileInfo(path: string) {
    return this.#try(path, async (files, abs): Promise<FileInfo> => {
      const stat = await files.lstat(abs);
      return {
        name: posix.basename(abs),
        path: abs,
        kind: stat.type === "directory" ? "directory" : stat.type === "symlink" ? "symlink" : "file",
        size: Number(stat.size),
        mtimeMs: stat.modifiedAt.getTime(),
      };
    });
  }

  listDir(path: string) {
    return this.#try(path, async (files, abs): Promise<FileInfo[]> => {
      const entries = await files.readDirectory(abs);
      return entries.map((entry) => ({
        name: entry.name,
        path: posix.join(abs, entry.name),
        kind: entry.type === "directory" ? "directory" : entry.type === "symlink" ? "symlink" : "file",
        size: 0,
        mtimeMs: 0,
      }));
    });
  }

  async canonicalPath(path: string): Promise<Result<string, FileError>> {
    const abs = this.#abs(path);
    const result = await this.#run(["realpath", "-e", abs]);
    if (result.exitCode !== 0) return fail(new FileError("not_found", result.output.trim(), abs));
    return ok(result.output.trim());
  }

  async exists(path: string): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(path);
    if (info.ok) return ok(true);
    return info.error.code === "not_found" ? ok(false) : fail(info.error);
  }

  createDir(path: string, options: { recursive?: boolean } | undefined) {
    return this.#write(path, (files, abs) => files.mkdir(abs, { recursive: options?.recursive ?? false }));
  }

  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined) {
    return this.#try(path, async (files, abs) => {
      try {
        await files.remove(abs, { recursive: options?.recursive ?? false });
      } catch (error) {
        if (!(options?.force && SandboxFileError.is(error) && error.code === "ENOENT")) throw error;
      }
    });
  }

  async createTempDir(prefix: string | undefined): Promise<Result<string, FileError>> {
    const result = await this.#run(["mktemp", "-d", `/tmp/${prefix ?? "pi"}XXXXXX`]);
    return result.exitCode === 0 ? ok(result.output.trim()) : fail(new FileError("unknown", result.output, "/tmp"));
  }

  async createTempFile(options: { prefix?: string; suffix?: string } | undefined): Promise<Result<string, FileError>> {
    const template = `/tmp/${options?.prefix ?? "pi"}XXXXXX${options?.suffix ?? ""}`;
    const args = options?.suffix ? ["mktemp", "--suffix", options.suffix, template.slice(0, -options.suffix.length)] : ["mktemp", template];
    const result = await this.#run(args);
    return result.exitCode === 0 ? ok(result.output.trim()) : fail(new FileError("unknown", result.output, "/tmp"));
  }

  async cleanup() {}

  async #shellFile(path: string, script: string): Promise<Result<void, FileError>> {
    const abs = this.#abs(path);
    const result = await this.#run(["sh", "-c", script, "sh", abs]);
    return result.exitCode === 0 ? ok(undefined) : fail(new FileError("unknown", result.output, abs));
  }

  async #run(argv: string[], options: { cwd?: string; signal?: AbortSignal } = {}) {
    const container = await this.#ready();
    const process = await container.exec(argv, {
      cwd: options.cwd ?? this.cwd,
      env: BASE_ENV,
      stderr: "combined",
      signal: options.signal,
    });
    const out = await process.output();
    return { exitCode: out.exitCode, output: new TextDecoder().decode(out.stdout) };
  }

  async exec(
    command: string,
    options: ShellExecOptions | undefined,
    context: { abortSignal: AbortSignal | undefined } & object,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const signals = [context.abortSignal, options?.timeout ? AbortSignal.timeout(options.timeout * 1000) : undefined];
    const signal = AbortSignal.any(signals.filter((s): s is AbortSignal => s !== undefined));
    let container: Container;
    try {
      container = await this.#ready();
    } catch (error) {
      return fail(new ExecutionError("shell_unavailable", (error as Error).message));
    }
    try {
      const process = await container.exec(["bash", "-c", command], {
        cwd: options?.cwd ?? this.cwd,
        env: { ...BASE_ENV, ...options?.env },
        stderr: "combined",
        signal,
      });
      const decoder = new TextDecoder();
      let bytes = 0;
      let lines = 0;
      const chunks: string[] = [];
      if (process.stdout) {
        for await (const chunk of process.stdout as unknown as AsyncIterable<Uint8Array>) {
          const text = decoder.decode(chunk, { stream: true });
          bytes += chunk.byteLength;
          lines += text.split("\n").length - 1;
          chunks.push(text);
          options?.onOutput?.(text, context as never);
        }
      }
      const exitCode = await process.exitCode;
      const spill = options?.spill;
      if (spill && (bytes > spill.afterBytes || lines > spill.afterLines)) {
        const path = await this.createTempFile({ prefix: "pi-spill-", suffix: ".log" });
        if (path.ok) {
          await this.writeFile(path.value, chunks.join(""));
          return ok({ exitCode, spillPath: path.value });
        }
      }
      return ok({ exitCode });
    } catch (error) {
      if (signal.aborted) {
        const timedOut = !context.abortSignal?.aborted;
        return fail(new ExecutionError(timedOut ? "timeout" : "aborted", timedOut ? "Command timed out" : "Command aborted"));
      }
      return fail(new ExecutionError("spawn_error", (error as Error).message));
    }
  }
}

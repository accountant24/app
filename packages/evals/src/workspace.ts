// Builds the disposable workspace a case runs in: the stock template, the
// case's fixture laid over it, committed as the starting point. Attachments are
// archived into it the way the desktop app does (files/YYYY/MM/<stamp>.<ext>):
// images also travel as image content, everything else as an `[[attachment]]`
// marker line the agent resolves to that path.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { EvalCase, Turn } from "./cases";

export const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Fresh temp workspace for one (case, rep), committed as the fixture. */
export function prepareWorkspace(c: EvalCase, fixturesDir: string): string {
  const ws = mkdtempSync(join(tmpdir(), `a24-eval-${c.id}-`));
  cpSync(join(fixturesDir, "_template"), ws, { recursive: true });
  // Stored without the dot so it doesn't apply to this repo.
  renameSync(join(ws, "gitignore"), join(ws, ".gitignore"));
  if (c.fixture !== "_template") cpSync(join(fixturesDir, c.fixture), ws, { recursive: true });
  if (existsSync(join(c.dir, "workspace"))) cpSync(join(c.dir, "workspace"), ws, { recursive: true });
  for (const dir of ["ledger", "files", "sessions"]) mkdirSync(join(ws, dir), { recursive: true });
  git(ws, "init", "-q");
  git(ws, "config", "user.name", "Accountant24 Eval");
  git(ws, "config", "user.email", "eval@accountant24.invalid");
  git(ws, "config", "commit.gpgsign", "false");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "Fixture");
  if (c.setupCommit) {
    cpSync(join(c.dir, "commit"), ws, { recursive: true });
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", c.setupCommit.message);
  }
  return ws;
}

export type ImageContent = { type: "image"; data: string; mimeType: string };
export type PreparedTurn = { text: string; images: ImageContent[] };

/** Archive a turn's attachments into the workspace and build the message pi receives. */
export function prepareTurn(turn: Turn, caseDir: string, ws: string, now: Date): PreparedTurn {
  const images: ImageContent[] = [];
  const markers: string[] = [];
  for (const name of turn.attachments ?? []) {
    const source = join(caseDir, name);
    const stored = archive(source, ws, now);
    const mimeType = IMAGE_TYPES[extname(name).toLowerCase()];
    if (mimeType) images.push({ type: "image", data: readFileSync(source).toString("base64"), mimeType });
    else markers.push(attachmentMarker(name, stored, statSync(source).size));
  }
  return { text: [turn.text, ...markers].join("\n"), images };
}

export function attachmentMarker(name: string, path: string, size: number): string {
  return `[[attachment]]${JSON.stringify({ name, path, size })}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Copy into files/YYYY/MM/<stamp><ext>; returns the workspace-relative path. */
function archive(source: string, ws: string, now: Date): string {
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const dir = join(ws, "files", year, month);
  mkdirSync(dir, { recursive: true });
  const stamp = `${year}${month}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const ext = extname(source);
  let name = `${stamp}${ext}`;
  for (let n = 2; existsSync(join(dir, name)); n++) name = `${stamp}-${n}${ext}`;
  writeFileSync(join(dir, name), readFileSync(source));
  return `files/${year}/${month}/${name}`;
}

export { git };

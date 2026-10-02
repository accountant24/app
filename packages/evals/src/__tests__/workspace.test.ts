import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { EvalCase } from "../cases";
import { attachmentMarker, prepareTurn, prepareWorkspace } from "../workspace";

const BASE = mkdtempSync(join(tmpdir(), "a24-workspace-"));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

function write(path: string, content: string | Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

const FIXTURES = join(BASE, "fixtures");
write(join(FIXTURES, "_template", "gitignore"), "sessions/\n");
write(join(FIXTURES, "_template", "memory.md"), "");
write(join(FIXTURES, "_template", "ledger", "main.journal"), "; template\n");
write(join(FIXTURES, "household", "memory.md"), "- Default currency: USD.\n");

const CASE_DIR = join(BASE, "cases", "undo");
write(join(CASE_DIR, "workspace", "ledger", "extra.journal"), "; overlay\n");
write(join(CASE_DIR, "commit", "ledger", "main.journal"), "; mistaken change\n");
write(join(CASE_DIR, "receipt.png"), Buffer.from([1, 2, 3]));
write(join(CASE_DIR, "statement.pdf"), "%PDF-1.4 x");

const CASE: EvalCase = {
  id: "undo",
  tags: ["edit"],
  why: "w",
  source: ["sessions"],
  fixture: "household",
  turns: [{ text: "x" }],
  expect: { countDelta: 0 },
  dir: CASE_DIR,
};

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("prepareWorkspace()", () => {
  test("should lay the fixture and the case overlay over the template and commit them as the starting point", () => {
    const ws = prepareWorkspace({ ...CASE, setupCommit: undefined }, FIXTURES);
    expect(readFileSync(join(ws, ".gitignore"), "utf8")).toBe("sessions/\n");
    expect(existsSync(join(ws, "gitignore"))).toBe(false);
    expect(readFileSync(join(ws, "memory.md"), "utf8")).toBe("- Default currency: USD.\n");
    expect(readFileSync(join(ws, "ledger", "extra.journal"), "utf8")).toBe("; overlay\n");
    expect(existsSync(join(ws, "files"))).toBe(true);
    expect(git(ws, "log", "--format=%s")).toBe("Fixture");
    expect(git(ws, "status", "--porcelain")).toBe("");
  });

  test("should add a setup commit on top of the fixture when the case has one", () => {
    const ws = prepareWorkspace({ ...CASE, setupCommit: { message: "Add a mistaken dinner" } }, FIXTURES);
    expect(git(ws, "log", "--format=%s")).toBe("Add a mistaken dinner\nFixture");
    expect(readFileSync(join(ws, "ledger", "main.journal"), "utf8")).toBe("; mistaken change\n");
  });

  test("should use the template alone for the _template fixture", () => {
    const ws = prepareWorkspace({ ...CASE, fixture: "_template", setupCommit: undefined }, FIXTURES);
    expect(readFileSync(join(ws, "memory.md"), "utf8")).toBe("");
  });
});

describe("prepareTurn()", () => {
  const now = new Date(2026, 9, 2, 14, 5, 9);

  test("should send an image as image content and archive it", () => {
    const ws = prepareWorkspace({ ...CASE, setupCommit: undefined }, FIXTURES);
    const turn = prepareTurn({ text: "Paid cash.", attachments: ["receipt.png"] }, CASE_DIR, ws, now);
    expect(turn).toEqual({ text: "Paid cash.", images: [{ type: "image", data: "AQID", mimeType: "image/png" }] });
    expect(readFileSync(join(ws, "files", "2026", "10", "20261002140509.png"))).toEqual(Buffer.from([1, 2, 3]));
  });

  test("should send a document as a marker line pointing at its archived copy", () => {
    const ws = prepareWorkspace({ ...CASE, setupCommit: undefined }, FIXTURES);
    const turn = prepareTurn({ text: "Import this.", attachments: ["statement.pdf"] }, CASE_DIR, ws, now);
    expect(turn.images).toEqual([]);
    expect(turn.text).toBe(
      'Import this.\n[[attachment]]{"name":"statement.pdf","path":"files/2026/10/20261002140509.pdf","size":10}',
    );
  });

  test("should give a second file archived in the same second its own name", () => {
    const ws = prepareWorkspace({ ...CASE, setupCommit: undefined }, FIXTURES);
    const turn = prepareTurn({ text: "Two.", attachments: ["statement.pdf", "statement.pdf"] }, CASE_DIR, ws, now);
    expect(turn.text).toContain('"path":"files/2026/10/20261002140509.pdf"');
    expect(turn.text).toContain('"path":"files/2026/10/20261002140509-2.pdf"');
  });

  test("should pass the text through when there are no attachments", () => {
    const ws = prepareWorkspace({ ...CASE, setupCommit: undefined }, FIXTURES);
    expect(prepareTurn({ text: "Hello." }, CASE_DIR, ws, now)).toEqual({ text: "Hello.", images: [] });
  });
});

describe("attachmentMarker()", () => {
  test("should encode name, path and size on one line the way the desktop app does", () => {
    expect(attachmentMarker("a b.csv", "files/2026/10/x.csv", 42)).toBe(
      '[[attachment]]{"name":"a b.csv","path":"files/2026/10/x.csv","size":42}',
    );
  });
});

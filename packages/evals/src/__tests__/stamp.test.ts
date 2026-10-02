import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { computeStamp, hashFiles, type Stamp, stampDiff } from "../stamp";

const BASE = mkdtempSync(join(tmpdir(), "a24-stamp-"));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

function tree(name: string, files: Record<string, string>): string {
  const root = join(BASE, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

describe("hashFiles()", () => {
  test("should give the same short hash for the same names and contents", () => {
    const a = tree("a", { "x/one.txt": "1", "two.txt": "2" });
    const b = tree("b", { "x/one.txt": "1", "two.txt": "2" });
    expect(hashFiles([a], a)).toMatch(/^[0-9a-f]{12}$/);
    expect(hashFiles([a], a)).toBe(hashFiles([b], b));
  });

  test("should change when a file's content changes", () => {
    const a = tree("c", { "one.txt": "1" });
    const b = tree("d", { "one.txt": "2" });
    expect(hashFiles([a], a)).not.toBe(hashFiles([b], b));
  });

  test("should change when a file is renamed", () => {
    const a = tree("e", { "one.txt": "1" });
    const b = tree("f", { "uno.txt": "1" });
    expect(hashFiles([a], a)).not.toBe(hashFiles([b], b));
  });

  test("should ignore .git folders and paths that don't exist", () => {
    const a = tree("g", { "one.txt": "1" });
    const b = tree("h", { "one.txt": "1", ".git/HEAD": "ref" });
    expect(hashFiles([b, join(BASE, "missing")], b)).toBe(hashFiles([a], a));
  });

  test("should hash a single file path", () => {
    const a = tree("i", { "system.md": "prompt" });
    expect(hashFiles([join(a, "system.md")], a)).toBe(hashFiles([a], a));
  });
});

describe("computeStamp()", () => {
  test("should hash cases, harness and agent separately and read the pi version", () => {
    const root = tree("repo", {
      "packages/evals/cases/c/case.json": "{}",
      "packages/evals/fixtures/f/memory.md": "",
      "packages/evals/src/run.ts": "run",
      "packages/desktop/resources/system.md": "prompt",
      "node_modules/@earendil-works/pi-coding-agent/package.json": '{"version":"0.84.1"}',
    });
    const stamp = computeStamp(join(root, "packages", "evals"), root);
    expect(stamp.pi).toBe("0.84.1");
    expect(new Set([stamp.cases, stamp.harness, stamp.agent]).size).toBe(3);
  });

  test("should say unknown when pi is not installed", () => {
    const root = tree("bare", { "packages/evals/src/run.ts": "run" });
    expect(computeStamp(join(root, "packages", "evals"), root).pi).toBe("unknown");
  });
});

describe("stampDiff()", () => {
  const a: Stamp = { cases: "c1", harness: "h1", agent: "a1", pi: "0.84.1" };

  test("should be empty for identical stamps", () => {
    expect(stampDiff(a, { ...a })).toEqual([]);
  });

  test("should name every part that differs", () => {
    expect(stampDiff(a, { ...a, cases: "c2", pi: "0.85.0" })).toEqual(["cases", "pi"]);
  });
});

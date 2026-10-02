import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { type EvalCase, loadCases, validateCase } from "../cases";

const BASE = mkdtempSync(join(tmpdir(), "a24-cases-"));
afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const VALID: Omit<EvalCase, "dir"> = {
  id: "quick-cash-entry",
  tags: ["entry", "cash"],
  why: "Short messages are a big part of daily use.",
  source: ["sessions"],
  fixture: "household",
  turns: [{ text: "Spent $14.80 at the farmers market, cash.", attachments: ["receipt.png"] }],
  expect: { countDelta: 1 },
};

const yes = () => true;
const no = () => false;

describe("validateCase()", () => {
  test("should accept a complete case", () => {
    expect(validateCase(VALID, yes, yes)).toEqual([]);
  });

  test("should require a kebab-case id", () => {
    expect(validateCase({ ...VALID, id: "Quick_Cash" }, yes, yes)).toEqual(["id must be kebab-case"]);
  });

  test("should require why and source", () => {
    expect(validateCase({ ...VALID, why: " ", source: [] }, yes, yes)).toEqual([
      "why is required: one or two sentences on what the case guards and where that came from",
      "source must list at least one of sessions, system.md, coverage",
    ]);
  });

  test("should keep why short", () => {
    expect(validateCase({ ...VALID, why: "x".repeat(401) }, yes, yes)).toEqual([
      "why must stay short (400 characters at most)",
    ]);
  });

  test("should reject an unknown source", () => {
    expect(validateCase({ ...VALID, source: ["sessions", "vibes" as never] }, yes, yes)).toEqual([
      'unknown source "vibes"',
    ]);
  });

  test("should require tags, a fixture that exists, and turns with text", () => {
    expect(validateCase({ ...VALID, tags: [], fixture: "", turns: [] }, yes, yes)).toEqual([
      "tags must be a non-empty list",
      "fixture is required",
      "turns must be a non-empty list",
    ]);
    expect(validateCase({ ...VALID, fixture: "missing" }, no, yes)).toEqual(['fixture "missing" not found']);
    expect(validateCase({ ...VALID, turns: [{ text: "" }] }, yes, yes)).toEqual(["every turn needs text"]);
  });

  test("should report an attachment that is missing", () => {
    expect(validateCase(VALID, yes, no)).toEqual(['attachment "receipt.png" not found']);
  });

  test("should require at least one expectation", () => {
    expect(validateCase({ ...VALID, expect: {} }, yes, yes)).toEqual(["expect must hold at least one check"]);
  });

  test("should check transaction patterns for postings, dates and the old note field", () => {
    const problems = validateCase(
      {
        ...VALID,
        expect: {
          present: [{ date: ["2026-09-30", "yesterday"], postings: [] }],
          absent: [{ postings: undefined as never, note: "x" } as never],
        },
      },
      yes,
      yes,
    );
    expect(problems).toEqual([
      'bad date "yesterday"',
      "every transaction pattern needs postings",
      "use description instead of note",
    ]);
  });

  test("should accept relative dates", () => {
    expect(validateCase({ ...VALID, expect: { present: [{ date: "today-1", postings: [] }] } }, yes, yes)).toEqual([]);
  });
});

describe("loadCases()", () => {
  const casesDir = join(BASE, "cases");
  const fixturesDir = join(BASE, "fixtures");
  mkdirSync(join(fixturesDir, "household"), { recursive: true });

  const writeCase = (folder: string, c: object, files: string[] = []) => {
    mkdirSync(join(casesDir, folder), { recursive: true });
    writeFileSync(join(casesDir, folder, "case.json"), JSON.stringify(c));
    for (const f of files) writeFileSync(join(casesDir, folder, f), "x");
  };

  test("should load valid cases sorted by folder, with their folder path", () => {
    writeCase("b-case", { ...VALID, id: "b-case" }, ["receipt.png"]);
    writeCase("a-case", { ...VALID, id: "a-case" }, ["receipt.png"]);
    mkdirSync(join(casesDir, "not-a-case"), { recursive: true });
    const cases = loadCases(casesDir, fixturesDir);
    expect(cases.map((c) => c.id)).toEqual(["a-case", "b-case"]);
    expect(cases[0].dir).toBe(join(casesDir, "a-case"));
  });

  test("should throw with the folder name and every problem of an invalid case", () => {
    writeCase("c-case", { ...VALID, id: "other-id", why: "" }, ["receipt.png"]);
    expect(() => loadCases(casesDir, fixturesDir)).toThrow(
      'cases/c-case: why is required: one or two sentences on what the case guards and where that came from; id "other-id" must equal its folder name "c-case"',
    );
  });
});

// What a set of results was produced against. Two results compare fairly only
// when they ran the same cases, under the same harness, with the same agent
// (prompt, extension, skills, pi). Each variant records its stamp, the runner
// refuses to mix runs from different stamps in one variant, and the report
// warns when variants in one run set differ.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export type Stamp = {
  /** Case files, their attachments and the fixtures. */
  cases: string;
  /** The runner and grader sources. */
  harness: string;
  /** system.md, the bundled extension and the default skills. */
  agent: string;
  /** pi-coding-agent version. */
  pi: string;
};

/** Every file under each path (or the path itself), in a stable order. */
function files(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    if (statSync(p).isFile()) out.push(p);
    else
      for (const f of readdirSync(p, { recursive: true, encoding: "utf8" })) {
        const full = join(p, f);
        if (statSync(full).isFile() && !f.split("/").includes(".git")) out.push(full);
      }
  }
  return out.sort();
}

/** sha256 over relative names and contents, shortened to 12 hex characters. */
export function hashFiles(paths: string[], root: string): string {
  const h = createHash("sha256");
  for (const f of files(paths)) h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex").slice(0, 12);
}

export function computeStamp(pkg: string, root: string): Stamp {
  const resources = join(root, "packages", "desktop", "resources");
  const piPackage = join(root, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  return {
    cases: hashFiles([join(pkg, "cases"), join(pkg, "fixtures")], root),
    harness: hashFiles([join(pkg, "src")], root),
    agent: hashFiles([join(resources, "system.md"), join(resources, "accountant24-extension.js"), join(pkg, ".cache", "skills", "skills")], root),
    pi: existsSync(piPackage) ? (JSON.parse(readFileSync(piPackage, "utf8")) as { version: string }).version : "unknown",
  };
}

/** The parts of two stamps that differ (empty = comparable). */
export function stampDiff(a: Stamp, b: Stamp): (keyof Stamp)[] {
  return (Object.keys(a) as (keyof Stamp)[]).filter((k) => a[k] !== b[k]);
}

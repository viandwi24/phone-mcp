#!/usr/bin/env node
/**
 * Bump the version across the monorepo in one shot.
 *
 *   node scripts/bump.mjs patch        # 0.1.0 -> 0.1.1
 *   node scripts/bump.mjs minor        # 0.1.1 -> 0.2.0
 *   node scripts/bump.mjs major        # 0.2.0 -> 1.0.0
 *   node scripts/bump.mjs 1.4.2        # set an explicit version
 *
 * The root package.json `version` is the single source of truth: pushing a bump
 * to `main` triggers the release workflow, which tags v<version> and builds the
 * APK. See .github/workflows/release.yml.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = [
  "package.json",
  "packages/shared/package.json",
  "packages/server/package.json",
  "packages/mcp/package.json",
];

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/bump.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cur = rootPkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
if (!m) {
  console.error(`current version is not plain semver: ${cur}`);
  process.exit(1);
}
let [maj, min, pat] = m.slice(1).map(Number);

let next;
if (arg === "major") next = `${maj + 1}.0.0`;
else if (arg === "minor") next = `${maj}.${min + 1}.0`;
else if (arg === "patch") next = `${maj}.${min}.${pat + 1}`;
else if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  console.error(`invalid argument: ${arg}`);
  process.exit(1);
}

for (const rel of manifests) {
  const p = join(root, rel);
  const pkg = JSON.parse(readFileSync(p, "utf8"));
  pkg.version = next;
  writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${rel}: ${cur} -> ${next}`);
}

console.log(`\nBumped to ${next}.`);
console.log("Next: commit, push to main, and the release workflow tags v" + next + " + builds the APK.");

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const versionBumpScript = path.join(repoRoot, "scripts/version-bump.js");

test("version-bump prints usage when no target is provided", () => {
  const res = spawnSync(process.execPath, [versionBumpScript], { cwd: repoRoot, encoding: "utf8" });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Usage: npm run version:bump --/);
});

test("version-bump rejects unsupported targets before touching package metadata", () => {
  const res = spawnSync(process.execPath, [versionBumpScript, "banana"], { cwd: repoRoot, encoding: "utf8" });

  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unsupported version target: banana/);
  assert.match(res.stderr, /Usage: npm run version:bump --/);
});

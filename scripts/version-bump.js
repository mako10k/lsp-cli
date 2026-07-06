#!/usr/bin/env node
"use strict";

const { readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bumpKinds = new Set(["major", "minor", "patch", "premajor", "preminor", "prepatch", "prerelease"]);
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function usage(exitCode) {
  const message = [
    "Usage: npm run version:bump -- <patch|minor|major|prerelease|x.y.z>",
    "",
    "Updates package.json and package-lock.json without creating a git tag.",
    "The git worktree must be clean before running this command."
  ].join("\n");
  (exitCode === 0 ? console.log : console.error)(message);
  process.exit(exitCode);
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { cwd: repoRoot, ...opts });
  if (res.error) {
    console.error(`[version:bump] failed to start ${command}: ${res.error.message}`);
    process.exit(1);
  }
  return res;
}

function ensureCleanWorktree() {
  const res = run("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (res.status !== 0) {
    console.error("[version:bump] failed to inspect git status.");
    process.exit(res.status ?? 1);
  }
  if (res.stdout.trim()) {
    console.error("[version:bump] git worktree is not clean; commit or stash changes first.");
    process.exit(1);
  }
}

const target = process.argv[2];
if (target === "-h" || target === "--help") usage(0);
if (!target || process.argv.length > 3) usage(1);
if (!bumpKinds.has(target) && !semverPattern.test(target)) {
  console.error(`[version:bump] unsupported version target: ${target}`);
  usage(1);
}

ensureCleanWorktree();

const bump = run(npm, ["version", target, "--no-git-tag-version"], { stdio: "inherit" });
if (bump.status !== 0) process.exit(bump.status ?? 1);

const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
console.log(`[version:bump] updated package metadata to ${pkg.version}.`);
console.log("[version:bump] Next: update CHANGELOG.md, run npm run release:check, commit, then tag/publish as appropriate.");

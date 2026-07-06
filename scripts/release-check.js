#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const forbiddenPackPathPatterns = [/^dist\/test\//, /^dist\/mock\//, /^src\//, /^scripts\//];

const steps = [
  { label: "Typecheck", command: npm, args: ["run", "typecheck"] },
  { label: "Build", command: npm, args: ["run", "build"] },
  { label: "Unit tests", command: npm, args: ["run", "test:unit"] }
];

function runStep(step, opts = { stdio: "inherit" }) {
  console.log(`\n==> ${step.label}: ${step.command} ${step.args.join(" ")}`);
  const res = spawnSync(step.command, step.args, { cwd: repoRoot, ...opts });
  if (res.error) {
    console.error(`[release:check] failed to start ${step.command}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[release:check] ${step.label} failed with exit code ${res.status ?? 1}`);
    process.exit(res.status ?? 1);
  }
  return res;
}

function parsePackJson(stdout) {
  const start = stdout.lastIndexOf("\n[");
  const jsonText = (start >= 0 ? stdout.slice(start + 1) : stdout).trim();
  return JSON.parse(jsonText);
}

function runPackDryRun() {
  const step = { label: "Package dry run", command: npm, args: ["pack", "--dry-run", "--json"] };
  console.log(`\n==> ${step.label}: ${step.command} ${step.args.join(" ")}`);
  const res = spawnSync(step.command, step.args, { cwd: repoRoot, encoding: "utf8" });
  if (res.error) {
    console.error(`[release:check] failed to start ${step.command}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    console.error(`[release:check] ${step.label} failed with exit code ${res.status ?? 1}`);
    process.exit(res.status ?? 1);
  }

  let pack;
  try {
    [pack] = parsePackJson(res.stdout);
  } catch (err) {
    console.error(`[release:check] failed to parse npm pack --json output: ${err.message}`);
    process.exit(1);
  }

  const files = Array.isArray(pack?.files) ? pack.files.map((file) => String(file.path)) : [];
  const forbidden = files.filter((file) => forbiddenPackPathPatterns.some((pattern) => pattern.test(file)));
  if (forbidden.length) {
    console.error(`[release:check] package contains development-only files: ${forbidden.join(", ")}`);
    process.exit(1);
  }
  console.log(`[release:check] package ${pack.filename} contains ${files.length} runtime files (${pack.size} bytes).`);
}

for (const step of steps) {
  runStep(step);
}

runPackDryRun();

console.log("\nrelease:check passed.");

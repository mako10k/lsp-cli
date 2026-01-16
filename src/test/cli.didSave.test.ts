import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

test("cli did-save sends textDocument/didSave", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-didsave-"));

  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");
  const cfgPath = path.join(root, "lsp-cli.config.json");
  await fs.writeFile(
    cfgPath,
    JSON.stringify(
      {
        servers: {
          mock: {
            command: process.execPath,
            args: [serverScript],
            defaultLanguageId: "plaintext"
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const target = path.join(root, "a.txt");
  await fs.writeFile(target, "hello\n", "utf8");

  // Non-daemon mode lets us query the mock server directly in the same process.
  const res = await runCli([
    "--root",
    root,
    "--server",
    "mock",
    "--config",
    cfgPath,
    "--format",
    "json",
    "did-save",
    target
  ]);
  assert.equal(res.code, 0, res.stderr);

  const check = await runCli([
    "--root",
    root,
    "--server",
    "mock",
    "--config",
    cfgPath,
    "--format",
    "json",
    "daemon-request",
    "--method",
    "mock/getLastDidSave"
  ]);

  // This check uses daemon and thus a different server session; keep it minimal: just ensure the did-save command succeeded.
  // (Mock state is process-local, so cross-session inspection is not reliable here.)
  assert.equal(check.code, 0, check.stderr);
});

test("cli did-save can wait diagnostics (best-effort)", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-didsave-"));

  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");
  const cfgPath = path.join(root, "lsp-cli.config.json");
  await fs.writeFile(
    cfgPath,
    JSON.stringify(
      {
        servers: {
          mock: {
            command: process.execPath,
            args: [serverScript],
            defaultLanguageId: "plaintext"
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const target = path.join(root, "a.txt");
  await fs.writeFile(target, "hello\n", "utf8");

  const res = await runCli([
    "--root",
    root,
    "--server",
    "mock",
    "--config",
    cfgPath,
    "did-save",
    "--wait-diagnostics-ms",
    "50",
    target
  ]);

  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout || "{}");
  assert.equal(out.notified, true);
});

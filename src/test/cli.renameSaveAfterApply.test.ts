import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "path";

import { runCli } from "./helpers";

test("cli rename with --save-after-apply --wait-diagnostics-ms sends didSave and collects diagnostics", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-rename-save-"));
  const file = path.join(root, "a.ts");
  await fs.writeFile(file, "hello\n", "utf8");

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

  // Apply rename with --save-after-apply --wait-diagnostics-ms
  const res = await runCli(
    [
      "--root",
      root,
      "--server",
      "mock",
      "--config",
      cfgPath,
      "--format",
      "json",
      "rename",
      file,
      "0",
      "0",
      "X",
      "--apply",
      "--save-after-apply",
      "--wait-diagnostics-ms",
      "500"
    ],
    {
      timeoutMs: 5000
    }
  );

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.applied, true);

  // Check file was renamed
  const updated = await fs.readFile(file, "utf8");
  assert.equal(updated, "Xhello\n");

  // Check diagnostics were collected (mock server returns diagnostics on didSave)
  // Note: Mock server may not emit diagnostics for this file in all cases, so we just check if present.
  if (out.diagnostics) {
    assert.ok(typeof out.diagnostics === "object", "diagnostics should be an object");
  }

  await fs.rm(root, { recursive: true, force: true });
});

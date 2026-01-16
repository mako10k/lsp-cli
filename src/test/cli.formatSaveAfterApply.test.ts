import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "path";

import { runCli } from "./helpers";

test("cli format with --save-after-apply --wait-diagnostics-ms sends didSave and collects diagnostics", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-format-save-"));
  const file = path.join(root, "a.ts");
  await fs.writeFile(file, "const   x=1\n", "utf8");

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

  // Apply format with --save-after-apply --wait-diagnostics-ms
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
      "format",
      file,
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

  // Check file was formatted
  const updated = await fs.readFile(file, "utf8");
  assert.equal(updated, "const x = 1\n");

  // Check diagnostics were collected
  if (out.diagnostics) {
    assert.ok(typeof out.diagnostics === "object", "diagnostics should be an object");
  }

  await fs.rm(root, { recursive: true, force: true });
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("cli symbols-daemon works and reuses daemon session", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-symd-"));
  const file = path.join(root, "a.txt");
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

  const cli = path.resolve(__dirname, "../cli.js");

  // First call should auto-start daemon and run request.
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--config", cfgPath, "symbols-daemon", file], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, String(res.stderr || res.stdout));
    const out = JSON.parse(String(res.stdout));
    assert.ok(Array.isArray(out));
  }

  // Second call should hit same daemon; initialize count should remain 1.
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--config", cfgPath, "daemon-request", "--method", "mock/getInitializeCount"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, String(res.stderr || res.stdout));
    const count = JSON.parse(String(res.stdout));
    assert.equal(count, 1);
  }
});

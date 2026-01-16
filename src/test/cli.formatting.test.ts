import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

test("cli format can dry-run and apply formatting edits", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-format-"));
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

  // Dry-run
  {
    const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "format", file], {
      timeoutMs: 5000
    });
    assert.equal(res.code, 0, res.stderr);

    const out = JSON.parse(res.stdout);
    assert.ok(out);
    assert.ok(out.changes);

    const unchanged = await fs.readFile(file, "utf8");
    assert.equal(unchanged, "const   x=1\n");
  }

  // Apply
  {
    const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "format", file, "--apply"], {
      timeoutMs: 5000
    });

    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.applied, true);

    const after = await fs.readFile(file, "utf8");
    assert.equal(after, "const x = 1\nconst   x=1\n");
  }
});

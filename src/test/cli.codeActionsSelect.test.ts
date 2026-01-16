import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("cli code-actions can auto-select by kind/title and apply", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-cli-"));
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

  // Apply the edit-based action (preferred)
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "code-actions", file, "0", "0", "0", "0", "--apply", "--preferred", "--first"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.applied, true);
    assert.equal(out.via, "edit");

    const updated = await fs.readFile(file, "utf8");
    assert.equal(updated, "Ehello\n");
  }

  // Apply the command-based action by kind
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "code-actions", file, "0", "0", "0", "0", "--apply", "--kind", "refactor.mock", "--first"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.applied, true);
    assert.equal(out.via, "command");

    const updated = await fs.readFile(file, "utf8");
    assert.equal(updated, "CEhello\n");
  }

  // Dry-run select by title-regex
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "code-actions", file, "0", "0", "0", "0", "--title-regex", "Mock edit", "--first"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.dryRun, true);
    assert.equal(out.index, 0);
  }
});

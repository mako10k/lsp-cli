import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("cli apply-edits can dry-run and apply WorkspaceEdit", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-apply-edits-"));
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "hello\n", "utf8");

  const cli = path.resolve(__dirname, "../cli.js");
  const uri = require("node:url").pathToFileURL(file).toString();

  const edit = {
    changes: {
      [uri]: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "X"
        }
      ]
    }
  };

  // Dry-run
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--format", "json", "apply-edits"], {
      input: JSON.stringify(edit),
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out);

    const unchanged = await fs.readFile(file, "utf8");
    assert.equal(unchanged, "hello\n");
  }

  // Apply
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--format", "json", "apply-edits", "--apply"], {
      input: JSON.stringify(edit),
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.applied, true);

    const updated = await fs.readFile(file, "utf8");
    assert.equal(updated, "Xhello\n");
  }
});

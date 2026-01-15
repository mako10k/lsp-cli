import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("cli batch runs multiple requests in one LSP session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-batch-"));
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

  const input = [
    JSON.stringify({ id: 1, cmd: "references", file, line: 0, col: 0 }),
    JSON.stringify({ id: 2, cmd: "rename", file, line: 0, col: 0, newName: "X", apply: true }),
    JSON.stringify({ id: 3, cmd: "request", method: "mock/getInitializeCount" })
  ].join("\n");

  const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "batch", "--apply"], {
    input,
    encoding: "utf8"
  });

  assert.equal(res.status, 0, res.stderr);

  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  assert.equal(lines.length, 3);
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].id, 1);

  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].id, 2);
  assert.equal(lines[1].applied, true);

  assert.equal(lines[2].ok, true);
  assert.equal(lines[2].id, 3);
  assert.equal(lines[2].result, 1);

  const updated = await fs.readFile(file, "utf8");
  assert.equal(updated.startsWith("X"), true);
});

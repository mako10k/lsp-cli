import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

test("cli document-highlight returns DocumentHighlight[]", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-highlight-"));
  const file = path.join(root, "a.ts");
  await fs.writeFile(file, "const x = 1\n", "utf8");

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

  const res = await runCli(
    ["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "document-highlight", file, "0", "0"],
    { timeoutMs: 5000 }
  );

  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.ok(Array.isArray(out));
  assert.deepEqual(out[0]?.range?.start, { line: 0, character: 0 });
  assert.deepEqual(out[0]?.range?.end, { line: 0, character: 5 });
  assert.equal(out[0]?.kind, 1);
});

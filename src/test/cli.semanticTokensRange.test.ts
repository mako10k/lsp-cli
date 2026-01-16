import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

test("cli semantic-tokens-range returns SemanticTokens", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-semantic-range-"));
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
    [
      "--root",
      root,
      "--server",
      "mock",
      "--config",
      cfgPath,
      "--format",
      "json",
      "semantic-tokens-range",
      file,
      "0",
      "0",
      "0",
      "10"
    ],
    { timeoutMs: 5000 }
  );

  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.resultId, "mock-range");
  assert.deepEqual(out.data, [0, 0, 3, 1, 0]);
});

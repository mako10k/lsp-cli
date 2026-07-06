import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

async function makeMockWorkspace(prefix: string): Promise<{ root: string; file: string; cfgPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const file = path.join(root, "a.ts");
  await fs.writeFile(file, "function a() {\n  return 1;\n}\n", "utf8");

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

  return { root, file, cfgPath };
}

test("cli folding-ranges returns FoldingRange[]", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-folding-ranges-");

  const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "folding-ranges", file], {
    timeoutMs: 5000
  });

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out[0]?.startLine, 0);
  assert.equal(out[0]?.endLine, 2);
  assert.equal(out[0]?.kind, "region");
  assert.equal(out[0]?.collapsedText, "mock region");
});

test("cli selection-ranges returns SelectionRange[] for one position", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-selection-ranges-");

  const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "selection-ranges", file, "0", "1"], {
    timeoutMs: 5000
  });

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]?.range?.start, { line: 0, character: 1 });
  assert.deepEqual(out[0]?.parent?.range?.start, { line: 0, character: 0 });
});

test("cli selection-ranges accepts multiple positions", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-selection-ranges-multi-");

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
      "selection-ranges",
      "--positions",
      JSON.stringify([
        { line: 0, character: 1 },
        { line: 1, col: 2 }
      ]),
      file
    ],
    { timeoutMs: 5000 }
  );

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0]?.range?.start, { line: 0, character: 1 });
  assert.deepEqual(out[1]?.range?.start, { line: 1, character: 2 });
});

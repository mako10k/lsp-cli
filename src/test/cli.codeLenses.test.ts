import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

async function makeMockWorkspace(prefix: string): Promise<{ root: string; file: string; cfgPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

  return { root, file, cfgPath };
}

test("cli code-lenses returns CodeLens[]", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-code-lenses-");

  const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "code-lenses", file], {
    timeoutMs: 5000
  });

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0]?.range?.start, { line: 0, character: 0 });
  assert.equal(out[0]?.data?.id, "mock-code-lens");
  assert.equal(out[0]?.command, undefined);
});

test("cli code-lenses can resolve CodeLens commands", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-code-lenses-resolve-");

  const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "code-lenses", "--resolve", file], {
    timeoutMs: 5000
  });

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.command?.title, "Mock CodeLens");
  assert.equal(out[0]?.command?.command, "mock/codeLens");
  assert.deepEqual(out[0]?.command?.arguments, ["mock-code-lens"]);
});

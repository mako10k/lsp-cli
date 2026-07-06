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

test("cli diagnostics returns DocumentDiagnosticReport", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-diagnostics-");

  const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "diagnostics", file], {
    timeoutMs: 5000
  });

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, "full");
  assert.equal(out.resultId, "mock-doc-result");
  assert.equal(out.items[0]?.source, "mock");
  assert.match(out.items[0]?.message, /mock diagnostic/);
});

test("cli diagnostics passes previousResultId", { timeout: 10_000 }, async () => {
  const { root, file, cfgPath } = await makeMockWorkspace("lsp-cli-diagnostics-prev-");

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
      "diagnostics",
      "--previous-result-id",
      "mock-doc-result",
      file
    ],
    { timeoutMs: 5000 }
  );

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.kind, "unchanged");
  assert.equal(out.resultId, "mock-doc-result");
});

test("cli workspace-diagnostics returns WorkspaceDiagnosticReport", { timeout: 10_000 }, async () => {
  const { root, cfgPath } = await makeMockWorkspace("lsp-cli-workspace-diagnostics-");

  const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "workspace-diagnostics"], {
    timeoutMs: 5000
  });

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.items[0]?.kind, "full");
  assert.equal(out.items[0]?.uri, "file:///workspace-a.ts");
  assert.equal(out.items[0]?.items[0]?.message, "mock workspace diagnostic");
});

test("cli workspace-diagnostics passes previousResultIds", { timeout: 10_000 }, async () => {
  const { root, cfgPath } = await makeMockWorkspace("lsp-cli-workspace-diagnostics-prev-");

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
      "workspace-diagnostics",
      "--previous-result-ids",
      JSON.stringify([{ uri: "file:///workspace-a.ts", value: "mock-ws-result" }])
    ],
    { timeoutMs: 5000 }
  );

  assert.equal(res.code, 0, res.stderr);

  const out = JSON.parse(res.stdout);
  assert.equal(out.items[0]?.kind, "unchanged");
  assert.equal(out.items[0]?.resultId, "mock-ws-result");
});

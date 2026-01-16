import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

test("cli did-change-configuration sends workspace/didChangeConfiguration", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-config-"));

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

  const settings = { foo: { bar: 1 } };

  // Must be in the same LSP session because the mock state is process-local.
  const res = await runCli(
    ["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "batch"],
    {
      timeoutMs: 5000,
      input:
        JSON.stringify({ id: "1", cmd: "notify", method: "workspace/didChangeConfiguration", params: { settings } }) +
        "\n" +
        JSON.stringify({ id: "2", cmd: "request", method: "mock/getLastDidChangeConfiguration" }) +
        "\n"
    }
  );
  assert.equal(res.code, 0, res.stderr);

  const lines = res.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const out2 = lines.find((x) => x.id === "2");
  assert.ok(out2);
  assert.deepEqual(out2.result, { settings });
});

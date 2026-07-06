import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

test("cli separates daemon sockets for different server command identities", { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-daemon-identity-"));
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

  const baseArgs = ["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json"];
  const serverCmd = path.join(root, "mock-lsp-wrapper.sh");
  await fs.writeFile(serverCmd, `#!/bin/sh\nexec "${process.execPath}" "${serverScript}"\n`, "utf8");
  await fs.chmod(serverCmd, 0o755);

  try {
    const defaultStatus = await runCli([...baseArgs, "daemon-status"], { timeoutMs: 5000 });
    assert.equal(defaultStatus.code, 0, defaultStatus.stderr);

    const overrideStatus = await runCli([...baseArgs, "--server-cmd", serverCmd, "daemon-status"], { timeoutMs: 5000 });
    assert.equal(overrideStatus.code, 0, overrideStatus.stderr);

    const defaultOut = JSON.parse(defaultStatus.stdout);
    const overrideOut = JSON.parse(overrideStatus.stdout);

    assert.equal(defaultOut.serverName, "mock");
    assert.equal(overrideOut.serverName, "mock");
    assert.notEqual(defaultOut.socketPath, overrideOut.socketPath);
  } finally {
    await runCli([...baseArgs, "daemon-stop"], { timeoutMs: 5000 });
    await runCli([...baseArgs, "--server-cmd", serverCmd, "daemon-stop"], { timeoutMs: 5000 });
  }
});

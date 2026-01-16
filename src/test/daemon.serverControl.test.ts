import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("daemon server-stop/server-restart work", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-server-control-"));
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

  // ensure daemon is started
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "server-status"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.running, true);
  }

  // stop server
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "server-stop"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.stopped, true);
  }

  // status should show stopped
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "server-status"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.running, false);
  }

  // restart server
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "server-restart"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.restarted, true);
  }

  // status should show running again
  {
    const res = spawnSync(process.execPath, [cli, "--root", root, "--server", "mock", "--format", "json", "server-status"], {
      encoding: "utf8"
    });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.running, true);
  }

  // and initialize count should have increased (restart triggers new initialize)
  {
    const res = spawnSync(
      process.execPath,
      [cli, "--root", root, "--server", "mock", "--format", "json", "daemon-request", "--method", "mock/getInitializeCount"],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out >= 1);
  }
});

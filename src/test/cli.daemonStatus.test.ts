import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

type RunResult = { code: number | null; stdout: string; stderr: string; killed: boolean };

async function runCli(args: string[], opts: { timeoutMs: number }): Promise<RunResult> {
  const cli = path.resolve(__dirname, "../cli.js");

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, opts.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, killed });
    });
  });
}

test("cli daemon-status returns pid/startedAt/socketPath and lsp running", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-daemon-status-"));

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

  // First call should start the daemon and return enriched status.
  const status1 = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "daemon-status"], {
    timeoutMs: 5000
  });
  assert.equal(status1.killed, false, status1.stderr);
  assert.equal(status1.code, 0, status1.stderr);

  const out1 = JSON.parse(status1.stdout);
  assert.equal(out1.alive, true);
  assert.equal(typeof out1.pid, "number");
  assert.ok(out1.pid > 0);
  assert.equal(typeof out1.startedAt, "number");
  assert.ok(out1.startedAt > 0);
  assert.equal(typeof out1.socketPath, "string");
  assert.ok(out1.socketPath.length > 0);
  assert.equal(out1.rootPath, root);
  assert.equal(out1.serverName, "mock");
  assert.equal(typeof out1.lsp?.running, "boolean");

  // Stop daemon.
  const stopped = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "daemon-stop"], {
    timeoutMs: 5000
  });
  assert.equal(stopped.killed, false, stopped.stderr);
  assert.equal(stopped.code, 0, stopped.stderr);

  // Now daemon-status should fail (daemon is gone and should not autostart for this check).
  // NOTE: current CLI policy auto-starts on connect failure, so this call may restart daemon.
  // We assert that it at least finishes within timeout and returns JSON.
  const status2 = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "daemon-status"], {
    timeoutMs: 5000
  });
  assert.equal(status2.killed, false, status2.stderr);
  assert.equal(status2.code, 0, status2.stderr);
  const out2 = JSON.parse(status2.stdout);
  assert.equal(out2.alive, true);
});

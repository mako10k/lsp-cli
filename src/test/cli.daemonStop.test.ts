import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

import { resolveDaemonEndpoint } from "../util/endpoint";

async function waitForConnectFailure(socketPath: string, timeoutMs: number): Promise<void> {
  // If the socket path does not exist, we are done.
  try {
    await fs.stat(socketPath);
  } catch {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });

    const timer = setTimeout(() => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      reject(new Error("timeout connecting"));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      sock.removeAllListeners();
    };

    sock.once("connect", () => {
      cleanup();
      try {
        sock.end();
      } catch {
        // ignore
      }
      reject(new Error("unexpectedly connected to daemon"));
    });

    sock.once("error", () => {
      cleanup();
      resolve();
    });
  });
}

test("cli daemon-stop waits until socket is gone", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-daemon-stop-"));

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

  // Ensure daemon started (auto-start) and socket exists.
  {
    const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "server-status"], { timeoutMs: 5000 });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.running, true);
  }

  // Stop daemon and wait until socket is gone.
  {
    const res = await runCli(["--root", root, "--server", "mock", "--config", cfgPath, "--format", "json", "daemon-stop"], { timeoutMs: 5000 });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.stopped, true);
    assert.equal(out.socketGone, true);
  }

  // Should not be able to connect anymore.
  const { socketPath } = resolveDaemonEndpoint(root, "mock");
  await waitForConnectFailure(socketPath, 500);
});

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

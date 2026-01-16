import { spawn } from "node:child_process";
import path from "node:path";

export type RunResult = { code: number | null; stdout: string; stderr: string; killed: boolean };

export async function runCli(args: string[], opts: { timeoutMs: number; input?: string } = { timeoutMs: 5000 }): Promise<RunResult> {
  const cli = path.resolve(__dirname, "../cli.js");

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d) => (stdout += String(d)));
    child.stderr?.on("data", (d) => (stderr += String(d)));

    if (opts.input != null) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();

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

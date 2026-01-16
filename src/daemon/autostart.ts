import { spawn } from "node:child_process";

export async function spawnDaemonDetached(opts: {
  cliPath: string;
  root: string;
  server: string;
  config?: string;
  serverCmd?: string;
}): Promise<void> {
  const args: string[] = [opts.cliPath, "--root", opts.root, "--server", opts.server];
  if (opts.config) args.push("--config", opts.config);
  if (opts.serverCmd) args.push("--server-cmd", opts.serverCmd);
  args.push("daemon");

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    env: process.env
  });

  child.unref();
}

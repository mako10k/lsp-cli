import path from "node:path";

import { DaemonServer } from "./DaemonServer";

export async function runDaemonMain(opts: { rootPath: string; server: string; config?: string; serverCmd?: string }): Promise<void> {
  const root = path.resolve(opts.rootPath);

  const daemon = new DaemonServer({
    rootPath: root,
    serverName: opts.server,
    configPath: opts.config,
    serverCmd: opts.serverCmd
  });

  await daemon.start();

  // Keep process alive.
  await new Promise(() => {
    // never resolve
  });
}

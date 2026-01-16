import net from "node:net";
import fs from "node:fs";
import { once } from "node:events";

import { LspClient } from "../lsp/LspClient";
import { getServerProfile } from "../servers";
import type { DaemonRequest, DaemonResponse } from "./protocol";
import { parseJsonlLine, toJsonl } from "./protocol";
import { ensureEndpointDir, resolveDaemonEndpoint } from "../util/endpoint";
import { DaemonLog } from "./logging";

export type DaemonServerOptions = {
  rootPath: string;
  serverName: string;
  configPath?: string;
  serverCmd?: string;
};

export class DaemonServer {
  private readonly rootPath: string;
  private readonly serverName: string;
  private readonly configPath?: string;
  private readonly serverCmd?: string;

  private sockPath: string | null = null;
  private server: net.Server | null = null;

  private client: LspClient | null = null;
  private readonly log = new DaemonLog();

  constructor(opts: DaemonServerOptions) {
    this.rootPath = opts.rootPath;
    this.serverName = opts.serverName;
    this.configPath = opts.configPath;
    this.serverCmd = opts.serverCmd;
  }

  getSocketPath(): string {
    return resolveDaemonEndpoint(this.rootPath, this.serverName).socketPath;
  }

  async start(): Promise<void> {
    if (this.server) return;

    const sock = this.getSocketPath();
    this.sockPath = sock;

    await ensureEndpointDir(resolveDaemonEndpoint(this.rootPath, this.serverName));

    // Remove stale socket file.
    try {
      await fs.promises.unlink(sock);
    } catch {
      // ignore
    }

    // If serverCmd is provided, allow passing a full commandstring (command + args).
    // This keeps tests hermetic (e.g. `node path/to/mockLspServer.js`).
    const profile = getServerProfile(this.serverName, this.rootPath, this.configPath, this.serverCmd);
    this.client = new LspClient({ rootPath: this.rootPath, server: profile });
    await this.client.start();

    // Default: discard logs. The client can switch via daemon/log/set.
    // (Future) We may log server stderr here if needed.

    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buf = "";

      socket.on("data", async (chunk) => {
        buf += chunk;
        while (true) {
          const nl = buf.indexOf("\n");
          if (nl === -1) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);

          let msg: any;
          try {
            msg = parseJsonlLine(line);
          } catch (e) {
            socket.write(toJsonl({ id: "<parse>", ok: false, error: String((e as any)?.message ?? e) } satisfies DaemonResponse));
            continue;
          }

          if (!msg) continue;
          const id = typeof msg.id === "string" ? msg.id : "<no-id>";

          try {
            const res = await this.handleRequest(msg as DaemonRequest);
            socket.write(toJsonl({ id, ok: true, result: res } satisfies DaemonResponse));
          } catch (e) {
            socket.write(toJsonl({ id, ok: false, error: String((e as any)?.message ?? e) } satisfies DaemonResponse));
          }
        }
      });
    });

    this.server.listen(sock);
    await once(this.server, "listening");

    const cleanup = async () => {
      await this.stop();
    };

    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;

    const client = this.client;
    this.client = null;

    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    if (client) {
      try {
        await client.shutdown();
      } catch {
        // ignore
      }
    }

    this.log.close();

    if (this.sockPath) {
      try {
        await fs.promises.unlink(this.sockPath);
      } catch {
        // ignore
      }
      this.sockPath = null;
    }
  }

  private async handleRequest(req: DaemonRequest): Promise<any> {
    if (!this.client) throw new Error("daemon not started");

    switch (req.cmd) {
      case "ping":
        return { ok: true };

      case "daemon/status":
        return { alive: true, rootPath: this.rootPath, server: this.serverName };

      case "daemon/log/get":
        return this.log.getStatus();

      case "daemon/log/set": {
        if (req.mode === "discard") {
          this.log.setDiscard();
          return this.log.getStatus();
        }
        if (req.mode === "file") {
          if (!req.path) throw new Error("daemon/log/set mode=file requires path");
          await this.log.setFile(String(req.path));
          return this.log.getStatus();
        }
        throw new Error(`unsupported log mode: ${(req as any).mode}`);
      }

      case "daemon/stop":
        // Return before actual stop? keep simple: stop then return.
        await this.stop();
        return { stopped: true };

      case "server/status":
        return { running: true };

      case "server/restart": {
        const profile = getServerProfile(this.serverName, this.rootPath, this.configPath, this.serverCmd);
        await this.client.shutdown();
        this.client = new LspClient({ rootPath: this.rootPath, server: profile });
        await this.client.start();
        return { restarted: true };
      }

      default:
        throw new Error(`unsupported cmd: ${(req as any).cmd}`);
    }
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

export type ServerProfile = {
  name: string;
  command: string;
  args: string[];
  languageIdForPath: (filePath: string) => string;
  initializationOptions?: unknown;
};

export class LspClient {
  private readonly rootPath: string;
  private readonly server: ServerProfile;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: ReturnType<typeof createMessageConnection> | null = null;

  constructor(opts: { rootPath: string; server: ServerProfile }) {
    this.rootPath = opts.rootPath;
    this.server = opts.server;
  }

  async start(): Promise<void> {
    if (this.proc || this.conn) return;

    this.proc = spawn(this.server.command, this.server.args, {
      stdio: "pipe",
      cwd: this.rootPath
    });

    let stderr = "";
    this.proc.stderr.on("data", (d) => {
      if (stderr.length >= 8192) return;
      stderr += d.toString("utf8");
    });

    const reader = new StreamMessageReader(this.proc.stdout);
    const writer = new StreamMessageWriter(this.proc.stdin);
    this.conn = createMessageConnection(reader, writer);

    this.conn.listen();

    const rootUri = pathToFileUri(this.rootPath);

    const proc = this.proc;

    let rejectExit: ((e: unknown) => void) | null = null;
    const exitPromise: Promise<never> = new Promise((_, reject) => {
      rejectExit = reject;
    });

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const extra = stderr.trim() ? `\n${stderr.trimEnd()}` : "";
      rejectExit?.(new Error(`LSP server exited before initialize (code=${code} signal=${signal})${extra}`));
    };

    const handleError = (e: unknown) => rejectExit?.(e);

    proc.once("exit", handleExit);
    proc.once("error", handleError);

    try {
      await Promise.race([
        this.request("initialize", {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
          capabilities: {
            workspace: {
              workspaceEdit: { documentChanges: true },
              executeCommand: {},
              symbol: {}
            },
            textDocument: {
              documentSymbol: {},
              references: {},
              definition: {},
              implementation: {},
              typeDefinition: {},
              hover: {},
              signatureHelp: {},
              rename: {},
              codeAction: {}
            }
          },
          initializationOptions: this.server.initializationOptions
        }),
        exitPromise
      ]);
    } finally {
      proc.off("exit", handleExit);
      proc.off("error", handleError);
    }

    this.notify("initialized", {});
  }

  async shutdown(): Promise<void> {
    if (!this.conn || !this.proc) return;

    const conn = this.conn;
    const proc = this.proc;

    try {
      await this.request("shutdown");

      // LSP etiquette: send `exit` and allow the server to terminate itself.
      // `exit` is a notification (no response), so we wait for process exit.
      try {
        this.notify("exit");
      } catch {
        // ignore
      }

      await Promise.race([once(proc, "exit"), new Promise((r) => setTimeout(r, 1000))]);
    } finally {
      conn.dispose();
      this.conn = null;

      this.proc = null;
      if (proc.exitCode == null && !proc.killed) proc.kill();
    }
  }

  async openTextDocument(filePath: string): Promise<void> {
    if (!this.conn) throw new Error("LSP connection not started");
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(filePath, "utf8");
    const uri = pathToFileUri(filePath);

    this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this.server.languageIdForPath(filePath),
        version: 1,
        text
      }
    });
  }

  request(method: string, params?: unknown): Promise<any> {
    if (!this.conn) throw new Error("LSP connection not started");
    if (params === undefined) return this.conn.sendRequest(method as any);
    return this.conn.sendRequest(method as any, params as any);
  }

  notify(method: string, params?: unknown): void {
    if (!this.conn) throw new Error("LSP connection not started");
    if (params === undefined) {
      this.conn.sendNotification(method as any);
      return;
    }
    this.conn.sendNotification(method as any, params as any);
  }
}

function pathToFileUri(p: string): string {
  // Lazy avoid pulling in URL/pathToFileURL types everywhere.
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  return pathToFileURL(p).toString();
}

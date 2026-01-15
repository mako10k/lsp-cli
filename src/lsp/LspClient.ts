import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

    const reader = new StreamMessageReader(this.proc.stdout);
    const writer = new StreamMessageWriter(this.proc.stdin);
    this.conn = createMessageConnection(reader, writer);

    this.conn.listen();

    const rootUri = pathToFileUri(this.rootPath);

    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.rootPath) }],
      capabilities: {
        workspace: {
          workspaceEdit: { documentChanges: true }
        },
        textDocument: {
          documentSymbol: {},
          references: {},
          rename: {},
          codeAction: {}
        }
      },
      initializationOptions: this.server.initializationOptions
    });

    this.notify("initialized", {});
  }

  async shutdown(): Promise<void> {
    if (!this.conn || !this.proc) return;

    try {
      await this.request("shutdown", null);
      this.notify("exit", null);
    } finally {
      this.conn.dispose();
      this.conn = null;
      const proc = this.proc;
      this.proc = null;
      proc.kill();
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

  request(method: string, params: unknown): Promise<any> {
    if (!this.conn) throw new Error("LSP connection not started");
    return this.conn.sendRequest(method, params as any);
  }

  notify(method: string, params: unknown): void {
    if (!this.conn) throw new Error("LSP connection not started");
    this.conn.sendNotification(method, params as any);
  }
}

function pathToFileUri(p: string): string {
  // Lazy avoid pulling in URL/pathToFileURL types everywhere.
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  return pathToFileURL(p).toString();
}

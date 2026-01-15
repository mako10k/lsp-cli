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

type Position = { line: number; character: number };

type TextDocumentItem = {
  uri: string;
  languageId: string;
  version: number;
  text: string;
};

export class LspClient {
  private readonly rootPath: string;
  private readonly server: ServerProfile;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private conn: ReturnType<typeof createMessageConnection> | null = null;

  // 0=None, 1=Full, 2=Incremental
  private textDocumentSyncKind: number | null = null;
  private readonly openedDocs = new Map<string, TextDocumentItem>();

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
      const initRes = await Promise.race([
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

      const tds = (initRes as any)?.capabilities?.textDocumentSync;
      if (typeof tds === "number") {
        this.textDocumentSyncKind = tds;
      } else if (tds && typeof tds === "object" && typeof (tds as any).change === "number") {
        this.textDocumentSyncKind = (tds as any).change;
      }
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
      this.textDocumentSyncKind = null;
      this.openedDocs.clear();
      if (proc.exitCode == null && !proc.killed) proc.kill();
    }
  }

  async openTextDocument(filePath: string): Promise<void> {
    const fs = await import("node:fs/promises");
    const text = await fs.readFile(filePath, "utf8");
    await this.openTextDocumentWithText(filePath, text);
  }

  async changeTextDocument(filePath: string, newText?: string): Promise<void> {
    if (!this.conn) throw new Error("LSP connection not started");

    const fs = await import("node:fs/promises");
    const uri = pathToFileUri(filePath);

    const cur = this.openedDocs.get(uri);
    if (!cur) {
      const text = newText ?? (await fs.readFile(filePath, "utf8"));
      await this.openTextDocumentWithText(filePath, text);
      return;
    }

    const text = newText ?? (await fs.readFile(filePath, "utf8"));
    if (text === cur.text) return;

    const nextVersion = cur.version + 1;

    const kind = this.textDocumentSyncKind;
    const contentChanges =
      kind === 1
        ? [{ text }]
        : [
            kind === 2
              ? computeIncrementalChange(cur.text, text)
              : { text }
          ];

    this.notify("textDocument/didChange", {
      textDocument: { uri, version: nextVersion },
      contentChanges
    });

    this.openedDocs.set(uri, {
      uri,
      languageId: cur.languageId,
      version: nextVersion,
      text
    });
  }

  private async openTextDocumentWithText(filePath: string, text: string): Promise<void> {
    if (!this.conn) throw new Error("LSP connection not started");

    const uri = pathToFileUri(filePath);
    const existing = this.openedDocs.get(uri);
    if (existing) {
      await this.changeTextDocument(filePath, text);
      return;
    }

    const doc: TextDocumentItem = {
      uri,
      languageId: this.server.languageIdForPath(filePath),
      version: 1,
      text
    };

    this.openedDocs.set(uri, doc);

    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: doc.uri,
        languageId: doc.languageId,
        version: doc.version,
        text: doc.text
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

function computeIncrementalChange(oldText: string, newText: string): {
  range: { start: Position; end: Position };
  rangeLength: number;
  text: string;
} {
  const oldLen = oldText.length;
  const newLen = newText.length;
  const minLen = Math.min(oldLen, newLen);

  let prefix = 0;
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++;

  let suffix = 0;
  while (suffix < minLen - prefix && oldText[oldLen - 1 - suffix] === newText[newLen - 1 - suffix]) suffix++;

  const startOffset = prefix;
  const endOffset = oldLen - suffix;

  const start = positionFromOffset(oldText, startOffset);
  const end = positionFromOffset(oldText, endOffset);

  return {
    range: { start, end },
    rangeLength: endOffset - startOffset,
    text: newText.slice(prefix, newLen - suffix)
  };
}

function positionFromOffset(text: string, offset: number): Position {
  if (offset < 0 || offset > text.length) throw new Error(`offset out of range: ${offset}`);

  let line = 0;
  let lineStart = 0;

  while (true) {
    const nl = text.indexOf("\n", lineStart);
    const rawLineEnd = nl === -1 ? text.length : nl;
    const lineEnd = rawLineEnd > lineStart && text[rawLineEnd - 1] === "\r" ? rawLineEnd - 1 : rawLineEnd;
    const lineLen = lineEnd - lineStart;

    if (offset <= lineEnd) {
      return { line, character: offset - lineStart };
    }

    if (nl !== -1 && offset === rawLineEnd) {
      return { line, character: lineLen };
    }

    if (nl === -1) return { line, character: lineLen };

    lineStart = nl + 1;
    line++;
  }
}

function pathToFileUri(p: string): string {
  // Lazy avoid pulling in URL/pathToFileURL types everywhere.
  const { pathToFileURL } = require("node:url") as typeof import("node:url");
  return pathToFileURL(p).toString();
}

#!/usr/bin/env node

// Minimal stdio JSON-RPC server for tests.
// Implements a subset of LSP + a few mock/* helper methods.

type JsonRpcRequest = { jsonrpc: "2.0"; id: number | string; method: string; params?: any };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: any };
type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string; result?: any; error?: { code: number; message: string } };

let lastDidOpen: any = null;
let lastDidChange: any = null;

function writeMessage(msg: object) {
  const json = JSON.stringify(msg);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  process.stdout.write(header + json);
}

function respond(id: number | string, result: any) {
  const res: JsonRpcResponse = { jsonrpc: "2.0", id, result };
  writeMessage(res);
}

function respondError(id: number | string, message: string) {
  const res: JsonRpcResponse = { jsonrpc: "2.0", id, error: { code: -32603, message } };
  writeMessage(res);
}

function onRequest(req: JsonRpcRequest) {
  switch (req.method) {
    case "initialize":
      return respond(req.id, {
        capabilities: {
          // Prefer incremental so LspClient exercises didChange incremental.
          textDocumentSync: { openClose: true, change: 2 },
          documentSymbolProvider: true,
          referencesProvider: true,
          renameProvider: true
        }
      });

    case "shutdown":
      return respond(req.id, null);

    case "textDocument/documentSymbol":
      return respond(req.id, [
        {
          name: "MockSymbol",
          kind: 12,
          location: {
            uri: req.params?.textDocument?.uri,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
          }
        }
      ]);

    case "textDocument/references":
      return respond(req.id, [
        {
          uri: req.params?.textDocument?.uri,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        }
      ]);

    case "textDocument/rename":
      return respond(req.id, {
        changes: {
          [req.params?.textDocument?.uri ?? ""]: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: String(req.params?.newName ?? "")
            }
          ]
        }
      });

    // Helpers for tests
    case "mock/getLastDidOpen":
      return respond(req.id, lastDidOpen);

    case "mock/getLastDidChange":
      return respond(req.id, lastDidChange);

    default:
      return respondError(req.id, `mock server: unsupported method: ${req.method}`);
  }
}

function onNotification(n: JsonRpcNotification) {
  switch (n.method) {
    case "initialized":
      return;
    case "exit":
      process.exit(0);
      return;
    case "textDocument/didOpen":
      lastDidOpen = n.params;
      return;
    case "textDocument/didChange":
      lastDidChange = n.params;
      return;
    default:
      return;
  }
}

// --- Message reader (Content-Length framed) ---
let buf = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buf = Buffer.concat([buf, chunk]);

  while (true) {
    const headerEnd = buf.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;

    const header = buf.slice(0, headerEnd).toString("utf8");
    const m = header.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      // Skip garbage.
      buf = buf.slice(headerEnd + 4);
      continue;
    }

    const len = Number.parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + len;
    if (buf.length < bodyEnd) return;

    const body = buf.slice(bodyStart, bodyEnd).toString("utf8");
    buf = buf.slice(bodyEnd);

    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }

    if (msg && msg.method && Object.prototype.hasOwnProperty.call(msg, "id")) {
      onRequest(msg as JsonRpcRequest);
    } else if (msg && msg.method) {
      onNotification(msg as JsonRpcNotification);
    }
  }
});

process.stdin.on("end", () => process.exit(0));

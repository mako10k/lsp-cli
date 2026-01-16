#!/usr/bin/env node

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { LspClient } from "./lsp/LspClient";
import { getServerProfile } from "./servers";
import { applyWorkspaceEdit, formatWorkspaceEditPretty } from "./lsp/workspaceEdit";
import { pathToFileUri } from "./util/paths";
import { runDaemonMain } from "./daemon/daemonMain";
import { DaemonClient } from "./daemon/DaemonClient";
import { newRequestId } from "./daemon/protocol";
import { resolveDaemonEndpoint } from "./util/endpoint";
import { spawnDaemonDetached } from "./daemon/autostart";

type OutputFormat = "json" | "pretty";

type GlobalOpts = {
  server: string;
  serverCmd?: string;
  config?: string;
  root?: string;
  format: OutputFormat;
  stdin?: boolean;
  jq?: string;
  waitMs?: string;
  daemonLog?: string;
};

async function connectDaemonWithAutostart(opts: GlobalOpts, socketPath: string): Promise<DaemonClient> {
  const CONNECT_TIMEOUT_MS = 1500;
  const AUTOSTART_TOTAL_TIMEOUT_MS = 5000;

  const deadline = Date.now() + AUTOSTART_TOTAL_TIMEOUT_MS;

  try {
    return await DaemonClient.connect(socketPath, CONNECT_TIMEOUT_MS);
  } catch {
    // Auto-start policy: only start implicitly. No explicit `daemon start` command.
    const cliPath = resolveCliEntrypointPath();
    const root = path.resolve(opts.root ?? process.cwd());
    await spawnDaemonDetached({ cliPath, root, server: opts.server, config: opts.config, serverCmd: opts.serverCmd });

    // Retry a few times while the daemon binds the socket.
    let lastErr: unknown;
    while (Date.now() < deadline) {
      await sleep(100);
      try {
        return await DaemonClient.connect(socketPath, CONNECT_TIMEOUT_MS);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error(`timeout waiting for daemon to start: ${socketPath}`);
  }
}

function resolveCliEntrypointPath(): string {
  const argv1 = process.argv[1];
  const looksLikeCli = (p: string) => /(?:^|\/)(?:cli\.(?:js|cjs|mjs)|bin\.(?:js|cjs|mjs))$/.test(p);

  if (argv1 && looksLikeCli(argv1)) return path.resolve(argv1);

  // Node's test runner sets argv[1] to the test file, so prefer the known dist path.
  return path.resolve(__dirname, "cli.js");
}

async function withDaemonClient<T>(opts: GlobalOpts, fn: (client: DaemonClient, socketPath: string, defaultLogPath: string) => Promise<T>): Promise<T> {
  const root = path.resolve(opts.root ?? process.cwd());
  const serverName = opts.server;
  const { socketPath, defaultLogPath } = resolveDaemonEndpoint(root, serverName);

  const client = await connectDaemonWithAutostart(opts, socketPath);
  try {
    if (typeof opts.daemonLog === "string") {
      const v = opts.daemonLog.trim();
      if (!v || v === "discard") {
        await client.request({ id: newRequestId("log"), cmd: "daemon/log/set", mode: "discard" });
      } else {
        const p = v === "default" ? defaultLogPath : v;
        await client.request({ id: newRequestId("log"), cmd: "daemon/log/set", mode: "file", path: p });
      }
    }
    return await fn(client, socketPath, defaultLogPath);
  } finally {
    client.close();
  }
}

async function withDaemonFallback<T>(opts: GlobalOpts, runDirect: () => Promise<T>, runDaemon: (client: DaemonClient) => Promise<T>): Promise<T> {
  try {
    return await withDaemonClient(opts, async (client) => {
      return await runDaemon(client);
    });
  } catch {
    return await runDirect();
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    process.stdin.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function waitForDaemonSocketGone(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.promises.stat(socketPath);
    } catch {
      // stat failed -> likely gone
      return;
    }
    await sleep(50);
  }
  throw new Error(`timeout waiting for daemon socket to disappear: ${socketPath}`);
}

function parseIntStrict(v: string): number {
  if (!/^[-+]?\d+$/.test(v)) throw new Error(`invalid integer: ${v}`);
  return Number.parseInt(v, 10);
}

function formatCodeActionsPretty(items: Array<{ index: number; title: string; kind?: string; isPreferred?: boolean; hasEdit: boolean; hasCommand: boolean }>): string {
  if (items.length === 0) return "(no code actions)";
  return items
    .map((a) => {
      const flags: string[] = [];
      if (a.kind) flags.push(a.kind);
      if (a.isPreferred) flags.push("preferred");
      if (a.hasEdit) flags.push("edit");
      if (a.hasCommand) flags.push("command");
      return `[${a.index}] ${a.title}${flags.length ? ` (${flags.join(", ")})` : ""}`;
    })
    .join("\n");
}

function uriToDisplay(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

function rangeToStr(r: any): string {
  return `${r.start.line}:${r.start.character} -> ${r.end.line}:${r.end.character}`;
}

function kindToStr(k: any): string {
  return typeof k === "number" ? String(k) : k ? String(k) : "";
}

function parseSymbolKind(s?: string): number | undefined {
  if (!s) return undefined;
  switch (s.toLowerCase()) {
    case "file":
      return 1;
    case "module":
      return 2;
    case "namespace":
      return 3;
    case "package":
      return 4;
    case "class":
      return 5;
    case "method":
      return 6;
    case "property":
      return 7;
    case "field":
      return 8;
    case "constructor":
      return 9;
    case "enum":
      return 10;
    case "interface":
      return 11;
    case "function":
      return 12;
    case "variable":
      return 13;
    case "constant":
      return 14;
    case "string":
      return 15;
    case "number":
      return 16;
    case "boolean":
      return 17;
    case "array":
      return 18;
    case "object":
      return 19;
    case "key":
      return 20;
    case "null":
      return 21;
    case "enummember":
    case "enum-member":
      return 22;
    case "struct":
      return 23;
    case "event":
      return 24;
    case "operator":
      return 25;
    case "typeparameter":
    case "type-parameter":
      return 26;
    default:
      return undefined;
  }
}

function splitLinesKeepEol(text: string): string[] {
  const lines: string[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf("\n", i);
    if (nl === -1) {
      lines.push(text.slice(i));
      return lines;
    }
    lines.push(text.slice(i, nl + 1));
    i = nl + 1;
  }
  if (text.length === 0) return [""];
  return lines;
}

function lineLengthWithoutEol(lineWithEol: string): number {
  if (lineWithEol.endsWith("\r\n")) return lineWithEol.length - 2;
  if (lineWithEol.endsWith("\n")) return lineWithEol.length - 1;
  return lineWithEol.length;
}

function expandRangeToWholeLines(fileText: string, r: any): any {
  const lines = splitLinesKeepEol(fileText);
  const startLine = Math.max(0, Math.min(r.start.line, Math.max(0, lines.length - 1)));
  const endLine = Math.max(0, Math.min(r.end.line, Math.max(0, lines.length - 1)));

  const start = { line: startLine, character: 0 };

  if (endLine + 1 < lines.length) {
    return { start, end: { line: endLine + 1, character: 0 } };
  }

  return { start, end: { line: endLine, character: lineLengthWithoutEol(lines[endLine] ?? "") } };
}

function formatLocationsPretty(res: any): string {
  if (!res) return "(no result)";
  const arr = Array.isArray(res) ? res : [res];
  if (arr.length === 0) return "(no result)";

  return arr
    .map((loc: any) => {
      if (typeof loc?.targetUri === "string" && loc?.targetRange) {
        return `${uriToDisplay(loc.targetUri)} ${rangeToStr(loc.targetRange)}`;
      }
      if (typeof loc?.uri === "string" && loc?.range) {
        return `${uriToDisplay(loc.uri)} ${rangeToStr(loc.range)}`;
      }
      return JSON.stringify(loc);
    })
    .join("\n");
}

function formatMarkedString(ms: any): string {
  if (ms == null) return "";
  if (typeof ms === "string") return ms;
  if (typeof ms === "object" && typeof ms.value === "string") return ms.value;
  return JSON.stringify(ms);
}

function formatHoverPretty(res: any): string {
  if (!res) return "(no result)";
  const c = res?.contents;
  if (!c) return "(no result)";

  if (Array.isArray(c)) {
    const parts = c.map((x) => formatMarkedString(x)).filter(Boolean);
    return parts.length ? parts.join("\n---\n") : "(no result)";
  }

  if (typeof c === "object" && typeof c.value === "string") {
    return c.value;
  }

  return formatMarkedString(c) || "(no result)";
}

function formatSignatureHelpPretty(res: any): string {
  const sigs = res?.signatures;
  if (!Array.isArray(sigs) || sigs.length === 0) return "(no result)";

  const activeSig = typeof res?.activeSignature === "number" ? res.activeSignature : 0;
  const activeParam = typeof res?.activeParameter === "number" ? res.activeParameter : undefined;

  return sigs
    .map((s: any, idx: number) => {
      const header = `${idx === activeSig ? "*" : " "} ${String(s?.label ?? "")}`;
      const doc = s?.documentation ? formatMarkedString(s.documentation) : "";
      const ap = idx === activeSig && activeParam != null ? `\n  activeParameter=${activeParam}` : "";
      return doc ? `${header}${ap}\n  ${doc}` : `${header}${ap}`;
    })
    .join("\n\n");
}

function formatWorkspaceSymbolsPretty(res: any): string {
  const items = Array.isArray(res) ? res : [];
  if (items.length === 0) return "(no result)";

  const getLoc = (s: any): any => s?.location ?? s?.symbol?.location;

  return items
    .map((s: any) => {
      const name = String(s?.name ?? s?.symbol?.name ?? "");
      const container = s?.containerName ? ` :: ${s.containerName}` : "";
      const kind = kindToStr(s?.kind ?? s?.symbol?.kind);
      const loc = getLoc(s);
      if (loc?.uri && loc?.range?.start) {
        const p = uriToDisplay(String(loc.uri));
        const r = loc.range;
        return `${name}${container}${kind ? ` (kind=${kind})` : ""} - ${p} ${rangeToStr(r)}`;
      }
      return `${name}${container}${kind ? ` (kind=${kind})` : ""}`;
    })
    .join("\n");
}

function formatDocumentSymbolsPretty(res: any, filePath?: string): string {
  const items = Array.isArray(res) ? res : [];
  if (items.length === 0) return "(no result)";

  const isSymbolInformation = items.some((x: any) => x?.location?.uri);
  if (isSymbolInformation) {
    return items
      .map((s: any) => {
        const name = String(s?.name ?? "");
        const container = s?.containerName ? ` :: ${s.containerName}` : "";
        const kind = kindToStr(s?.kind);
        const loc = s?.location;
        if (loc?.uri && loc?.range) {
          return `${name}${container}${kind ? ` (kind=${kind})` : ""} - ${uriToDisplay(String(loc.uri))} ${rangeToStr(loc.range)}`;
        }
        return `${name}${container}${kind ? ` (kind=${kind})` : ""}`;
      })
      .join("\n");
  }

  const lines: string[] = [];
  if (filePath) lines.push(filePath);

  const walk = (ds: any, depth: number) => {
    const indent = "  ".repeat(depth);
    const name = String(ds?.name ?? "");
    const detail = ds?.detail ? ` : ${String(ds.detail)}` : "";
    const kind = kindToStr(ds?.kind);
    const r = ds?.range;
    const rangeStr = r?.start && r?.end ? ` - ${rangeToStr(r)}` : "";
    lines.push(`${indent}${name}${detail}${kind ? ` (kind=${kind})` : ""}${rangeStr}`);
    const children = Array.isArray(ds?.children) ? ds.children : [];
    for (const c of children) walk(c, depth + 1);
  };

  for (const ds of items) walk(ds, 0);
  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function output(opts: { format: OutputFormat; jq?: string }, value: unknown) {
  if (opts.jq) {
    const input = JSON.stringify(value);
    const res = spawnSync("jq", [opts.jq], { input, encoding: "utf8" });
    if (res.error) {
      const code = (res.error as any)?.code;
      if (code === "ENOENT") throw new Error("jq not found in PATH (install jq or omit --jq)");
      throw res.error;
    }
    if (res.status !== 0) throw new Error(String(res.stderr || `jq failed (exit=${res.status})`));
    process.stdout.write(String(res.stdout ?? ""));
    if (!String(res.stdout ?? "").endsWith("\n")) process.stdout.write("\n");
    return;
  }

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    return;
  }

  if (typeof value === "string") {
    process.stdout.write(value + "\n");
    return;
  }

  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

const program = new Command();
program
  .name("lsp-cli")
  .description("Lightweight CLI for driving LSP servers (MVP: rust-analyzer)")
  .option("--server <name>", "server profile name", "rust-analyzer")
  .option("--server-cmd <cmd>", "override server command (e.g. 'rust-analyzer')")
  .option("--config <path>", "config file path (default: <root>/.lsp-cli.json or <root>/lsp-cli.config.json)")
  .option("--root <path>", "workspace root (default: cwd)")
  .option("--format <json|pretty>", "output format", "json")
  .option("--stdin", "read command input params from stdin as JSON")
  .option("--jq <filter>", "pipe JSON output through jq filter (requires jq in PATH)")
  .option("--wait-ms <n>", "wait before some requests (ms; helps rust-analyzer warm-up)", "500")
  .option("--daemon-log <path>", "daemon log path (auto-start); default discards logs")
  .addHelpText(
    "after",
    [
      "",
      "Position notes:",
      "  line/col are 0-based (LSP compliant). Example: line=0 col=0 is the first character.",
      "",
      "Global option notes:",
      "  - Put global options before the command for reliable parsing.",
      "    e.g. lsp-cli --root . --format pretty symbols path/to/file.rs",
      "",
      "Stdin notes:",
      "  - For <file> you can pass '-' to read a file path from stdin.",
      "  - With --stdin, read JSON params from stdin (command-specific).",
      ""
    ].join("\n")
  );

program
  .command("ping")
  .description("Initialize and shutdown the server")
  .action(async () => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();
    await client.shutdown();
  });

program
  .command("daemon")
  .description("Run daemon server (internal; auto-started)")
  .action(async () => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    await runDaemonMain({ rootPath: root, server: opts.server, config: opts.config, serverCmd: opts.serverCmd });
  });
program
  .command("daemon-log")
  .description("Get/set daemon log sink (requires running daemon). value: discard|default|<path>")
  .argument("[value]", "discard | default | <path>")
  .action(async (value: string | undefined) => {
    const opts = program.opts() as GlobalOpts;
    const effective: GlobalOpts = value == null ? opts : { ...opts, daemonLog: value };

    const res = await withDaemonClient(effective, async (client, socketPath, defaultLogPath) => {
      const status = await client.request({ id: newRequestId("log-get"), cmd: "daemon/log/get" });
      return { socketPath, defaultLogPath, log: status };
    });

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("events")
  .description("Pull events from daemon (e.g. diagnostics).")
  .option("--kind <kind>", "event kind (diagnostics)", "diagnostics")
  .option("--since <cursor>", "only return events after cursor", "0")
  .option("--limit <n>", "max events to return (1-1000)", "200")
  .action(async (cmdOpts) => {
    const opts = program.opts() as GlobalOpts;
    const kind = String(cmdOpts.kind ?? "diagnostics");
    if (kind !== "diagnostics") throw new Error(`unsupported kind: ${kind}`);

    const since = parseIntStrict(String(cmdOpts.since ?? "0"));
    const limit = parseIntStrict(String(cmdOpts.limit ?? "200"));

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("events"),
        cmd: "events/get",
        kind: "diagnostics",
        since,
        limit
      });
    });

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("server-status")
  .description("Get daemon server (LSP) running status")
  .action(async () => {
    const opts = program.opts() as GlobalOpts;
    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({ id: newRequestId("srv"), cmd: "server/status" });
    });
    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("server-stop")
  .description("Stop LSP server inside daemon (daemon stays running)")
  .action(async () => {
    const opts = program.opts() as GlobalOpts;
    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({ id: newRequestId("srv"), cmd: "server/stop" });
    });
    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("server-restart")
  .description("Restart LSP server inside daemon")
  .action(async () => {
    const opts = program.opts() as GlobalOpts;
    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({ id: newRequestId("srv"), cmd: "server/restart" });
    });
    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("daemon-stop")
  .description("Stop daemon process (will remove UDS socket)")
  .action(async () => {
    const opts = program.opts() as GlobalOpts;

    const root = path.resolve(opts.root ?? process.cwd());
    const { socketPath } = resolveDaemonEndpoint(root, opts.server);

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({ id: newRequestId("stop"), cmd: "daemon/stop" });
    });

    // Best-effort guarantee: after daemon-stop returns, wait for the socket to be removed.
    await waitForDaemonSocketGone(socketPath, 2000);
    output({ format: opts.format, jq: opts.jq }, { ...res, socketGone: true });
  });

program
  .command("daemon-request")
  .description("Send an arbitrary LSP request via daemon (advanced/debug).")
  .requiredOption("--method <name>", "LSP method")
  .option("--params <json>", "JSON params (string)")
  .action(async (cmdOpts) => {
    const opts = program.opts() as GlobalOpts;
    const method = String(cmdOpts.method);
    const params = cmdOpts.params ? JSON.parse(String(cmdOpts.params)) : undefined;

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({ id: newRequestId("lsp"), cmd: "lsp/request", method, params });
    });

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("apply-edits")
  .description("Apply a WorkspaceEdit JSON from stdin (default: dry-run)")
  .option("--apply", "apply edit to files")
  .action(async (cmdOpts?: { apply?: boolean }) => {
    const opts = program.opts() as GlobalOpts;

    if (opts.stdin) throw new Error("apply-edits reads WorkspaceEdit JSON from stdin; do not use --stdin");
    const raw = await readAllStdin();
    const edit = JSON.parse(raw || "null");

    if (cmdOpts?.apply) {
      await applyWorkspaceEdit(edit);
      output({ format: opts.format, jq: opts.jq }, { applied: true });
      return;
    }

    output({ format: opts.format, jq: opts.jq }, opts.format === "pretty" && !opts.jq ? formatWorkspaceEditPretty(edit) : edit);
  });

program
  .command("symbols")
  .description("textDocument/documentSymbol")
  .argument("[file]", "file path, or '-' to read from stdin")
  .action(async (fileArg?: string) => {
    const opts = program.opts() as GlobalOpts;

    let file = fileArg;
    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string };
      file = params.file;
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }
    if (!file) throw new Error("file is required (or use --stdin)");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonFallback(
      opts,
      async () => {
        const root = path.resolve(opts.root ?? process.cwd());
        const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);
          return await client.request("textDocument/documentSymbol", {
            textDocument: { uri }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("symbols"),
          cmd: "lsp/request",
          method: "textDocument/documentSymbol",
          params: { textDocument: { uri } }
        });
      }
    );

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatDocumentSymbolsPretty(res, abs) : res
    );
  });

program
  .command("symbols-daemon")
  .description("textDocument/documentSymbol via daemon (experimental)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .action(async (fileArg?: string) => {
    const opts = program.opts() as GlobalOpts;

    let file = fileArg;
    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string };
      file = params.file;
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }
    if (!file) throw new Error("file is required (or use --stdin)");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("symbols"),
        cmd: "lsp/request",
        method: "textDocument/documentSymbol",
        params: { textDocument: { uri } }
      });
    });

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatDocumentSymbolsPretty(res, abs) : res
    );
  });

program
  .command("references")
  .description("textDocument/references")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || line == null || col == null) {
      throw new Error("file/line/col are required (or use --stdin)");
    }
    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);

          const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
          if (waitMs > 0) await sleep(waitMs);

          return await client.request("textDocument/references", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) },
            context: { includeDeclaration: true }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("refs"),
          cmd: "lsp/request",
          method: "textDocument/references",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) },
            context: { includeDeclaration: true }
          }
        });
      }
    );
    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res
    );
  });

program
  .command("references-daemon")
  .description("textDocument/references via daemon (experimental)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }
    if (!file) throw new Error("file is required (or use --stdin)");
    if (line == null) throw new Error("line is required");
    if (col == null) throw new Error("col is required");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("refs"),
        cmd: "lsp/request",
        method: "textDocument/references",
        params: {
          textDocument: { uri },
          position: { line: parseIntStrict(line), character: parseIntStrict(col) },
          context: { includeDeclaration: true }
        }
      });
    });

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res
    );
  });

program
  .command("definition")
  .description("textDocument/definition")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || line == null || col == null) {
      throw new Error("file/line/col are required (or use --stdin)");
    }
    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);

          const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
          if (waitMs > 0) await sleep(waitMs);

          return await client.request("textDocument/definition", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("def"),
          cmd: "lsp/request",
          method: "textDocument/definition",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );
    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res
    );
  });

program
  .command("definition-daemon")
  .description("textDocument/definition via daemon (experimental)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file) throw new Error("file is required (or use --stdin)");
    if (line == null) throw new Error("line is required");
    if (col == null) throw new Error("col is required");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("def"),
        cmd: "lsp/request",
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: parseIntStrict(line), character: parseIntStrict(col) }
        }
      });
    });

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res
    );
  });

program
  .command("implementation")
  .description("textDocument/implementation")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || line == null || col == null) {
      throw new Error("file/line/col are required (or use --stdin)");
    }

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
    if (waitMs > 0) await sleep(waitMs);

    const res = await client.request("textDocument/implementation", {
      textDocument: { uri },
      position: { line: parseIntStrict(line), character: parseIntStrict(col) }
    });

    await client.shutdown();
    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res
    );
  });

program
  .command("type-definition")
  .description("textDocument/typeDefinition")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || line == null || col == null) {
      throw new Error("file/line/col are required (or use --stdin)");
    }

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
    if (waitMs > 0) await sleep(waitMs);

    const res = await client.request("textDocument/typeDefinition", {
      textDocument: { uri },
      position: { line: parseIntStrict(line), character: parseIntStrict(col) }
    });

    await client.shutdown();
    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res
    );
  });

program
  .command("hover")
  .description("textDocument/hover")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || line == null || col == null) {
      throw new Error("file/line/col are required (or use --stdin)");
    }

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);

          const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
          if (waitMs > 0) await sleep(waitMs);

          return await client.request("textDocument/hover", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("hover"),
          cmd: "lsp/request",
          method: "textDocument/hover",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatHoverPretty(res) : res
    );
  });

program
  .command("hover-daemon")
  .description("textDocument/hover via daemon (experimental)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file) throw new Error("file is required (or use --stdin)");
    if (line == null) throw new Error("line is required");
    if (col == null) throw new Error("col is required");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("hover"),
        cmd: "lsp/request",
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: parseIntStrict(line), character: parseIntStrict(col) }
        }
      });
    });

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatHoverPretty(res) : res
    );
  });

program
  .command("signature-help")
  .description("textDocument/signatureHelp")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || line == null || col == null) {
      throw new Error("file/line/col are required (or use --stdin)");
    }
    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);

          const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
          if (waitMs > 0) await sleep(waitMs);

          return await client.request("textDocument/signatureHelp", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("sig"),
          cmd: "lsp/request",
          method: "textDocument/signatureHelp",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );
    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatSignatureHelpPretty(res) : res
    );
  });

program
  .command("signature-help-daemon")
  .description("textDocument/signatureHelp via daemon (experimental)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .action(async (fileArg?: string, lineArg?: string, colArg?: string) => {
    const opts = program.opts() as GlobalOpts;

    let file = fileArg;
    let line = lineArg;
    let col = colArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; line: number; col: number };
      file = params.file;
      line = String(params.line);
      col = String(params.col);
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file) throw new Error("file is required (or use --stdin)");
    if (line == null) throw new Error("line is required");
    if (col == null) throw new Error("col is required");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("sig"),
        cmd: "lsp/request",
        method: "textDocument/signatureHelp",
        params: {
          textDocument: { uri },
          position: { line: parseIntStrict(line), character: parseIntStrict(col) }
        }
      });
    });

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatSignatureHelpPretty(res) : res
    );
  });

program
  .command("ws-symbols")
  .description("workspace/symbol")
  .argument("[query]", "search query (or '-' to read from stdin)")
  .option("--limit <n>", "limit results", "50")
  .action(async (queryArg?: string, cmdOpts?: { limit?: string }) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let query = queryArg;
    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { query: string };
      query = params.query;
    } else if (query === "-") {
      query = (await readAllStdin()).trim();
    }
    if (query == null) query = "";

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
          if (waitMs > 0) await sleep(waitMs);

          return (await client.request("workspace/symbol", { query })) as any[];
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("wssym"),
          cmd: "lsp/request",
          method: "workspace/symbol",
          params: { query }
        });
      }
    );

    const limit = parseIntStrict(String(cmdOpts?.limit ?? "50"));
    const sliced = Array.isArray(res) ? res.slice(0, Math.max(0, limit)) : res;

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatWorkspaceSymbolsPretty(sliced) : sliced
    );
  });

program
  .command("ws-symbols-daemon")
  .description("workspace/symbol via daemon (experimental)")
  .argument("[query]", "search query (or '-' to read from stdin)")
  .option("--limit <n>", "limit results", "50")
  .action(async (queryArg?: string, cmdOpts?: { limit?: string }) => {
    const opts = program.opts() as GlobalOpts;

    let query = queryArg;
    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { query: string };
      query = params.query;
    } else if (query === "-") {
      query = (await readAllStdin()).trim();
    }
    if (query == null) query = "";

    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({
        id: newRequestId("wssym"),
        cmd: "lsp/request",
        method: "workspace/symbol",
        params: { query }
      });
    });

    const limit = parseIntStrict(String(cmdOpts?.limit ?? "50"));
    const sliced = Array.isArray(res) ? res.slice(0, Math.max(0, limit)) : res;

    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatWorkspaceSymbolsPretty(sliced) : sliced
    );
  });

program
  .command("delete-symbol")
  .description("delete a symbol/block by name using documentSymbol")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[symbolName]", "symbol name")
  .option("--kind <kind>", "filter by symbol kind (e.g. function, class)")
  .option("--index <n>", "select match by index (0-based)")
  .option("--apply", "apply edit to files")
  .action(async (fileArg?: string, symbolNameArg?: string, cmdOpts?: { kind?: string; index?: string; apply?: boolean }) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let symbolName = symbolNameArg;

    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; symbolName: string; kind?: string; index?: number };
      file = params.file;
      symbolName = params.symbolName;
      if (params.kind != null) cmdOpts = { ...(cmdOpts ?? {}), kind: String(params.kind) };
      if (typeof params.index === "number") cmdOpts = { ...(cmdOpts ?? {}), index: String(params.index) };
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }

    if (!file || !symbolName) throw new Error("file/symbolName are required (or use --stdin)");

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const res = await client.request("textDocument/documentSymbol", { textDocument: { uri } });

    const wantKind = parseSymbolKind(cmdOpts?.kind);

    const matches: Array<{ name: string; kind?: any; range?: any }> = [];

    const addMatch = (name: any, kind: any, range: any) => {
      if (String(name ?? "") !== symbolName) return;
      if (wantKind != null && typeof kind === "number" && kind !== wantKind) return;
      if (!range?.start || !range?.end) return;
      matches.push({ name: String(name ?? ""), kind, range });
    };

    if (Array.isArray(res) && res.length > 0 && (res[0]?.location || res[0]?.name)) {
      // SymbolInformation[]
      for (const si of res) addMatch(si?.name, si?.kind, si?.location?.range);
    } else if (Array.isArray(res)) {
      // DocumentSymbol[]
      const walk = (ds: any) => {
        addMatch(ds?.name, ds?.kind, ds?.range);
        const children = Array.isArray(ds?.children) ? ds.children : [];
        for (const c of children) walk(c);
      };
      for (const ds of res) walk(ds);
    }

    if (matches.length === 0) {
      await client.shutdown();
      throw new Error(`no symbol matched: ${symbolName}`);
    }

    const idx = cmdOpts?.index != null ? parseIntStrict(String(cmdOpts.index)) : matches.length === 1 ? 0 : undefined;
    if (idx == null) {
      await client.shutdown();
      output(
        { format: opts.format, jq: opts.jq },
        opts.format === "pretty" && !opts.jq
          ? matches
              .map((m, i) => `[${i}] ${m.name}${m.kind != null ? ` (kind=${kindToStr(m.kind)})` : ""} ${rangeToStr(m.range)}`)
              .join("\n")
          : { matches }
      );
      return;
    }

    const chosen = matches[idx];
    if (!chosen) {
      await client.shutdown();
      throw new Error(`no match at index ${idx}`);
    }

    const fs = await import("node:fs/promises");
    const fileText = await fs.readFile(abs, "utf8");
    const whole = expandRangeToWholeLines(fileText, chosen.range);

    const edit = {
      changes: {
        [uri]: [
          {
            range: whole,
            newText: ""
          }
        ]
      }
    };

    if (cmdOpts?.apply) {
      await applyWorkspaceEdit(edit);
      await client.shutdown();
      output({ format: opts.format, jq: opts.jq }, { applied: true, index: idx, symbolName });
      return;
    }

    await client.shutdown();
    output(
      { format: opts.format, jq: opts.jq },
      opts.format === "pretty" && !opts.jq ? formatWorkspaceEditPretty(edit) : { dryRun: true, index: idx, symbolName, edit }
    );
  });

program
  .command("rename")
  .description("textDocument/rename (default: --dry-run)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .argument("[newName]", "new name")
  .option("--apply", "apply WorkspaceEdit to files")
  .option("--dry-run", "show planned edits only", true)
  .action(
    async (
      fileArg: string | undefined,
      lineArg: string | undefined,
      colArg: string | undefined,
      newNameArg: string | undefined,
      cmdOpts: { apply?: boolean }
    ) => {
      const opts = program.opts() as GlobalOpts;
      const root = path.resolve(opts.root ?? process.cwd());
      const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

      let file = fileArg;
      let line = lineArg;
      let col = colArg;
      let newName = newNameArg;

      if (opts.stdin) {
        const params = JSON.parse(await readAllStdin()) as {
          file: string;
          line: number;
          col: number;
          newName: string;
        };
        file = params.file;
        line = String(params.line);
        col = String(params.col);
        newName = params.newName;
      } else if (file === "-") {
        file = (await readAllStdin()).trim();
      }

      if (!file || line == null || col == null || !newName) {
        throw new Error("file/line/col/newName are required (or use --stdin)");
      }
      const abs = path.resolve(file);
      const uri = pathToFileUri(abs);

      const wantsApply = !!cmdOpts.apply;

      const edit = await withDaemonFallback(
        opts,
        async () => {
          const client = new LspClient({ rootPath: root, server: profile, applyEdits: wantsApply });
          await client.start();
          try {
            await client.openTextDocument(abs);

            return await client.request("textDocument/rename", {
              textDocument: { uri },
              position: { line: parseIntStrict(line), character: parseIntStrict(col) },
              newName
            });
          } finally {
            await client.shutdown();
          }
        },
        async (client) => {
          if (wantsApply) {
            const res = await client.request({
              id: newRequestId("rename"),
              cmd: "lsp/requestAndApply",
              method: "textDocument/rename",
              params: {
                textDocument: { uri },
                position: { line: parseIntStrict(line), character: parseIntStrict(col) },
                newName
              }
            });
            return (res as any)?.result;
          }

          return await client.request({
            id: newRequestId("rename"),
            cmd: "lsp/request",
            method: "textDocument/rename",
            params: {
              textDocument: { uri },
              position: { line: parseIntStrict(line), character: parseIntStrict(col) },
              newName
            }
          });
        }
      );

      if (wantsApply) {
        if (edit) await applyWorkspaceEdit(edit);
        output({ format: opts.format, jq: opts.jq }, { applied: true });
        return;
      }

      output({ format: opts.format, jq: opts.jq }, opts.format === "pretty" && !opts.jq ? formatWorkspaceEditPretty(edit) : edit);
    }
  );

program
  .command("code-actions")
  .description("textDocument/codeAction (list; optional apply)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[startLine]", "0-based start line")
  .argument("[startCol]", "0-based start column")
  .argument("[endLine]", "0-based end line")
  .argument("[endCol]", "0-based end column")
  .option("--index <n>", "select action by index (0-based)")
  .option("--kind <prefix>", "select by CodeAction.kind prefix")
  .option("--title-regex <re>", "select by title regex")
  .option("--preferred", "prefer isPreferred actions")
  .option("--first", "pick first match when multiple")
  .option("--fail-if-multiple", "fail when multiple matches")
  .option("--apply", "apply selected action (default is dry-run)")
  .action(
    async (
      fileArg?: string,
      startLineArg?: string,
      startColArg?: string,
      endLineArg?: string,
      endColArg?: string,
      cmdOpts?: {
        index?: string;
        kind?: string;
        titleRegex?: string;
        preferred?: boolean;
        first?: boolean;
        failIfMultiple?: boolean;
        apply?: boolean;
      }
    ) => {
      const opts = program.opts() as GlobalOpts;
      const root = path.resolve(opts.root ?? process.cwd());
      const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

      let file = fileArg;
      let startLine = startLineArg;
      let startCol = startColArg;
      let endLine = endLineArg;
      let endCol = endColArg;

      if (opts.stdin) {
        const params = JSON.parse(await readAllStdin()) as {
          file: string;
          startLine: number;
          startCol: number;
          endLine: number;
          endCol: number;
        };
        file = params.file;
        startLine = String(params.startLine);
        startCol = String(params.startCol);
        endLine = String(params.endLine);
        endCol = String(params.endCol);
      } else if (file === "-") {
        file = (await readAllStdin()).trim();
      }

      if (!file || startLine == null || startCol == null || endLine == null || endCol == null) {
        throw new Error("file/startLine/startCol/endLine/endCol are required (or use --stdin)");
      }
      const abs = path.resolve(file);
      const uri = pathToFileUri(abs);

      const wantsApply = !!cmdOpts?.apply;

      const actions = (await withDaemonFallback(
        opts,
        async () => {
          const client = new LspClient({ rootPath: root, server: profile, applyEdits: wantsApply });
          await client.start();
          try {
            await client.openTextDocument(abs);

            return (await client.request("textDocument/codeAction", {
              textDocument: { uri },
              range: {
                start: { line: parseIntStrict(startLine), character: parseIntStrict(startCol) },
                end: { line: parseIntStrict(endLine), character: parseIntStrict(endCol) }
              },
              context: { diagnostics: [] }
            })) as any[];
          } finally {
            await client.shutdown();
          }
        },
        async (client) => {
          return await client.request({
            id: newRequestId("cact"),
            cmd: "lsp/request",
            method: "textDocument/codeAction",
            params: {
              textDocument: { uri },
              range: {
                start: { line: parseIntStrict(startLine), character: parseIntStrict(startCol) },
                end: { line: parseIntStrict(endLine), character: parseIntStrict(endCol) }
              },
              context: { diagnostics: [] }
            }
          });
        }
      )) as any[];

      const summarized = (actions ?? []).map((a, index) => ({
        index,
        title: String(a?.title ?? ""),
        kind: typeof a?.kind === "string" ? a.kind : undefined,
        isPreferred: typeof a?.isPreferred === "boolean" ? a.isPreferred : undefined,
        hasEdit: !!a?.edit,
        hasCommand: !!a?.command
      }));

      const titleRe = cmdOpts?.titleRegex ? new RegExp(String(cmdOpts.titleRegex)) : null;

      const pickedIdx = (() => {
        if (cmdOpts?.index != null) return parseIntStrict(String(cmdOpts.index));

        const hasSelector = !!(cmdOpts?.kind || titleRe || cmdOpts?.preferred || cmdOpts?.first || cmdOpts?.failIfMultiple);
        if (!hasSelector) return undefined;

        let candidates = summarized;

        if (cmdOpts?.kind) {
          const prefix = String(cmdOpts.kind);
          candidates = candidates.filter((a) => (a.kind ?? "").startsWith(prefix));
        }

        if (titleRe) {
          candidates = candidates.filter((a) => titleRe.test(a.title));
        }

        if (cmdOpts?.preferred) {
          const preferred = candidates.filter((a) => a.isPreferred);
          if (preferred.length) candidates = preferred;
        }

        if (candidates.length === 0) throw new Error("no matching code actions");

        if (candidates.length === 1) return candidates[0].index;
        if (cmdOpts?.first) return candidates[0].index;
        if (cmdOpts?.failIfMultiple) throw new Error(`multiple matching code actions (${candidates.length}); use --first or --index`);
        throw new Error(`multiple matching code actions (${candidates.length}); use --first or --index`);
      })();

      if (pickedIdx == null) {
        output(
          { format: opts.format, jq: opts.jq },
          opts.format === "pretty" && !opts.jq ? formatCodeActionsPretty(summarized) : summarized
        );
        return;
      }

      const selected = actions?.[pickedIdx];
      if (!selected) {
        throw new Error(`no code action at index ${pickedIdx}`);
      }

      if (!cmdOpts?.apply) {
        output(
          { format: opts.format, jq: opts.jq },
          opts.format === "pretty" && !opts.jq
            ? `DRY-RUN [${pickedIdx}] ${String(selected?.title ?? "")}`
            : { dryRun: true, index: pickedIdx, title: selected.title, kind: selected.kind }
        );
        return;
      }

      if (selected.edit) {
        await applyWorkspaceEdit(selected.edit);
        output({ format: opts.format, jq: opts.jq }, { applied: true, via: "edit", index: pickedIdx, title: selected.title, kind: selected.kind });
        return;
      }

      // LSP allows returning Command objects (or CodeAction.command).
      const cmd = selected.command;
      if (cmd && typeof cmd.command === "string") {
        const res = await withDaemonFallback(
          opts,
          async () => {
            const client = new LspClient({ rootPath: root, server: profile, applyEdits: true });
            await client.start();
            try {
              await client.openTextDocument(abs);
              return await client.request("workspace/executeCommand", {
                command: cmd.command,
                arguments: cmd.arguments
              });
            } finally {
              await client.shutdown();
            }
          },
          async (client) => {
            const r = await client.request({
              id: newRequestId("exec"),
              cmd: "lsp/requestAndApply",
              method: "workspace/executeCommand",
              params: { command: cmd.command, arguments: cmd.arguments }
            });
            return (r as any)?.result;
          }
        );
        output({ format: opts.format, jq: opts.jq }, { applied: true, via: "command", index: pickedIdx, title: selected.title, kind: selected.kind, result: res });
        return;
      }
      throw new Error("selected code action has neither edit nor executable command");
    }
  );

function writeJsonl(value: unknown) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function collectUrisFromWorkspaceEdit(edit: any): string[] {
  const out = new Set<string>();

  if (edit?.changes && typeof edit.changes === "object") {
    for (const uri of Object.keys(edit.changes)) out.add(uri);
  }

  const dcs = Array.isArray(edit?.documentChanges) ? edit.documentChanges : [];
  for (const dc of dcs) {
    if (dc?.textDocument?.uri && Array.isArray(dc?.edits)) {
      out.add(String(dc.textDocument.uri));
      continue;
    }
    if (dc?.kind === "create" && typeof dc?.uri === "string") out.add(dc.uri);
    if (dc?.kind === "delete" && typeof dc?.uri === "string") out.add(dc.uri);
    if (dc?.kind === "rename") {
      if (typeof dc?.oldUri === "string") out.add(dc.oldUri);
      if (typeof dc?.newUri === "string") out.add(dc.newUri);
    }
  }

  return [...out];
}

async function syncClientAfterWorkspaceEdit(client: LspClient, edit: any): Promise<void> {
  for (const uri of collectUrisFromWorkspaceEdit(edit)) {
    try {
      const filePath = fileURLToPath(uri);
      await client.changeTextDocument(filePath);
    } catch {
      // ignore non-file URIs
    }
  }
}

program
  .command("batch")
  .description("Run multiple requests in one LSP session (JSONL via stdin)")
  .option("--apply", "allow applying edits to files")
  .option("--continue-on-error", "keep going and emit {ok:false} on errors")
  .option("--wait-mode <once|each>", "how to apply --wait-ms (default: each)", "each")
  .action(async (cmdOpts?: { apply?: boolean; continueOnError?: boolean; waitMode?: string }) => {
    const opts = program.opts() as GlobalOpts;

    if (opts.stdin) throw new Error("batch reads JSONL from stdin; do not use --stdin");
    if (opts.jq) throw new Error("batch does not support --jq");
    if (opts.format !== "json") throw new Error("batch requires --format json");

    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    const allowApply = !!cmdOpts?.apply;
    const waitMode = String(cmdOpts?.waitMode ?? "each");

    const client = new LspClient({ rootPath: root, server: profile, applyEdits: allowApply });
    await client.start();

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    let waitedOnce = false;
    const maybeWait = async () => {
      const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
      if (waitMs <= 0) return;
      if (waitMode === "once") {
        if (waitedOnce) return;
        waitedOnce = true;
      }
      await sleep(waitMs);
    };

    const handleError = async (req: any, e: unknown) => {
      writeJsonl({ ok: false, id: req?.id, cmd: req?.cmd, error: String((e as any)?.message ?? e) });
      if (!cmdOpts?.continueOnError) throw e;
    };

    try {
      for await (const rawLine of rl) {
        const line = String(rawLine ?? "").trim();
        if (!line) continue;

        let req: any;
        try {
          req = JSON.parse(line);
        } catch (e) {
          await handleError({ cmd: "<parse>" }, e);
          continue;
        }

        const cmd = String(req?.cmd ?? "");

        try {
          if (cmd === "ping") {
            writeJsonl({ ok: true, id: req?.id, cmd, result: { ok: true } });
            continue;
          }

          if (cmd === "request") {
            if (typeof req?.method !== "string") throw new Error("request requires method");
            await maybeWait();
            const res = await client.request(req.method, req.params);
            writeJsonl({ ok: true, id: req?.id, cmd, method: req.method, result: res });
            continue;
          }

          if (cmd === "notify") {
            if (typeof req?.method !== "string") throw new Error("notify requires method");
            client.notify(req.method, req.params);
            writeJsonl({ ok: true, id: req?.id, cmd, method: req.method, result: { notified: true } });
            continue;
          }

          const file = req?.file;
          const hasFile = typeof file === "string" && file.length > 0;
          const abs = hasFile ? path.resolve(file) : null;
          const uri = abs ? pathToFileUri(abs) : null;

          if (hasFile && abs && uri) {
            await client.changeTextDocument(abs);
          }

          if (cmd === "symbols") {
            if (!uri) throw new Error("symbols requires file");
            await maybeWait();
            const res = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
            writeJsonl({ ok: true, id: req?.id, cmd, result: res });
            continue;
          }

          if (cmd === "references") {
            if (!uri) throw new Error("references requires file");
            await maybeWait();
            const res = await client.request("textDocument/references", {
              textDocument: { uri },
              position: { line: Number(req.line), character: Number(req.col) },
              context: { includeDeclaration: true }
            });
            writeJsonl({ ok: true, id: req?.id, cmd, result: res });
            continue;
          }

          if (cmd === "definition" || cmd === "implementation" || cmd === "type-definition" || cmd === "hover" || cmd === "signature-help") {
            if (!uri) throw new Error(`${cmd} requires file`);
            await maybeWait();

            const method =
              cmd === "definition"
                ? "textDocument/definition"
                : cmd === "implementation"
                  ? "textDocument/implementation"
                  : cmd === "type-definition"
                    ? "textDocument/typeDefinition"
                    : cmd === "hover"
                      ? "textDocument/hover"
                      : "textDocument/signatureHelp";

            const res = await client.request(method, {
              textDocument: { uri },
              position: { line: Number(req.line), character: Number(req.col) }
            });

            writeJsonl({ ok: true, id: req?.id, cmd, result: res });
            continue;
          }

          if (cmd === "ws-symbols") {
            await maybeWait();
            const res = await client.request("workspace/symbol", { query: String(req?.query ?? "") });
            writeJsonl({ ok: true, id: req?.id, cmd, result: res });
            continue;
          }

          if (cmd === "rename") {
            if (!uri) throw new Error("rename requires file");
            if (typeof req?.newName !== "string") throw new Error("rename requires newName");
            await maybeWait();

            const edit = await client.request("textDocument/rename", {
              textDocument: { uri },
              position: { line: Number(req.line), character: Number(req.col) },
              newName: req.newName
            });

            const wantApply = !!req.apply;
            if (wantApply) {
              if (!allowApply) throw new Error("apply requested but batch was not started with --apply");
              await applyWorkspaceEdit(edit);
              await syncClientAfterWorkspaceEdit(client, edit);
              writeJsonl({ ok: true, id: req?.id, cmd, applied: true });
              continue;
            }

            writeJsonl({ ok: true, id: req?.id, cmd, result: edit });
            continue;
          }

          if (cmd === "delete-symbol") {
            if (!uri) throw new Error("delete-symbol requires file");
            if (typeof req?.symbolName !== "string") throw new Error("delete-symbol requires symbolName");

            const res = await client.request("textDocument/documentSymbol", { textDocument: { uri } });
            const wantKind = parseSymbolKind(typeof req?.kind === "string" ? req.kind : undefined);

            const matches: Array<{ name: string; kind?: any; range?: any }> = [];
            const addMatch = (name: any, kind: any, range: any) => {
              if (String(name ?? "") !== req.symbolName) return;
              if (wantKind != null && typeof kind === "number" && kind !== wantKind) return;
              if (!range?.start || !range?.end) return;
              matches.push({ name: String(name ?? ""), kind, range });
            };

            if (Array.isArray(res) && res.length > 0 && (res[0]?.location || res[0]?.name)) {
              for (const si of res) addMatch(si?.name, si?.kind, si?.location?.range);
            } else if (Array.isArray(res)) {
              const walk = (ds: any) => {
                addMatch(ds?.name, ds?.kind, ds?.range);
                const children = Array.isArray(ds?.children) ? ds.children : [];
                for (const c of children) walk(c);
              };
              for (const ds of res) walk(ds);
            }

            if (matches.length === 0) throw new Error(`no symbol matched: ${req.symbolName}`);

            const idx = typeof req?.index === "number" ? req.index : matches.length === 1 ? 0 : undefined;
            if (idx == null) {
              writeJsonl({ ok: true, id: req?.id, cmd, matches });
              continue;
            }

            const chosen = matches[idx];
            if (!chosen) throw new Error(`no match at index ${idx}`);

            const fs = await import("node:fs/promises");
            const fileText = await fs.readFile(abs!, "utf8");
            const whole = expandRangeToWholeLines(fileText, chosen.range);

            const edit = {
              changes: {
                [uri]: [
                  {
                    range: whole,
                    newText: ""
                  }
                ]
              }
            };

            const wantApply = !!req.apply;
            if (wantApply) {
              if (!allowApply) throw new Error("apply requested but batch was not started with --apply");
              await applyWorkspaceEdit(edit);
              await syncClientAfterWorkspaceEdit(client, edit);
              writeJsonl({ ok: true, id: req?.id, cmd, applied: true, index: idx });
              continue;
            }

            writeJsonl({ ok: true, id: req?.id, cmd, dryRun: true, index: idx, edit });
            continue;
          }

          if (cmd === "code-actions") {
            if (!uri) throw new Error("code-actions requires file");
            await maybeWait();

            const actions = (await client.request("textDocument/codeAction", {
              textDocument: { uri },
              range: {
                start: { line: Number(req.startLine), character: Number(req.startCol) },
                end: { line: Number(req.endLine), character: Number(req.endCol) }
              },
              context: { diagnostics: [] }
            })) as any[];

            const summarized = (actions ?? []).map((a, index) => ({
              index,
              title: String(a?.title ?? ""),
              kind: typeof a?.kind === "string" ? a.kind : undefined,
              isPreferred: typeof a?.isPreferred === "boolean" ? a.isPreferred : undefined,
              hasEdit: !!a?.edit,
              hasCommand: !!a?.command
            }));

            const titleRe = typeof req?.titleRegex === "string" ? new RegExp(String(req.titleRegex)) : null;

            const pickedIdx = (() => {
              if (req?.index != null) return Number(req.index);

              const hasSelector = !!(req?.kind || titleRe || req?.preferred || req?.first || req?.failIfMultiple);
              if (!hasSelector) return undefined;

              let candidates = summarized;

              if (req?.kind) {
                const prefix = String(req.kind);
                candidates = candidates.filter((a) => (a.kind ?? "").startsWith(prefix));
              }

              if (titleRe) {
                candidates = candidates.filter((a) => titleRe.test(a.title));
              }

              if (req?.preferred) {
                const preferred = candidates.filter((a) => a.isPreferred);
                if (preferred.length) candidates = preferred;
              }

              if (candidates.length === 0) throw new Error("no matching code actions");

              if (candidates.length === 1) return candidates[0].index;
              if (req?.first) return candidates[0].index;
              if (req?.failIfMultiple) throw new Error(`multiple matching code actions (${candidates.length}); use first or index`);
              throw new Error(`multiple matching code actions (${candidates.length}); use first or index`);
            })();

            if (pickedIdx == null) {
              writeJsonl({ ok: true, id: req?.id, cmd, result: summarized });
              continue;
            }

            const selected = actions?.[pickedIdx];
            if (!selected) throw new Error(`no code action at index ${pickedIdx}`);

            const wantApply = !!req.apply;
            if (!wantApply) {
              writeJsonl({ ok: true, id: req?.id, cmd, dryRun: true, index: pickedIdx, title: selected.title, kind: selected.kind });
              continue;
            }

            if (!allowApply) throw new Error("apply requested but batch was not started with --apply");

            if (selected.edit) {
              await applyWorkspaceEdit(selected.edit);
              await syncClientAfterWorkspaceEdit(client, selected.edit);
              writeJsonl({ ok: true, id: req?.id, cmd, applied: true, via: "edit", index: pickedIdx, title: selected.title, kind: selected.kind });
              continue;
            }

            const cmdObj = selected.command;
            if (cmdObj && typeof cmdObj.command === "string") {
              const res = await client.request("workspace/executeCommand", { command: cmdObj.command, arguments: cmdObj.arguments });
              if (abs) await client.changeTextDocument(abs);
              writeJsonl({ ok: true, id: req?.id, cmd, applied: true, via: "command", index: pickedIdx, title: selected.title, kind: selected.kind, result: res });
              continue;
            }

            throw new Error("selected code action has neither edit nor executable command");
          }

          throw new Error(`unsupported cmd: ${cmd}`);
        } catch (e) {
          await handleError(req, e);
        }
      }
    } finally {
      await client.shutdown();
      rl.close();
    }
  });

(async () => {
  await program.parseAsync(process.argv);
})().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exitCode = 1;
});

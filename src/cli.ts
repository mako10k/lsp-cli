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

  // pretty mode: default to a human-readable representation.
  // Some commands return structured JSON that has no bespoke pretty formatter.
  // For those, show it via util.inspect to avoid printing strict JSON.
  const inspect = require("node:util").inspect as (v: unknown, o?: any) => string;
  process.stdout.write(
    inspect(value, {
      depth: null,
      colors: process.stdout.isTTY,
      compact: false,
      maxArrayLength: null,
      maxStringLength: null
    }) + "\n"
  );
}

const program = new Command();
program
  .name("lsp-cli")
  .description("Lightweight CLI for driving LSP servers (MVP: rust-analyzer)")
  .version(require("../package.json").version)
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
      "Help navigation:",
      "  lsp-cli help toc                # TOC (what to read next)",
      "  lsp-cli help commands            # command index by category",
      "  lsp-cli help <command>           # detailed command help (same as '<command> --help')",
      "  lsp-cli help examples            # use-case oriented examples",
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

// Provide a navigable help hub.
// We'll disable Commander's auto-generated 'help' command and implement our own.
program.addHelpCommand(false);

type HelpTopic = "toc" | "commands" | "examples";

function printHelpToc(): void {
  process.stdout.write(
    [
      "lsp-cli help (TOC)",
      "",
      "USAGE:",
      "  lsp-cli --help",
      "  lsp-cli help toc",
      "  lsp-cli help commands",
      "  lsp-cli help examples",
      "  lsp-cli help <command>",
      "",
      "Next steps:",
      "  - Start with 'commands' to find the right subcommand.",
      "  - Use 'help <command>' to see flags/args (and stdin/apply rules).",
      "",
      "See also:",
      "  - README.md (long-form guide)",
      "  - PROTOCOL_SUPPORT.md (feature matrix)",
      "  - Config file guide: see 'lsp-cli help examples' (section: server profiles)",
      ""
    ].join("\n")
  );
}

function printHelpCommands(): void {
  process.stdout.write(
    [
      "lsp-cli help commands (command index)",
      "",
      "USAGE:",
      "  lsp-cli help commands",
      "  lsp-cli help <command>",
      "",
      "Core:",
      "  ping",
      "",
      "Daemon / ops:",
      "  daemon-status  daemon-stop  daemon-log  events",
      "  server-status  server-stop  server-restart",
      "",
      "Read-only navigation:",
      "  symbols  references  definition  type-definition  implementation",
      "  hover  signature-help  ws-symbols",
      "",
      "Refactor / edits (dry-run by default):",
      "  rename  code-actions  apply-edits  delete-symbol",
      "",
      "Formatting / tokens:",
      "  format  format-range  completion  document-highlight  inlay-hints",
      "  semantic-tokens-full  semantic-tokens-range  semantic-tokens-delta",
      "  prepare-rename  did-change-configuration",
      "",
      "Batch / advanced:",
      "  batch  daemon-request",
      ""
    ].join("\n")
  );
}

function printHelpExamples(): void {
  process.stdout.write(
    [
      "lsp-cli help examples (use-case samples)",
      "",
      "USAGE:",
      "  lsp-cli help examples",
      "",
      "1) Navigate (definition → references)",
      "  lsp-cli --root <root> --format pretty --wait-ms 500 definition <file> <line> <col>",
      "  lsp-cli --root <root> --format pretty --wait-ms 500 references <file> <line> <col>",
      "",
      "2) Safe refactor (dry-run first)",
      "  lsp-cli --root <root> rename <file> <line> <col> <newName>",
      "  lsp-cli --root <root> rename --apply <file> <line> <col> <newName>",
      "",
      "3) Pull diagnostics (daemon events)",
      "  lsp-cli --root <root> events --kind diagnostics --since 0",
      "",
      "4) Batch (JSONL)",
      "  cat <<'JSONL' | lsp-cli --root <root> --format json batch",
      "  {\"cmd\":\"definition\",\"file\":\"src/main.rs\",\"line\":0,\"col\":0}",
      "  JSONL",
      "",
      "5) Config file (server profiles)",
      "  By default, lsp-cli searches:",
      "    <root>/.lsp-cli.json",
      "    <root>/lsp-cli.config.json",
      "  You can override with --config <path> (relative paths are resolved from <root>).",
      "",
      "  Example: <root>/.lsp-cli.json",
      "    {",
      "      \"servers\": {",
      "        \"rust-analyzer\": { \"command\": \"rust-analyzer\", \"args\": [] },",
      "        \"typescript-language-server\": { \"command\": \"npx\", \"args\": [\"-y\", \"typescript-language-server\", \"--stdio\"] }",
      "      }",
      "    }",
      "",
      "  Usage:",
      "    lsp-cli --root <root> --config .lsp-cli.json --server rust-analyzer ping",
      ""
    ].join("\n")
  );
}

program
  .command("helpx")
  .alias("help")
  .description("Help hub: TOC, command index, examples, and per-command help")
  .argument("[topicOrCommand]", "toc | commands | examples | <command>")
  .action(async (topicOrCommand?: string) => {
    const arg = String(topicOrCommand ?? "toc");

    const knownTopics: Record<string, HelpTopic> = {
      toc: "toc",
      commands: "commands",
      examples: "examples"
    };

    const topic = knownTopics[arg];
    if (topic === "toc") {
      printHelpToc();
      return;
    }
    if (topic === "commands") {
      printHelpCommands();
      return;
    }
    if (topic === "examples") {
      printHelpExamples();
      return;
    }

    // Delegate to Commander per-command help.
    const cmd = program.commands.find((c) => c.name() === arg);
    if (!cmd) {
      throw new Error(`unknown help topic/command: ${arg}`);
    }
    cmd.help();
  });

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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli daemon-log                 # show current log setting",
      "  lsp-cli daemon-log discard         # discard daemon logs",
      "  lsp-cli daemon-log default         # use default log file under runtime dir",
      "  lsp-cli daemon-log <path>          # write logs to a file",
      "",
      "NOTES:",
      "  - This talks to the daemon.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic daemon-log",
      "  lsp-cli --root samples/rust-basic daemon-log default",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli events --kind diagnostics [--since <cursor>] [--limit <n>]",
      "",
      "NOTES:",
      "  - Pull-based: daemon buffers server notifications (e.g. publishDiagnostics).",
      "  - Use the returned cursor to incrementally fetch new events.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic events --kind diagnostics --since 0",
      ""
    ].join("\n")
  )
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
  .command("daemon-status")
  .description("Get daemon process status and metadata")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli daemon-status",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic daemon-status",
      ""
    ].join("\n")
  )
  .action(async () => {
    const opts = program.opts() as GlobalOpts;
    const res = await withDaemonClient(opts, async (client) => {
      return await client.request({ id: newRequestId("daemon"), cmd: "daemon/status" });
    });
    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("server-status")
  .description("Get daemon server (LSP) running status")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli server-status",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic server-status",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli server-stop",
      "",
      "NOTES:",
      "  - Stops only the LSP server process; the daemon remains running.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic server-stop",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli server-restart",
      "",
      "NOTES:",
      "  - Restarts the LSP server and re-runs initialize inside the daemon.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic server-restart",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli daemon-stop",
      "",
      "NOTES:",
      "  - Stops the daemon itself (not just the LSP server).",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic daemon-stop",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli daemon-request --method <method> [--params '<json>']",
      "",
      "NOTES:",
      "  - Sends lsp/request directly. Prefer dedicated subcommands when available.",
      "  - --params is parsed as JSON.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic daemon-request --method workspace/symbol --params '{\"query\":\"add\"}'",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  cat edit.json | lsp-cli apply-edits",
      "  cat edit.json | lsp-cli apply-edits --apply",
      "",
      "NOTES:",
      "  - Reads a WorkspaceEdit JSON object from stdin.",
      "  - Default is dry-run; use --apply to modify files.",
      "  - Do not use --stdin with apply-edits; stdin is reserved for the WorkspaceEdit itself.",
      "",
      "EXAMPLES:",
      "  cat <<'JSON' | lsp-cli apply-edits",
      "  {\"changes\":{\"file:///tmp/example.txt\":[{\"range\":{\"start\":{\"line\":0,\"character\":0},\"end\":{\"line\":0,\"character\":0}},\"newText\":\"hello\"}]}}",
      "  JSON",
      ""
    ].join("\n")
  )
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
  .command("did-change-configuration")
  .description("workspace/didChangeConfiguration")
  .option("--settings <json>", "JSON settings object (string)")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli did-change-configuration --settings '<json>'",
      "  lsp-cli did-change-configuration --stdin",
      "",
      "NOTES:",
      "  - Sends a notification; there is no LSP response payload.",
      "  - Use --stdin to pass JSON without shell escaping issues.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic did-change-configuration --settings '{\"rust-analyzer\":{\"cargo\":{\"allFeatures\":true}}}'",
      "",
      "  echo '{\"settings\":{\"rust-analyzer\":{\"cargo\":{\"allFeatures\":true}}}}' | lsp-cli --root samples/rust-basic did-change-configuration --stdin",
      ""
    ].join("\n")
  )
  .action(async (cmdOpts?: { settings?: string }) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let settings: unknown;
    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { settings: unknown };
      settings = params.settings;
    } else if (typeof cmdOpts?.settings === "string") {
      settings = JSON.parse(cmdOpts.settings);
    } else {
      throw new Error("settings are required (use --stdin or --settings '<json>')");
    }

    await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          client.notify("workspace/didChangeConfiguration", { settings });
          return { notified: true };
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("cfg"),
          cmd: "lsp/notify",
          method: "workspace/didChangeConfiguration",
          params: { settings }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, { notified: true });
  });

program
  .command("prepare-rename")
  .description("textDocument/prepareRename")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli prepare-rename <file> <line> <col>",
      "  lsp-cli prepare-rename --stdin",
      "",
      "NOTES:",
      "  - Use this before rename to verify the position is renameable.",
      "  - line/col are 0-based (LSP compliant).",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty prepare-rename src/main.rs 0 0",
      "",
      "  echo '{\"file\":\"src/main.rs\",\"line\":0,\"col\":0}' | lsp-cli --root samples/rust-basic prepare-rename --stdin",
      ""
    ].join("\n")
  )
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
          return await client.request("textDocument/prepareRename", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("prern"),
          cmd: "lsp/request",
          method: "textDocument/prepareRename",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("format")
  .description("textDocument/formatting (default: dry-run)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .option("--apply", "apply edits to files")
  .option("--tab-size <n>", "tab size", "2")
  .option("--insert-spaces <bool>", "insert spaces", "true")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli format <file>",
      "  lsp-cli format --apply <file>",
      "  lsp-cli format --tab-size 4 --insert-spaces false <file>",
      "  lsp-cli format --stdin",
      "",
      "NOTES:",
      "  - Default is dry-run; apply changes only with --apply.",
      "  - The server may return TextEdit[]; lsp-cli normalizes it to a WorkspaceEdit.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic format src/main.rs",
      "",
      "  lsp-cli --root samples/rust-basic format --apply src/main.rs",
      ""
    ].join("\n")
  )
  .action(async (fileArg?: string, cmdOpts?: { apply?: boolean; tabSize?: string; insertSpaces?: string }) => {
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

    const wantsApply = !!cmdOpts?.apply;
    const formattingOptions = {
      tabSize: parseIntStrict(String(cmdOpts?.tabSize ?? "2")),
      insertSpaces: String(cmdOpts?.insertSpaces ?? "true") !== "false"
    };

    const normalizeToWorkspaceEdit = (res: any): any => {
      if (res && (res.changes || res.documentChanges)) return res;
      if (Array.isArray(res)) return { changes: { [uri]: res } };
      if (res == null) return { changes: { [uri]: [] } };
      throw new Error("unexpected formatting result (expected TextEdit[] or WorkspaceEdit)");
    };

    const edit = normalizeToWorkspaceEdit(
      await withDaemonFallback(
        opts,
        async () => {
          const root = path.resolve(opts.root ?? process.cwd());
          const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);
          const client = new LspClient({ rootPath: root, server: profile, applyEdits: wantsApply });
          await client.start();
          try {
            await client.openTextDocument(abs);
            return await client.request("textDocument/formatting", {
              textDocument: { uri },
              options: formattingOptions
            });
          } finally {
            await client.shutdown();
          }
        },
        async (client) => {
          return await client.request({
            id: newRequestId("fmt"),
            cmd: "lsp/request",
            method: "textDocument/formatting",
            params: {
              textDocument: { uri },
              options: formattingOptions
            }
          });
        }
      )
    );

    if (wantsApply) {
      await applyWorkspaceEdit(edit);
      output({ format: opts.format, jq: opts.jq }, { applied: true });
      return;
    }

    output({ format: opts.format, jq: opts.jq }, opts.format === "pretty" && !opts.jq ? formatWorkspaceEditPretty(edit) : edit);
  });

program
  .command("format-range")
  .description("textDocument/rangeFormatting (default: dry-run)")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[startLine]", "0-based start line")
  .argument("[startCol]", "0-based start column")
  .argument("[endLine]", "0-based end line")
  .argument("[endCol]", "0-based end column")
  .option("--apply", "apply edits to files")
  .option("--tab-size <n>", "tab size", "2")
  .option("--insert-spaces <bool>", "insert spaces", "true")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli format-range <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli format-range --apply <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli format-range --stdin",
      "",
      "NOTES:",
      "  - Default is dry-run; apply changes only with --apply.",
      "  - line/col are 0-based (LSP compliant).",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic format-range src/main.rs 0 0 10 0",
      ""
    ].join("\n")
  )
  .action(
    async (
      fileArg?: string,
      startLineArg?: string,
      startColArg?: string,
      endLineArg?: string,
      endColArg?: string,
      cmdOpts?: { apply?: boolean; tabSize?: string; insertSpaces?: string }
    ) => {
      const opts = program.opts() as GlobalOpts;

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
      const formattingOptions = {
        tabSize: parseIntStrict(String(cmdOpts?.tabSize ?? "2")),
        insertSpaces: String(cmdOpts?.insertSpaces ?? "true") !== "false"
      };

      const range = {
        start: { line: parseIntStrict(String(startLine)), character: parseIntStrict(String(startCol)) },
        end: { line: parseIntStrict(String(endLine)), character: parseIntStrict(String(endCol)) }
      };

      const normalizeToWorkspaceEdit = (res: any): any => {
        if (res && (res.changes || res.documentChanges)) return res;
        if (Array.isArray(res)) return { changes: { [uri]: res } };
        if (res == null) return { changes: { [uri]: [] } };
        throw new Error("unexpected rangeFormatting result (expected TextEdit[] or WorkspaceEdit)");
      };

      const edit = normalizeToWorkspaceEdit(
        await withDaemonFallback(
          opts,
          async () => {
            const root = path.resolve(opts.root ?? process.cwd());
            const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);
            const client = new LspClient({ rootPath: root, server: profile, applyEdits: wantsApply });
            await client.start();
            try {
              await client.openTextDocument(abs);
              return await client.request("textDocument/rangeFormatting", {
                textDocument: { uri },
                range,
                options: formattingOptions
              });
            } finally {
              await client.shutdown();
            }
          },
          async (client) => {
            return await client.request({
              id: newRequestId("fmtr"),
              cmd: "lsp/request",
              method: "textDocument/rangeFormatting",
              params: {
                textDocument: { uri },
                range,
                options: formattingOptions
              }
            });
          }
        )
      );

      if (wantsApply) {
        await applyWorkspaceEdit(edit);
        output({ format: opts.format, jq: opts.jq }, { applied: true });
        return;
      }

      output({ format: opts.format, jq: opts.jq }, opts.format === "pretty" && !opts.jq ? formatWorkspaceEditPretty(edit) : edit);
    }
  );

program
  .command("completion")
  .description("textDocument/completion")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli completion <file> <line> <col>",
      "  lsp-cli completion --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - Result may be CompletionItem[] or CompletionList.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic completion src/main.rs 0 0",
      ""
    ].join("\n")
  )
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
          return await client.request("textDocument/completion", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("cmpl"),
          cmd: "lsp/request",
          method: "textDocument/completion",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("document-highlight")
  .description("textDocument/documentHighlight")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli document-highlight <file> <line> <col>",
      "  lsp-cli document-highlight --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic document-highlight src/main.rs 0 0",
      ""
    ].join("\n")
  )
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
          return await client.request("textDocument/documentHighlight", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("hilite"),
          cmd: "lsp/request",
          method: "textDocument/documentHighlight",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("inlay-hints")
  .description("textDocument/inlayHint")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[startLine]", "0-based start line")
  .argument("[startCol]", "0-based start column")
  .argument("[endLine]", "0-based end line")
  .argument("[endCol]", "0-based end column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli inlay-hints <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli inlay-hints --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic inlay-hints src/main.rs 0 0 10 0",
      ""
    ].join("\n")
  )
  .action(async (fileArg?: string, startLineArg?: string, startColArg?: string, endLineArg?: string, endColArg?: string) => {
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

    const range = {
      start: { line: parseIntStrict(String(startLine)), character: parseIntStrict(String(startCol)) },
      end: { line: parseIntStrict(String(endLine)), character: parseIntStrict(String(endCol)) }
    };

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);
          return await client.request("textDocument/inlayHint", {
            textDocument: { uri },
            range
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("inlay"),
          cmd: "lsp/request",
          method: "textDocument/inlayHint",
          params: {
            textDocument: { uri },
            range
          }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("semantic-tokens-full")
  .description("textDocument/semanticTokens/full")
  .argument("[file]", "file path, or '-' to read from stdin")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli semantic-tokens-full <file>",
      "  lsp-cli semantic-tokens-full --stdin",
      "",
      "NOTES:",
      "  - Returns server-specific encoded semantic tokens.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic semantic-tokens-full src/main.rs",
      ""
    ].join("\n")
  )
  .action(async (fileArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

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
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);
          return await client.request("textDocument/semanticTokens/full", { textDocument: { uri } });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("stfull"),
          cmd: "lsp/request",
          method: "textDocument/semanticTokens/full",
          params: { textDocument: { uri } }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("semantic-tokens-range")
  .description("textDocument/semanticTokens/range")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[startLine]", "0-based start line")
  .argument("[startCol]", "0-based start column")
  .argument("[endLine]", "0-based end line")
  .argument("[endCol]", "0-based end column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli semantic-tokens-range <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli semantic-tokens-range --stdin",
      "",
      "NOTES:",
      "  - Returns server-specific encoded semantic tokens.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic semantic-tokens-range src/main.rs 0 0 10 0",
      ""
    ].join("\n")
  )
  .action(async (fileArg?: string, startLineArg?: string, startColArg?: string, endLineArg?: string, endColArg?: string) => {
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

    const range = {
      start: { line: parseIntStrict(String(startLine)), character: parseIntStrict(String(startCol)) },
      end: { line: parseIntStrict(String(endLine)), character: parseIntStrict(String(endCol)) }
    };

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);
          return await client.request("textDocument/semanticTokens/range", { textDocument: { uri }, range });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("strng"),
          cmd: "lsp/request",
          method: "textDocument/semanticTokens/range",
          params: { textDocument: { uri }, range }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("semantic-tokens-delta")
  .description("textDocument/semanticTokens/full/delta")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[previousResultId]", "previous resultId")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli semantic-tokens-delta <file> <previousResultId>",
      "  lsp-cli semantic-tokens-delta --stdin",
      "",
      "NOTES:",
      "  - Delta is supported only if the server returns resultId.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic semantic-tokens-delta src/main.rs <previousResultId>",
      ""
    ].join("\n")
  )
  .action(async (fileArg?: string, previousResultIdArg?: string) => {
    const opts = program.opts() as GlobalOpts;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, root, opts.config, opts.serverCmd);

    let file = fileArg;
    let previousResultId = previousResultIdArg;
    if (opts.stdin) {
      const params = JSON.parse(await readAllStdin()) as { file: string; previousResultId?: string };
      file = params.file;
      previousResultId = params.previousResultId;
    } else if (file === "-") {
      file = (await readAllStdin()).trim();
    }
    if (!file || !previousResultId) throw new Error("file/previousResultId are required (or use --stdin)");

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);

    const res = await withDaemonFallback(
      opts,
      async () => {
        const client = new LspClient({ rootPath: root, server: profile });
        await client.start();
        try {
          await client.openTextDocument(abs);
          return await client.request("textDocument/semanticTokens/full/delta", {
            textDocument: { uri },
            previousResultId
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("stdlt"),
          cmd: "lsp/request",
          method: "textDocument/semanticTokens/full/delta",
          params: { textDocument: { uri }, previousResultId }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, res);
  });

program
  .command("symbols")
  .description("textDocument/documentSymbol")
  .argument("[file]", "file path, or '-' to read from stdin")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli symbols <file>",
      "  lsp-cli symbols --stdin",
      "",
      "NOTES:",
      "  - With --format pretty, prints an outline-like view.",
      "  - Pass '-' as <file> to read a file path from stdin.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty symbols src/main.rs",
      "",
      "  echo 'src/main.rs' | lsp-cli --root samples/rust-basic symbols -",
      "",
      "  echo '{\"file\":\"src/main.rs\"}' | lsp-cli --root samples/rust-basic symbols --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli references <file> <line> <col>",
      "  lsp-cli --format pretty references <file> <line> <col>",
      "  lsp-cli references --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - This command includes declarations (includeDeclaration=true).",
      "  - Use --wait-ms if the server needs warm-up.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty references src/main.rs 0 0",
      "",
      "  echo '{\"file\":\"src/main.rs\",\"line\":0,\"col\":0}' | lsp-cli --root samples/rust-basic references --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli definition <file> <line> <col>",
      "  lsp-cli --format pretty definition <file> <line> <col>",
      "  lsp-cli definition --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - Result is typically a Location | Location[] | LocationLink[].",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty definition src/main.rs 0 0",
      "",
      "  echo '{\"file\":\"src/main.rs\",\"line\":0,\"col\":0}' | lsp-cli --root samples/rust-basic definition --stdin",
      ""
    ].join("\n")
  )
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
  .command("implementation")
  .description("textDocument/implementation")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli implementation <file> <line> <col>",
      "  lsp-cli --format pretty implementation <file> <line> <col>",
      "  lsp-cli implementation --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - Result is typically a Location | Location[] | LocationLink[].",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty implementation src/main.rs 0 0",
      ""
    ].join("\n")
  )
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

          return await client.request("textDocument/implementation", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("impl"),
          cmd: "lsp/request",
          method: "textDocument/implementation",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res);
  });

program
  .command("type-definition")
  .description("textDocument/typeDefinition")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli type-definition <file> <line> <col>",
      "  lsp-cli --format pretty type-definition <file> <line> <col>",
      "  lsp-cli type-definition --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - Result is typically a Location | Location[] | LocationLink[].",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty type-definition src/main.rs 0 0",
      ""
    ].join("\n")
  )
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

          return await client.request("textDocument/typeDefinition", {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          });
        } finally {
          await client.shutdown();
        }
      },
      async (client) => {
        return await client.request({
          id: newRequestId("typedef"),
          cmd: "lsp/request",
          method: "textDocument/typeDefinition",
          params: {
            textDocument: { uri },
            position: { line: parseIntStrict(line), character: parseIntStrict(col) }
          }
        });
      }
    );

    output({ format: opts.format, jq: opts.jq }, opts.format === "pretty" && !opts.jq ? formatLocationsPretty(res) : res);
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
  .command("hover")
  .description("textDocument/hover")
  .argument("[file]", "file path, or '-' to read from stdin")
  .argument("[line]", "0-based line")
  .argument("[col]", "0-based column")
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli hover <file> <line> <col>",
      "  lsp-cli hover --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - With --format pretty, formats MarkupContent for readability.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty hover src/main.rs 0 0",
      "",
      "  echo '{\"file\":\"src/main.rs\",\"line\":0,\"col\":0}' | lsp-cli --root samples/rust-basic hover --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli signature-help <file> <line> <col>",
      "  lsp-cli signature-help --stdin",
      "",
      "NOTES:",
      "  - line/col are 0-based (LSP compliant).",
      "  - Some servers need a warm-up; adjust --wait-ms if needed.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty signature-help src/main.rs 0 0",
      "",
      "  echo '{\"file\":\"src/main.rs\",\"line\":0,\"col\":0}' | lsp-cli --root samples/rust-basic signature-help --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli ws-symbols [query]",
      "  lsp-cli ws-symbols -              # read query from stdin",
      "  lsp-cli ws-symbols --stdin",
      "",
      "NOTES:",
      "  - This searches the whole workspace (server-defined).",
      "  - Use --limit to cap results (default: 50).",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic --format pretty ws-symbols add",
      "",
      "  echo 'add' | lsp-cli --root samples/rust-basic ws-symbols -",
      "",
      "  echo '{\"query\":\"add\"}' | lsp-cli --root samples/rust-basic ws-symbols --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli delete-symbol <file> <symbolName> [--kind <kind>] [--index <n>]",
      "  lsp-cli delete-symbol --stdin [--kind <kind>] [--index <n>]",
      "",
      "NOTES:",
      "  - Uses textDocument/documentSymbol then deletes the chosen symbol's range.",
      "  - Default is dry-run. Use --apply to change files.",
      "  - If multiple matches exist, omit --index to list candidates.",
      "",
      "EXAMPLES:",
      "  lsp-cli --root samples/rust-basic delete-symbol samples/rust-basic/src/math.rs add --apply",
      "",
      "  echo '{\"file\":\"samples/rust-basic/src/math.rs\",\"symbolName\":\"add\"}' | lsp-cli --root samples/rust-basic delete-symbol --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli rename <file> <line> <col> <newName>",
      "  lsp-cli rename --apply <file> <line> <col> <newName>",
      "  lsp-cli rename --stdin",
      "",
      "NOTES:",
      "  - Default is dry-run; changes are applied only with --apply.",
      "  - line/col are 0-based (LSP compliant).",
      "",
      "EXAMPLES:",
      "  # dry-run (show planned edits)",
      "  lsp-cli --root samples/rust-basic rename src/math.rs 0 4 add",
      "",
      "  # apply edits", 
      "  lsp-cli --root samples/rust-basic rename --apply src/math.rs 0 4 add",
      "",
      "  # via --stdin (JSON)",
      "  echo '{\"file\":\"src/math.rs\",\"line\":0,\"col\":4,\"newName\":\"add\"}' | lsp-cli --root samples/rust-basic rename --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli code-actions <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli code-actions --first --kind <prefix> <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli code-actions --apply --index <n> <file> <startLine> <startCol> <endLine> <endCol>",
      "  lsp-cli code-actions --stdin",
      "",
      "NOTES:",
      "  - Without selectors, prints a summarized list (index/title/kind/etc).",
      "  - To apply, select exactly one action via --index or selectors + --first, then pass --apply.",
      "  - Some servers return Command-only actions; lsp-cli will run workspace/executeCommand when needed.",
      "",
      "EXAMPLES:",
      "  # list actions for a range",
      "  lsp-cli --root samples/rust-basic --format pretty code-actions src/main.rs 0 0 0 10",
      "",
      "  # apply first quickfix action",
      "  lsp-cli --root samples/rust-basic code-actions --apply --kind quickfix --first src/main.rs 0 0 0 10",
      "",
      "  # via --stdin (JSON)",
      "  echo '{\"file\":\"src/main.rs\",\"startLine\":0,\"startCol\":0,\"endLine\":0,\"endCol\":10}' | lsp-cli --root samples/rust-basic code-actions --stdin",
      ""
    ].join("\n")
  )
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
  .addHelpText(
    "after",
    [
      "",
      "USAGE:",
      "  lsp-cli --root <root> --format json batch < requests.jsonl",
      "  lsp-cli --root <root> --format json batch --apply < requests.jsonl",
      "",
      "NOTES:",
      "  - batch reads JSONL from stdin (one JSON object per line).",
      "  - Do not use --stdin with batch; use shell redirection/pipes.",
      "  - batch requires --format json and does not support --jq.",
      "  - Edits are only applied if both: batch started with --apply AND the request has {" +
        "\"apply\":true}.",
      "  - Supported cmds include: ping, request, notify, symbols, references, definition, implementation, type-definition, hover, signature-help, ws-symbols, rename, delete-symbol, code-actions.",
      "",
      "EXAMPLE:",
      "  cat <<'JSONL' | lsp-cli --root samples/rust-basic --format json batch",
      "  {\"id\":1,\"cmd\":\"definition\",\"file\":\"src/main.rs\",\"line\":0,\"col\":0}",
      "  {\"id\":2,\"cmd\":\"ws-symbols\",\"query\":\"add\"}",
      "  JSONL",
      ""
    ].join("\n")
  )
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

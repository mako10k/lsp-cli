#!/usr/bin/env node

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient } from "./lsp/LspClient";
import { getServerProfile } from "./servers";
import { applyWorkspaceEdit, formatWorkspaceEditPretty } from "./lsp/workspaceEdit";
import { pathToFileUri } from "./util/paths";

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
};

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    process.stdin.on("data", (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
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

    output({ format: opts.format, jq: opts.jq }, { ok: true });
  });

program
  .command("symbols")
  .description("textDocument/documentSymbol")
  .argument("[file]", "file path, or '-' to read from stdin")
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

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);
    const res = await client.request("textDocument/documentSymbol", {
      textDocument: { uri }
    });

    await client.shutdown();
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

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const res = await client.request("textDocument/references", {
      textDocument: { uri },
      position: { line: parseIntStrict(line), character: parseIntStrict(col) },
      context: { includeDeclaration: true }
    });

    await client.shutdown();
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

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
    if (waitMs > 0) await sleep(waitMs);

    const res = await client.request("textDocument/definition", {
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

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
    if (waitMs > 0) await sleep(waitMs);

    const res = await client.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: parseIntStrict(line), character: parseIntStrict(col) }
    });

    await client.shutdown();
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

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);

    const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
    if (waitMs > 0) await sleep(waitMs);

    const res = await client.request("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: parseIntStrict(line), character: parseIntStrict(col) }
    });

    await client.shutdown();
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

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const waitMs = parseIntStrict(String(opts.waitMs ?? "0"));
    if (waitMs > 0) await sleep(waitMs);

    const res = (await client.request("workspace/symbol", { query })) as any[];
    await client.shutdown();

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

      const client = new LspClient({ rootPath: root, server: profile });
      await client.start();

      const abs = path.resolve(file);
      const uri = pathToFileUri(abs);
      await client.openTextDocument(abs);

      const edit = await client.request("textDocument/rename", {
        textDocument: { uri },
        position: { line: parseIntStrict(line), character: parseIntStrict(col) },
        newName
      });

      if (cmdOpts.apply) {
        await applyWorkspaceEdit(edit);
        await client.shutdown();
        output({ format: opts.format, jq: opts.jq }, { applied: true });
        return;
      }

      await client.shutdown();
      output(
        { format: opts.format, jq: opts.jq },
        opts.format === "pretty" && !opts.jq ? formatWorkspaceEditPretty(edit) : edit
      );
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
  .option("--apply", "apply selected action (default is dry-run)")
  .action(
    async (
      fileArg?: string,
      startLineArg?: string,
      startColArg?: string,
      endLineArg?: string,
      endColArg?: string,
      cmdOpts?: { index?: string; apply?: boolean }
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

      const client = new LspClient({ rootPath: root, server: profile, applyEdits: !!cmdOpts?.apply });
      await client.start();

      const abs = path.resolve(file);
      const uri = pathToFileUri(abs);
      await client.openTextDocument(abs);

      const actions = (await client.request("textDocument/codeAction", {
        textDocument: { uri },
        range: {
          start: { line: parseIntStrict(startLine), character: parseIntStrict(startCol) },
          end: { line: parseIntStrict(endLine), character: parseIntStrict(endCol) }
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

      const idx = cmdOpts?.index != null ? parseIntStrict(String(cmdOpts.index)) : undefined;
      if (idx == null) {
        await client.shutdown();
        output(
          { format: opts.format, jq: opts.jq },
          opts.format === "pretty" && !opts.jq ? formatCodeActionsPretty(summarized) : summarized
        );
        return;
      }

      const selected = actions?.[idx];
      if (!selected) {
        await client.shutdown();
        throw new Error(`no code action at index ${idx}`);
      }

      if (!cmdOpts?.apply) {
        await client.shutdown();
        output(
          { format: opts.format, jq: opts.jq },
          opts.format === "pretty" && !opts.jq
            ? `DRY-RUN [${idx}] ${String(selected?.title ?? "")}`
            : { dryRun: true, index: idx, action: selected }
        );
        return;
      }

      if (selected.edit) {
        await applyWorkspaceEdit(selected.edit);
        await client.shutdown();
        output({ format: opts.format, jq: opts.jq }, { applied: true, index: idx, title: selected.title });
        return;
      }

      // LSP allows returning Command objects (or CodeAction.command).
      const cmd = selected.command;
      if (cmd && typeof cmd.command === "string") {
        const res = await client.request("workspace/executeCommand", {
          command: cmd.command,
          arguments: cmd.arguments
        });
        await client.shutdown();
        output({ format: opts.format, jq: opts.jq }, { executed: true, index: idx, title: selected.title, result: res });
        return;
      }

      await client.shutdown();
      throw new Error("selected code action has neither edit nor executable command");
    }
  );

(async () => {
  await program.parseAsync(process.argv);
})().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exitCode = 1;
});

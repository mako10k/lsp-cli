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

function formatLocationsPretty(res: any): string {
  if (!res) return "(no result)";
  const arr = Array.isArray(res) ? res : [res];
  if (arr.length === 0) return "(no result)";

  const uriToDisplay = (uri: string): string => {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  };

  const rangeToStr = (r: any) => `${r.start.line}:${r.start.character} -> ${r.end.line}:${r.end.character}`;

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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    output({ format: opts.format, jq: opts.jq }, res);
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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    output({ format: opts.format, jq: opts.jq }, res);
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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
      const profile = getServerProfile(opts.server, opts.serverCmd);

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
      const profile = getServerProfile(opts.server, opts.serverCmd);

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

      const client = new LspClient({ rootPath: root, server: profile });
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

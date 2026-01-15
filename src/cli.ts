#!/usr/bin/env node

import { Command } from "commander";
import path from "node:path";
import { LspClient } from "./lsp/LspClient";
import { getServerProfile } from "./servers";
import { applyWorkspaceEdit, formatWorkspaceEditPretty } from "./lsp/workspaceEdit";
import { pathToFileUri } from "./util/paths";

type OutputFormat = "json" | "pretty";

function parseIntStrict(v: string): number {
  if (!/^[-+]?\d+$/.test(v)) throw new Error(`invalid integer: ${v}`);
  return Number.parseInt(v, 10);
}

function output(format: OutputFormat, value: unknown) {
  if (format === "json") {
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
  .addHelpText(
    "after",
    "\nPosition notes:\n  line/col are 0-based (LSP compliant). Example: line=0 col=0 is the first character.\n"
  );

program
  .command("ping")
  .description("Initialize and shutdown the server")
  .action(async () => {
    const opts = program.opts();
    const format = opts.format as OutputFormat;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, opts.serverCmd);

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();
    await client.shutdown();
    output(format, { ok: true });
  });

program
  .command("symbols")
  .description("textDocument/documentSymbol")
  .argument("<file>", "file path")
  .action(async (file: string) => {
    const opts = program.opts();
    const format = opts.format as OutputFormat;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, opts.serverCmd);

    const client = new LspClient({ rootPath: root, server: profile });
    await client.start();

    const abs = path.resolve(file);
    const uri = pathToFileUri(abs);
    await client.openTextDocument(abs);
    const res = await client.request("textDocument/documentSymbol", {
      textDocument: { uri }
    });

    await client.shutdown();
    output(format, res);
  });

program
  .command("references")
  .description("textDocument/references")
  .argument("<file>", "file path")
  .argument("<line>", "0-based line")
  .argument("<col>", "0-based column")
  .action(async (file: string, line: string, col: string) => {
    const opts = program.opts();
    const format = opts.format as OutputFormat;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
    output(format, res);
  });

program
  .command("rename")
  .description("textDocument/rename (default: --dry-run)")
  .argument("<file>", "file path")
  .argument("<line>", "0-based line")
  .argument("<col>", "0-based column")
  .argument("<newName>", "new name")
  .option("--apply", "apply WorkspaceEdit to files")
  .option("--dry-run", "show planned edits only", true)
  .action(async (file: string, line: string, col: string, newName: string, cmdOpts: { apply?: boolean }) => {
    const opts = program.opts();
    const format = opts.format as OutputFormat;
    const root = path.resolve(opts.root ?? process.cwd());
    const profile = getServerProfile(opts.server, opts.serverCmd);

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
      output(format, { applied: true });
      return;
    }

    await client.shutdown();
    output(format, format === "pretty" ? formatWorkspaceEditPretty(edit) : edit);
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exitCode = 1;
});

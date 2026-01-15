#!/usr/bin/env node

import { Command } from "commander";
import { spawnSync } from "node:child_process";
import path from "node:path";
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
  .addHelpText(
    "after",
    [
      "",
      "Position notes:",
      "  line/col are 0-based (LSP compliant). Example: line=0 col=0 is the first character.",
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

(async () => {
  await program.parseAsync(process.argv);
})().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + "\n");
  process.exitCode = 1;
});

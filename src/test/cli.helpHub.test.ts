import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./helpers";

test("cli help toc is navigable and includes USAGE", async () => {
  const res = await runCli(["help", "toc"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /lsp-cli help \(TOC\)/);
  assert.match(res.stdout, /USAGE:/);
  assert.match(res.stdout, /lsp-cli help commands/);
});

test("cli help commands shows categorized command index", async () => {
  const res = await runCli(["help", "commands"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /command index/);
  assert.match(res.stdout, /Read-only navigation:/);
  assert.match(res.stdout, /rename/);
});

test("cli help examples shows use-case samples", async () => {
  const res = await runCli(["help", "examples"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /use-case samples/);
  assert.match(res.stdout, /Navigate/);
});

test("cli help <command> delegates to command help", async () => {
  const res = await runCli(["help", "symbols"]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /Usage: lsp-cli symbols/);
  assert.match(res.stdout, /textDocument\/documentSymbol/);
  assert.match(res.stdout, /USAGE:/);
  assert.match(res.stdout, /EXAMPLES:/);
});

test("cli per-command help includes appendices for common commands", async () => {
  const cmds = [
    "symbols",
    "references",
    "definition",
    "type-definition",
    "implementation",
    "hover",
    "signature-help",
    "ws-symbols",
    "completion",
    "document-highlight",
    "inlay-hints",
    "semantic-tokens-full",
    "semantic-tokens-range",
    "semantic-tokens-delta",
    "prepare-rename",
    "did-change-configuration",
    "format",
    "format-range",
    "rename",
    "code-actions",
    "batch",
    "apply-edits",
    "daemon-request",
    "delete-symbol",
    "events",
    "daemon-status",
    "daemon-stop",
    "server-status",
    "server-stop",
    "server-restart",
    "daemon-log"
  ];

  for (const cmd of cmds) {
    const res = await runCli([cmd, "--help"]);
    assert.equal(res.code, 0, `${cmd} --help should exit 0`);
    assert.match(res.stdout, /USAGE:/, `${cmd} help should include USAGE`);
    assert.match(res.stdout, /EXAMPLES?:/, `${cmd} help should include EXAMPLE(S)`);
  }
});

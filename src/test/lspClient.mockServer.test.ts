import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LspClient } from "../lsp/LspClient";

test("LspClient works with mock server (initialize/open/didChange + basic requests)", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-mock-"));
  const file = path.join(root, "a.txt");
  await fs.writeFile(file, "a😀b\n", "utf8");

  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");

  const client = new LspClient({
    rootPath: root,
    server: {
      name: "mock",
      command: process.execPath,
      args: [serverScript],
      languageIdForPath: () => "plaintext"
    }
  });

  await client.start();

  const init = await client.request("mock/getLastInitialize");
  assert.equal(init?.capabilities?.workspace?.applyEdit, true);
  assert.equal(init?.capabilities?.workspace?.workspaceEdit?.documentChanges, true);
  assert.deepEqual(init?.capabilities?.workspace?.workspaceEdit?.resourceOperations, ["create", "rename", "delete"]);
  assert.equal(init?.capabilities?.workspace?.workspaceEdit?.snippetEditSupport, undefined);
  assert.equal(init?.capabilities?.workspace?.diagnostics?.refreshSupport, false);
  assert.equal(init?.capabilities?.textDocument?.synchronization?.didSave, true);
  assert.equal(init?.capabilities?.textDocument?.publishDiagnostics?.versionSupport, true);
  assert.equal(init?.capabilities?.textDocument?.publishDiagnostics?.markupMessageSupport, undefined);
  assert.equal(init?.capabilities?.textDocument?.diagnostic?.relatedDocumentSupport, true);
  assert.equal(init?.capabilities?.textDocument?.diagnostic?.markupMessageSupport, true);
  assert.equal(init?.capabilities?.textDocument?.diagnostic?.versionSupport, undefined);
  assert.deepEqual(init?.capabilities?.textDocument?.hover?.contentFormat, ["markdown", "plaintext"]);
  assert.equal(init?.capabilities?.textDocument?.rename?.prepareSupport, true);
  assert.equal(init?.capabilities?.textDocument?.codeAction?.disabledSupport, true);
  assert.equal(init?.capabilities?.textDocument?.codeAction?.resolveSupport, undefined);
  assert.equal(init?.capabilities?.textDocument?.semanticTokens?.requests?.full?.delta, true);
  assert.deepEqual(init?.capabilities?.general?.positionEncodings, ["utf-16"]);

  await client.openTextDocument(file);
  const didOpen = await client.request("mock/getLastDidOpen");
  assert.equal(didOpen?.textDocument?.version, 1);
  assert.equal(didOpen?.textDocument?.text, "a😀b\n");

  // Change 😀 (2 UTF-16 code units) to X, expecting a single incremental change.
  await client.changeTextDocument(file, "aXb\n");
  const didChange = await client.request("mock/getLastDidChange");

  assert.equal(didChange?.textDocument?.version, 2);
  assert.ok(Array.isArray(didChange?.contentChanges));
  assert.equal(didChange.contentChanges.length, 1);

  const ch = didChange.contentChanges[0];
  assert.equal(ch.text, "X");
  assert.deepEqual(ch.range, {
    start: { line: 0, character: 1 },
    end: { line: 0, character: 3 }
  });

  const syms = await client.request("textDocument/documentSymbol", {
    textDocument: { uri: didOpen.textDocument.uri }
  });
  assert.ok(Array.isArray(syms));
  assert.equal(syms[0]?.name, "MockSymbol");

  const refs = await client.request("textDocument/references", {
    textDocument: { uri: didOpen.textDocument.uri },
    position: { line: 0, character: 0 },
    context: { includeDeclaration: true }
  });
  assert.ok(Array.isArray(refs));

  const edit = await client.request("textDocument/rename", {
    textDocument: { uri: didOpen.textDocument.uri },
    position: { line: 0, character: 0 },
    newName: "NEW"
  });
  assert.ok(edit?.changes);

  await client.shutdown();
});

test("LspClient handles workspace/applyEdit initiated by server", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-mock-"));
  const file = path.join(root, "b.txt");
  await fs.writeFile(file, "hello\n", "utf8");

  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");

  const client = new LspClient({
    rootPath: root,
    applyEdits: true,
    server: {
      name: "mock",
      command: process.execPath,
      args: [serverScript],
      languageIdForPath: () => "plaintext"
    }
  });

  await client.start();
  await client.openTextDocument(file);

  const didOpen = await client.request("mock/getLastDidOpen");
  const uri = didOpen?.textDocument?.uri;
  assert.equal(typeof uri, "string");

  await client.request("workspace/executeCommand", {
    command: "mock/applyEdit",
    arguments: [{ uri, newText: "Z" }]
  });

  const updated = await fs.readFile(file, "utf8");
  assert.equal(updated, "Zhello\n");

  await client.shutdown();
});

test("LspClient allows server profiles to override client capabilities", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-mock-caps-"));
  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");

  const client = new LspClient({
    rootPath: root,
    server: {
      name: "mock",
      command: process.execPath,
      args: [serverScript],
      languageIdForPath: () => "plaintext",
      clientCapabilities: {
        textDocument: {
          hover: { contentFormat: ["plaintext"] },
          semanticTokens: { requests: { full: false } }
        },
        workspace: {
          workspaceEdit: { resourceOperations: ["create"] }
        }
      }
    }
  });

  await client.start();
  const init = await client.request("mock/getLastInitialize");

  assert.deepEqual(init?.capabilities?.textDocument?.hover?.contentFormat, ["plaintext"]);
  assert.equal(init?.capabilities?.textDocument?.semanticTokens?.requests?.full, false);
  assert.equal(init?.capabilities?.textDocument?.semanticTokens?.requests?.range, true);
  assert.deepEqual(init?.capabilities?.workspace?.workspaceEdit?.resourceOperations, ["create"]);
  assert.equal(init?.capabilities?.workspace?.workspaceEdit?.documentChanges, true);

  await client.shutdown();
});

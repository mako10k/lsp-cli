import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DaemonServer } from "../daemon/DaemonServer";
import { DaemonClient } from "../daemon/DaemonClient";
import { newRequestId } from "../daemon/protocol";

function eventually(timeoutMs: number, intervalMs: number, fn: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise(async (resolve, reject) => {
    while (Date.now() < deadline) {
      try {
        if (await fn()) return resolve();
      } catch {
        // ignore
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    reject(new Error("timeout waiting for condition"));
  });
}

test("daemon events can pull diagnostics with since cursor", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-daemon-ev-"));

  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");
  const cfgPath = path.join(root, "lsp-cli.config.json");
  await fs.writeFile(
    cfgPath,
    JSON.stringify(
      {
        servers: {
          mock: {
            command: process.execPath,
            args: [serverScript],
            defaultLanguageId: "plaintext"
          }
        }
      },
      null,
      2
    ),
    "utf8"
  );

  const daemon = new DaemonServer({ rootPath: root, serverName: "mock", configPath: cfgPath });
  await daemon.start();

  const client = await DaemonClient.connect(daemon.getSocketPath());
  try {
    // Seed: nothing yet
    const empty = await client.request<{ nextCursor: number; events: any[] }>({ id: newRequestId("ev"), cmd: "events/get", kind: "diagnostics", since: 0, limit: 100 });
    assert.deepEqual(empty.events, []);

    const uri = "file:///dummy.txt";
    await client.request({
      id: newRequestId("lsp"),
      cmd: "lsp/request",
      method: "mock/sendDiagnostics",
      params: {
        uri,
        diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: "m1" }]
      }
    });

    await eventually(1000, 25, async () => {
      const got = await client.request<{ nextCursor: number; events: any[] }>({ id: newRequestId("ev"), cmd: "events/get", kind: "diagnostics", since: 0, limit: 10 });
      return got.events.length >= 1;
    });

    const res1 = await client.request<{ nextCursor: number; events: any[] }>({ id: newRequestId("ev"), cmd: "events/get", kind: "diagnostics", since: 0, limit: 100 });
    assert.ok(res1.events.length >= 1);
    assert.ok(res1.nextCursor >= res1.events[res1.events.length - 1].cursor);

    const res2 = await client.request<{ nextCursor: number; events: any[] }>({ id: newRequestId("ev"), cmd: "events/get", kind: "diagnostics", since: res1.nextCursor, limit: 100 });
    assert.deepEqual(res2.events, []);
  } finally {
    client.close();
    await daemon.stop();
  }
});

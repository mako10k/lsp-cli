import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DaemonServer } from "../daemon/DaemonServer";
import { DaemonClient } from "../daemon/DaemonClient";
import { newRequestId } from "../daemon/protocol";

test("daemon log set/get works over UDS", { timeout: 10_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-daemon-"));

  const serverScript = path.resolve(__dirname, "../mock/mockLspServer.js");

  // Provide a hermetic server profile via config so DaemonServer can start without external deps.
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

  const daemon = new DaemonServer({
    rootPath: root,
    serverName: "mock",
    configPath: cfgPath
  });

  await daemon.start();
  const sock = daemon.getSocketPath();

  const client = await DaemonClient.connect(sock);
  try {
    const st0 = await client.request({ id: newRequestId("log"), cmd: "daemon/log/get" });
    assert.equal(st0?.mode, "discard");

    const logPath = path.join(root, "daemon.log");
    const st1 = await client.request({ id: newRequestId("log"), cmd: "daemon/log/set", mode: "file", path: logPath });
    assert.deepEqual(st1, { mode: "file", path: path.resolve(logPath) });

    const st2 = await client.request({ id: newRequestId("log"), cmd: "daemon/log/get" });
    assert.deepEqual(st2, { mode: "file", path: path.resolve(logPath) });

    const st3 = await client.request({ id: newRequestId("log"), cmd: "daemon/log/set", mode: "discard" });
    assert.deepEqual(st3, { mode: "discard" });
  } finally {
    client.close();
    await daemon.stop();
  }
});

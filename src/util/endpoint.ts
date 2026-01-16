import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type Endpoint = {
  kind: "uds";
  socketPath: string;
  defaultLogPath: string;
};

function hashForRoot(rootPath: string): string {
  const root = fs.realpathSync.native ? fs.realpathSync.native(rootPath) : fs.realpathSync(rootPath);
  return crypto.createHash("sha256").update(root).digest("hex").slice(0, 24);
}

function baseRuntimeDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  return runtimeDir && runtimeDir.trim() ? runtimeDir : os.tmpdir();
}

function safeFileToken(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export function resolveDaemonEndpoint(rootPath: string, serverName: string): Endpoint {
  const hash = hashForRoot(rootPath);
  const base = baseRuntimeDir();
  const safe = safeFileToken(serverName);

  const dir = path.join(base, "lsp-cli", hash);
  const socketPath = path.join(dir, `sock-${safe}`);
  const defaultLogPath = path.join(dir, `daemon-${safe}.log`);

  return { kind: "uds", socketPath, defaultLogPath };
}

export async function ensureEndpointDir(endpoint: Endpoint): Promise<void> {
  await fs.promises.mkdir(path.dirname(endpoint.socketPath), { recursive: true });
}

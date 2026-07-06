import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export type Endpoint = {
  kind: "uds";
  socketPath: string;
  defaultLogPath: string;
};

export type EndpointIdentity = {
  configPath?: string;
  serverCmd?: string;
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

function hashForIdentity(rootPath: string, identity?: EndpointIdentity): string {
  const parts: string[] = [];
  if (identity?.configPath?.trim()) {
    parts.push(`config=${path.resolve(rootPath, identity.configPath)}`);
  }
  if (identity?.serverCmd?.trim()) {
    parts.push(`serverCmd=${identity.serverCmd}`);
  }
  return parts.length ? crypto.createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12) : "";
}

export function resolveDaemonEndpoint(rootPath: string, serverName: string, identity?: EndpointIdentity): Endpoint {
  const hash = hashForRoot(rootPath);
  const base = baseRuntimeDir();
  const safe = safeFileToken(serverName);
  const identityHash = hashForIdentity(rootPath, identity);
  const suffix = identityHash ? `-${identityHash}` : "";

  const dir = path.join(base, "lsp-cli", hash);
  const socketPath = path.join(dir, `sock-${safe}${suffix}`);
  const defaultLogPath = path.join(dir, `daemon-${safe}${suffix}.log`);

  return { kind: "uds", socketPath, defaultLogPath };
}

export async function ensureEndpointDir(endpoint: Endpoint): Promise<void> {
  await fs.promises.mkdir(path.dirname(endpoint.socketPath), { recursive: true });
}

import fs from "node:fs";
import path from "node:path";

export type ServerConfig = {
  // Required for custom servers; optional when using `preset` or augmenting built-in profiles.
  command?: string;
  preset?: string;
  args?: string[];
  initializationOptions?: unknown;
  languageIdByExt?: Record<string, string>;
  defaultLanguageId?: string;
  cwd?: string;
  env?: Record<string, string>;
  waitMs?: number;
  warmup?: { method: string; params?: unknown };
};

export type LspCliConfigFile = {
  presets?: Record<string, ServerConfig>;
  augment?: Record<string, ServerConfig>;
  servers?: Record<string, ServerConfig>;
};

export function loadConfigFromDisk(rootPath: string, explicitPath?: string): LspCliConfigFile | null {
  const explicit = explicitPath
    ? (path.isAbsolute(explicitPath) ? explicitPath : path.join(rootPath, explicitPath))
    : undefined;

  const candidates = explicit
    ? [explicit]
    : [path.join(rootPath, ".lsp-cli.json"), path.join(rootPath, "lsp-cli.config.json")];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      return JSON.parse(raw) as LspCliConfigFile;
    } catch (e) {
      throw new Error(`failed to read config: ${p}: ${String((e as any)?.message ?? e)}`);
    }
  }

  return null;
}

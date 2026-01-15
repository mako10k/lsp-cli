import path from "node:path";
import { rustAnalyzerProfile } from "./rustAnalyzer";
import { typescriptLanguageServerProfile } from "./typescriptLanguageServer";
import type { ServerProfile } from "../lsp/LspClient";
import { loadConfigFromDisk } from "./config";

export function getServerProfile(
  name: string,
  rootPath: string,
  configPath?: string,
  overrideCmd?: string
): ServerProfile {
  const cfg = loadConfigFromDisk(rootPath, configPath);
  const fromCfg = cfg?.servers?.[name];

  if (fromCfg?.command) {
    const byExt = fromCfg.languageIdByExt ?? {};
    const defaultLanguageId = fromCfg.defaultLanguageId ?? "plaintext";

    const base: ServerProfile = {
      name,
      command: fromCfg.command,
      args: fromCfg.args ?? [],
      initializationOptions: fromCfg.initializationOptions,
      languageIdForPath: (filePath: string) => {
        const ext = path.extname(filePath);
        return byExt[ext] ?? defaultLanguageId;
      }
    };

    if (!overrideCmd) return base;
    return { ...base, command: overrideCmd };
  }

  switch (name) {
    case "rust-analyzer": {
      const base = rustAnalyzerProfile();
      if (!overrideCmd) return base;
      return { ...base, command: overrideCmd };
    }
    case "typescript-language-server": {
      const base = typescriptLanguageServerProfile();
      if (!overrideCmd) return base;
      return { ...base, command: overrideCmd };
    }
    default:
      throw new Error(`unknown server profile: ${name}`);
  }
}

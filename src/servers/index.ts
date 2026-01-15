import { rustAnalyzerProfile } from "./rustAnalyzer";
import type { ServerProfile } from "../lsp/LspClient";

export function getServerProfile(name: string, overrideCmd?: string): ServerProfile {
  switch (name) {
    case "rust-analyzer": {
      const base = rustAnalyzerProfile();
      if (!overrideCmd) return base;
      return { ...base, command: overrideCmd };
    }
    default:
      throw new Error(`unknown server profile: ${name}`);
  }
}

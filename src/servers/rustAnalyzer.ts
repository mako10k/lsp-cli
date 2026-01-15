import path from "node:path";
import type { ServerProfile } from "../lsp/LspClient";

export function rustAnalyzerProfile(): ServerProfile {
  return {
    name: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    languageIdForPath: (p: string) => {
      if (path.extname(p) === ".rs") return "rust";
      return "rust";
    }
  };
}

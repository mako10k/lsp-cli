import path from "node:path";
import type { ServerProfile } from "../lsp/LspClient";

export function typescriptLanguageServerProfile(): ServerProfile {
  return {
    name: "typescript-language-server",
    command: "npx",
    args: ["-y", "typescript-language-server", "--stdio"],
    languageIdForPath: (p: string) => {
      const ext = path.extname(p);
      switch (ext) {
        case ".ts":
          return "typescript";
        case ".tsx":
          return "typescriptreact";
        case ".js":
          return "javascript";
        case ".jsx":
          return "javascriptreact";
        case ".json":
          return "json";
        default:
          return "plaintext";
      }
    }
  };
}

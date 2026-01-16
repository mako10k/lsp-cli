# Copilot instructions for `lsp-cli`

## Big picture
- This repo is a **Node.js + TypeScript** CLI that drives arbitrary **LSP servers over stdio**.
- Main entrypoint is `src/cli.ts` (Commander-based subcommands).
- LSP transport/request lifecycle is in `src/lsp/LspClient.ts` (JSON-RPC via `vscode-jsonrpc/node`).
- Server selection is via **server profiles** in `src/servers/*` and optional config file loading in `src/servers/config.ts`.
- Edits returned by the server are applied by `src/lsp/workspaceEdit.ts` (supports `changes` + `documentChanges` incl. create/rename/delete).

## Key workflows (verified)
- Build: `npm run build` (TypeScript -> `dist/`)
- Typecheck: `npm run typecheck`
- Tests: `npm test` (builds then runs `node --test dist/test/**/*.test.js`)
- Run locally after build: `node dist/cli.js ...` or `npm run start`

## CLI conventions (project-specific)
- **Positions are 0-based** (LSP compliant): `line`/`col` are zero-indexed (documented in `src/cli.ts` help text and `README.md`).
- Global flags should appear **before** the subcommand (Commander parsing):
  - Example: `lsp-cli --root samples/rust-basic --format pretty symbols samples/rust-basic/src/math.rs`
- Input modes:
  - For `<file>`, passing `-` reads the file path from stdin.
  - `--stdin` reads JSON params for the command from stdin (see `README.md` examples).
- Output modes:
  - `--format json|pretty` (default `json`).
  - `--jq '<filter>'` pipes JSON output through `jq` (errors if `jq` missing).

## Server profiles & config
- Built-in profiles:
  - `rust-analyzer`: `src/servers/rustAnalyzer.ts` (expects `rust-analyzer` in `PATH`).
  - `typescript-language-server`: `src/servers/typescriptLanguageServer.ts` (runs `npx -y typescript-language-server --stdio`).
- Custom profiles via config file (searched by default):
  - `<root>/.lsp-cli.json` or `<root>/lsp-cli.config.json` (see `src/servers/config.ts` and `README.md`).
  - `--config <path>` overrides (relative paths are resolved from `<root>`).
- `--server-cmd` overrides only the command string; args remain from the chosen profile/config (`src/servers/index.ts`).

## Edit application (dry-run vs apply)
- The CLI is **dry-run by default** for file modifications; applying requires explicit `--apply`.
- `LspClient` also handles server-initiated `workspace/applyEdit`:
  - When `applyEdits: true`, it calls `applyWorkspaceEdit` (`src/lsp/LspClient.ts`).
- `workspaceEdit.ts` currently rejects overlapping `TextEdit`s (conflicts) and applies edits bottom-to-top.

## Patterns to follow when adding commands
- Mirror the existing flow in `src/cli.ts`:
  - Resolve `root` (`path.resolve(opts.root ?? process.cwd())`)
  - Get profile via `getServerProfile(opts.server, root, opts.config, opts.serverCmd)`
  - `await client.start()` -> `await client.openTextDocument(abs)` -> `await client.request(...)` -> `await client.shutdown()`
- Prefer reusing helpers already in `src/cli.ts` (pretty formatters, `parseIntStrict`, stdin handling) rather than introducing new parsing.

## Testing notes
- Tests that matter live in `dist/test/*.test.js` and use a mock server script from `dist/mock/mockLspServer.js`.
- When changing protocol/client behavior, update both implementation in `src/` and ensure `npm test` still passes.

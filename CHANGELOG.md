# Changelog

## Unreleased

## 0.1.4 (2026-07-06)

### Added
- Added release helper scripts for version bumping and pre-publish verification.
- Added a `code-lenses` command with optional `codeLens/resolve` support.
- Added a `linked-editing-ranges` command for LSP linked editing range queries.
- Added `folding-ranges` and `selection-ranges` commands for LSP document range queries.
- Added daemon event kinds for `window/logMessage`, `window/showMessage`, and `$/progress`.
- Added `diagnostics` and `workspace-diagnostics` commands for LSP pull diagnostics.

### Changed
- Daemon sockets now include explicit `--config` and `--server-cmd` identity to avoid reusing the wrong server session.
- `diagnostics` now falls back to `textDocument/publishDiagnostics` when a server does not support pull diagnostics.
- Daemon event queues are now bounded in memory and report cursor truncation metadata.
- Updated the LSP protocol/runtime baseline for Node 22/24 and `vscode-languageserver-protocol` 3.18.x.
- Expanded default `initialize` client capabilities and added per-profile `clientCapabilities` overrides.
- Made the Node test runner invocation explicit and documented the current requirements/backlog.

## 0.1.3 (2026-01-16)

### Added
- `--save-after-apply` + `--wait-diagnostics-ms` (opt-in) for `rename`, `format`, `code-actions` to trigger `textDocument/didSave` and optionally include `publishDiagnostics` in output.

### Changed
- `format` flags are normalized to `--save-after-apply` / `--wait-diagnostics-ms`.

### Fixed
- Daemon apply behavior for requests that return `WorkspaceEdit` directly (e.g. `rename`, `formatting`).

## 0.1.1 (2026-01-16)

### Added
- `--version` support.

### Changed
- `--format pretty` now prefers a human-readable representation for structured outputs (while `--jq` still processes JSON).
- CLI/docs/help normalization:
	- Expose `ping` in the README command index.
	- Expose `*-daemon` commands as experimental (daemon-only) in help/README.
	- Normalize `rename` help to “dry-run by default; use `--apply`” (remove `--dry-run`).

## 0.1.0 (2026-01-16)

### Added
- Daemon-first execution with automatic daemon start and fallback to direct stdio mode.
- Pull-based notifications via `events` (e.g. diagnostics and log messages).
- Server/daemon operations commands: `daemon-status`, `daemon-stop`, `server-status`, `server-stop`, `server-restart`, `daemon-log`.
- Help hub and expanded per-command help (`USAGE`/`NOTES`/`EXAMPLES`).
- Integration tests using a real server (`typescript-language-server`) for `format` and `format-range`.

### Changed
- Mutating commands are dry-run by default; pass `--apply` to actually modify files.

### Notes
- Positions are 0-based (`line`/`col`).
- `typescript-language-server` requires TypeScript to be available in the target workspace.

## 0.0.2

- Initial public release (MVP focused on rust-analyzer).

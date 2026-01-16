# Changelog

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

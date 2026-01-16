# lsp-cli

A lightweight CLI client to drive arbitrary LSP servers for structural analysis and refactoring (MVP: rust-analyzer).

## Table of contents

- [Quickstart](#quickstart)
- [Sample (for testing)](#sample-for-testing)
- [Command reference](#command-reference)
  - [Global options](#global-options)
  - [Command index](#command-index)
  - [Read-only navigation](#read-only-navigation)
  - [Edits and refactoring (mutating)](#edits-and-refactoring-mutating)
  - [Formatting and tokens](#formatting-and-tokens)
  - [Daemon and operations](#daemon-and-operations)
  - [Batch mode](#batch-mode)
  - [Advanced / debug](#advanced--debug)
- [Use case samples](#use-case-samples)
- [Architecture / config / details](#architecture--config--details)
  - [Daemon-first + fallback](#daemon-first--fallback)
  - [Events (pull-based notifications)](#events-pull-based-notifications)
  - [Dry-run vs --apply](#dry-run-vs---apply)
  - [Config file (server profiles)](#config-file-server-profiles)
  - [Stdin / jq recipes](#stdin--jq-recipes)
- [Protocol support](#protocol-support)
- [Changelog](#changelog)

## Quickstart

```bash
# Smoke test (rust-analyzer must be in PATH)
# If you use the rustup proxy, run this first:
#   rustup component add rust-analyzer
npx @mako10k/lsp-cli --root . ping

# documentSymbol (line/col are 0-based)
npx @mako10k/lsp-cli --root . --format pretty symbols path/to/file.rs
```

### Development (from source)

```bash
npm install
npm run build

# Install the repo locally as a CLI (provides the lsp-cli command)
npm link
lsp-cli --help
```

## Sample (for testing)

A small Rust sample project is included:

- `samples/rust-basic`

Examples:

```bash
# initialize smoke test
npx @mako10k/lsp-cli --root samples/rust-basic ping

# documentSymbol
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty symbols samples/rust-basic/src/math.rs

# references: the call site of add inside main.rs (0-based)
# Example: the "a" position of "add" on line 9 ("    let x = add(1, 2);")
npx @mako10k/lsp-cli --root samples/rust-basic --format json references samples/rust-basic/src/main.rs 8 12

# definition (right after rust-analyzer initialization, results may be empty; --wait is recommended)
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 definition samples/rust-basic/src/main.rs 8 12

# hover
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 hover samples/rust-basic/src/main.rs 8 12

# signature help (somewhere inside add()
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 signature-help samples/rust-basic/src/main.rs 8 16

# workspace symbols
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 ws-symbols add --limit 20

# implementation
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 implementation samples/rust-basic/src/main.rs 8 12

# type definition
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 type-definition samples/rust-basic/src/main.rs 8 12
```

## Notes
- Positions (`line`, `col`) are **0-based** (LSP-compliant).
- With `--server typescript-language-server`, it starts TypeScript Language Server via npx (TypeScript is required in the target workspace):

  ```bash
  npx -y typescript-language-server --stdio
  ```

- Applying changes is dry-run by default; files are modified only when `--apply` is specified.

## Command reference

### Global options

Global options must appear **before** the command for reliable parsing.

- `--root <path>`: workspace root (default: cwd)
- `--server <name>`: server profile name (default: `rust-analyzer`)
- `--server-cmd <cmd>`: override the server command string
- `--config <path>`: config file path (default: `<root>/.lsp-cli.json` or `<root>/lsp-cli.config.json`)
- `--format <json|pretty>`: output format (default: `json`)
- `--stdin`: read command params from stdin as JSON (command-specific)
- `--jq <filter>`: pipe JSON output through `jq` (requires `jq` in PATH)
- `--wait-ms <n>`: wait before some requests (ms; helps rust-analyzer warm-up)
- `--daemon-log <path>`: daemon log sink (auto-start); `discard|default|<path>`

### Command index

Read-only navigation:
- `symbols`, `references`, `definition`, `type-definition`, `implementation`, `hover`, `signature-help`, `ws-symbols`

Edits and refactoring (mutating; dry-run by default):
- `rename`, `code-actions`, `apply-edits`, `delete-symbol`

Formatting and tokens:
- `format`, `format-range`, `completion`, `document-highlight`, `inlay-hints`, `semantic-tokens-full`, `semantic-tokens-range`, `semantic-tokens-delta`, `prepare-rename`

Daemon and operations:
- `daemon-status`, `daemon-stop`, `daemon-log`, `events`, `server-status`, `server-stop`, `server-restart`, `did-change-configuration`

Batch / advanced:
- `batch`, `daemon-request`

### Read-only navigation

Typical arguments are:

- `symbols <file>`
- `references <file> <line> <col>`
- `definition <file> <line> <col>`
- `type-definition <file> <line> <col>`
- `implementation <file> <line> <col>`
- `hover <file> <line> <col>`
- `signature-help <file> <line> <col>`
- `ws-symbols <query> [--limit <n>]`

### Edits and refactoring (mutating)

- `rename <file> <line> <col> <newName>`: defaults to dry-run; add `--apply` to modify files.
- `code-actions <file> ...`: defaults to dry-run; add `--apply` to apply selected action.
- `apply-edits`: reads `WorkspaceEdit` JSON from stdin; add `--apply` to modify files.
- `delete-symbol <file> <symbolName>`: dry-run by default; add `--apply` to modify files.

### Formatting and tokens

- `format <file> [--apply]`
- `format-range <file> <startLine> <startCol> <endLine> <endCol> [--apply]`
- `completion <file> <line> <col>`
- `document-highlight <file> <line> <col>`
- `inlay-hints <file> <startLine> <startCol> <endLine> <endCol>`
- `semantic-tokens-full <file>`
- `semantic-tokens-range <file> <startLine> <startCol> <endLine> <endCol>`
- `semantic-tokens-delta <file>`
- `prepare-rename <file> <line> <col>`
- `did-change-configuration --settings '<json>'` (or `--stdin`)

### Daemon and operations

- `daemon-status`: daemon metadata (pid/startedAt/socketPath)
- `server-status`: whether in-daemon LSP is running
- `server-stop` / `server-restart`: stop/restart only the in-daemon LSP session
- `daemon-stop`: stop the daemon process itself
- `events --kind diagnostics --since <cursor> --limit <n>`: pull-based notifications
- `daemon-log [discard|default|<path>]`: get/set daemon log sink

### Batch mode

`batch` reads JSON Lines (one line = one request) from stdin and executes them sequentially within the same LSP session.

### Advanced / debug

- `daemon-request --method <name> [--params <json>]`: send an arbitrary LSP request via the daemon.

## Daemon mode (persistent)

To reduce repeated execution costs (initialize, etc.) for the same `--root`, the CLI tries to **connect to a daemon by default**. If it cannot connect, it **implicitly starts the daemon** and retries; if it still fails, it falls back to the legacy behavior: **start LSP as a one-shot process**.

There is no explicit `daemon start` command (auto-start only).

## Use case samples

### 1) Pull diagnostics (after edits)

```bash
# run something that triggers diagnostics (e.g. open/format/rename)
npx @mako10k/lsp-cli --root samples/rust-basic symbols samples/rust-basic/src/math.rs > /dev/null

# then pull diagnostics
npx @mako10k/lsp-cli --root samples/rust-basic events --kind diagnostics --since 0
```

### 2) "Navigate" (definition → references)

```bash
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 definition samples/rust-basic/src/main.rs 8 12
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 references samples/rust-basic/src/main.rs 8 12
```

### 3) Safe refactor (dry-run first)

```bash
# preview rename
npx @mako10k/lsp-cli --root samples/rust-basic rename samples/rust-basic/src/main.rs 8 12 new_name

# apply rename
npx @mako10k/lsp-cli --root samples/rust-basic rename --apply samples/rust-basic/src/main.rs 8 12 new_name
```

## Architecture / config / details

### Daemon-first + fallback

By default, many commands try: daemon → auto-start daemon → fallback to direct stdio.

### Events (pull-based notifications)

The daemon stores notifications like `textDocument/publishDiagnostics` and exposes them via `events`.

### Dry-run vs --apply

Commands that can modify files are **dry-run by default**. To actually write files, pass `--apply`.

### Daemon events (pull-based)

The daemon accumulates notifications such as `textDocument/publishDiagnostics`, and you can fetch them via `events`.

```bash
# Fetch diagnostics (raw JSON)
npx @mako10k/lsp-cli --root samples/rust-basic events --kind diagnostics

# Fetch deltas using a cursor (pass the previous cursor via --since)
npx @mako10k/lsp-cli --root samples/rust-basic events --kind diagnostics --since 0
```

### Daemon server control (stop/restart LSP only)

You can stop or restart only the LSP session inside the daemon, without killing the daemon process itself.

```bash
# Check whether the LSP inside the daemon is running
npx @mako10k/lsp-cli --root samples/rust-basic server-status

# Stop only the LSP (daemon stays alive)
npx @mako10k/lsp-cli --root samples/rust-basic server-stop

# Restart LSP (re-run initialize)
npx @mako10k/lsp-cli --root samples/rust-basic server-restart
```

### Daemon stop (stop the daemon process)

```bash
npx @mako10k/lsp-cli --root samples/rust-basic daemon-stop
```

## apply-edits (apply/dry-run WorkspaceEdit)

You can supply a `WorkspaceEdit` from stdin and preview/apply it (reuses the existing WorkspaceEdit application logic).

```bash
# dry-run (preview)
cat workspaceEdit.json | npx @mako10k/lsp-cli apply-edits

# apply (modifies files)
cat workspaceEdit.json | npx @mako10k/lsp-cli apply-edits --apply
```

### Batch mode (JSONL)

Reads JSON Lines from stdin (one line = one request) and executes them sequentially within the same LSP session.

```bash
cat <<'JSONL' | npx @mako10k/lsp-cli --root . --server typescript-language-server --format json batch
{"cmd":"references","file":"src/index.ts","line":0,"col":0}
{"cmd":"definition","file":"src/index.ts","line":0,"col":0}
JSONL
```

To apply edits/refactors, add `batch --apply` (explicit opt-in for safety):

```bash
cat <<'JSONL' | npx @mako10k/lsp-cli --root . --server typescript-language-server --format json batch --apply
{"cmd":"rename","file":"src/index.ts","line":0,"col":0,"newName":"renamed","apply":true}
JSONL
```

### Structured edit (delete symbol)

Deletes a symbol block by name using `documentSymbol` (dry-run example):

```bash
npx @mako10k/lsp-cli --server typescript-language-server --root . --format pretty \
  delete-symbol src/servers/typescriptLanguageServer.ts typescriptLanguageServerProfile
```
- With `--jq '<filter>'`, JSON output is piped through `jq` for formatting/extraction (`jq` must be in PATH).
- For `<file>`, pass `-` to read the file path from stdin.
- With `--stdin`, command input is read as JSON from stdin.

## Protocol support

- See `PROTOCOL_SUPPORT.md` for a feature-by-feature comparison of LSP capabilities vs what `lsp-cli` implements.

## Changelog

- See `CHANGELOG.md`.

### Config file (server profiles)
- By default it searches:
  - `<root>/.lsp-cli.json`
  - `<root>/lsp-cli.config.json`
- You can specify explicitly with `--config <path>` (relative paths are treated as relative to `<root>`).

Example: `.lsp-cli.json`

```json
{
  "servers": {
    "rust-analyzer": {
      "command": "rust-analyzer",
      "args": [],
      "defaultLanguageId": "rust",
      "languageIdByExt": {
        ".rs": "rust"
      },
      "initializationOptions": {
        "cargo": {
          "buildScripts": { "enable": true }
        }
      }
    }
  }
}
```

Usage:

```bash
npx @mako10k/lsp-cli --root samples/rust-basic --config .lsp-cli.json ping
```

### Examples (stdin / jq)

```bash
# Pass a file path via stdin
printf '%s\n' samples/rust-basic/src/math.rs \
  | npx @mako10k/lsp-cli --root samples/rust-basic --jq 'length' symbols -

# Pass references input via JSON stdin
printf '{"file":"samples/rust-basic/src/main.rs","line":8,"col":12}' \
  | npx @mako10k/lsp-cli --root samples/rust-basic --stdin --jq '.[0]' references
```

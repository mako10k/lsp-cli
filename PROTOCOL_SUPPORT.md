# LSP Features and `lsp-cli` Implementation Status (Comparison Table)

This document summarizes representative Language Server Protocol (LSP) features and how they map to the commands/implementations provided by this repository’s CLI (`lsp-cli`).

## Terminology

- **LSP method**: A JSON-RPC method name such as `textDocument/hover`
- **Daemon command**: A `lsp-cli`-specific management API over UDS (JSONL), such as `daemon/status`

## Assumptions of This CLI (Important)

- **Positions are 0-based**: `line` / `col` (`character`) are **zero-indexed**.
- **Mutating operations are dry-run by default**: Commands such as `rename` / `code-actions` / `apply-edits` do not modify files unless `--apply` is explicitly provided.
- **Daemon-first + fallback**: Many commands prefer going through the daemon; if the daemon is not running / not reachable, they fall back to spawning the server over stdio (`withDaemonFallback`).
- **Profile/server selection**: Choose the LSP server using `--server` and `--config` / `--server-cmd`.

---

## Comparison Table (LSP → `lsp-cli`)

Legend:
- ✅ Implemented
- 🟡 Partially / alternative implementation (with caveats)
- ❌ Not implemented (no dedicated command)

| LSP category | LSP method/concept | `lsp-cli` command | Status | Notes |
|---|---|---|---|---|
| Lifecycle | initialize/shutdown | `ping` | ✅ | Runs initialize→shutdown in direct (stdio) mode |
| Daemon | Persistent process (per root) | `daemon` (internal) | ✅ | Expected to be auto-started in normal usage |
| Daemon | Daemon status | `daemon-status` | ✅ | PID/startedAt/socketPath etc. (daemon management API) |
| Daemon | Stop daemon | `daemon-stop` | ✅ | Best-effort wait for socket to disappear after stopping |
| Daemon | Daemon log | `daemon-log` | ✅ | Operates `discard/default/<path>` |
| Server control | Stop LSP | `server-stop` | ✅ | Stops only the LSP while keeping the daemon alive |
| Server control | Restart LSP | `server-restart` | ✅ | Restarts from initialize |
| Server status | Check LSP health | `server-status` | ✅ | Status of the in-daemon LSP instance |
| Events | publishDiagnostics (notification) | `events` | 🟡 | Exposes notifications as pull-based events (daemon-specific) |
| Document symbols | `textDocument/documentSymbol` | `symbols` | ✅ | Daemon-first + fallback |
| Document symbols | `textDocument/documentSymbol` | `symbols-daemon` | ✅ | Daemon-only (marked experimental) |
| References | `textDocument/references` | `references` | ✅ | Daemon-first + fallback |
| References | `textDocument/references` | `references-daemon` | ✅ | Daemon-only |
| Definition | `textDocument/definition` | `definition` | ✅ | Daemon-first + fallback |
| Definition | `textDocument/definition` | `definition-daemon` | ✅ | Daemon-only |
| Type definition | `textDocument/typeDefinition` | `type-definition` | ✅ | Direct (stdio) only (no daemon command provided) |
| Implementation | `textDocument/implementation` | `implementation` | ✅ | Direct (stdio) only (no daemon command provided) |
| Hover | `textDocument/hover` | `hover` | ✅ | Daemon-first + fallback |
| Hover | `textDocument/hover` | `hover-daemon` | ✅ | Daemon-only |
| Signature help | `textDocument/signatureHelp` | `signature-help` | ✅ | Daemon-first + fallback |
| Signature help | `textDocument/signatureHelp` | `signature-help-daemon` | ✅ | Daemon-only |
| Workspace symbols | `workspace/symbol` | `ws-symbols` | ✅ | Daemon-first + fallback |
| Workspace symbols | `workspace/symbol` | `ws-symbols-daemon` | ✅ | Daemon-only |
| Refactor | `textDocument/rename` | `rename` | ✅ | Dry-run by default; apply with `--apply` |
| Refactor | `textDocument/codeAction` | `code-actions` | ✅ | List → select → run edit/command with `--apply` |
| Execute command | `workspace/executeCommand` | `code-actions --apply` (internal) | 🟡 | Used when a code action returns a `command` |
| WorkspaceEdit | Apply `WorkspaceEdit` | `apply-edits` | ✅ | Dry-run/apply a `WorkspaceEdit` from stdin |
| WorkspaceEdit | server→client `workspace/applyEdit` | (internal) | 🟡 | Supported in both daemon/direct modes when `applyEdits=true` (no dedicated CLI command) |
| Batch | Run multiple requests sequentially | `batch` | ✅ | Runs multiple operations like `symbols/hover/...` (implementation-dependent) |
| Debug/advanced | Send arbitrary LSP request | `daemon-request` | ✅ | Invoke an arbitrary method via the daemon |
| Editing helper | Delete symbol (custom) | `delete-symbol` | 🟡 | Derives a range from `documentSymbol` and deletes it as a `WorkspaceEdit` |

---

## Examples of Not Implemented (No Dedicated Command)

Even if the server supports these, the CLI currently has no dedicated command for them (you may still be able to invoke them via `daemon-request`, etc.).

- `textDocument/formatting` / `textDocument/rangeFormatting`
- `textDocument/semanticTokens/*`
- `textDocument/completion` / `textDocument/documentHighlight`
- `textDocument/inlayHint`
- `workspace/didChangeConfiguration`

---

## Additional Notes

- The `*-daemon` commands such as `symbols-daemon` are “daemon-only”, but in normal usage the non-suffixed commands such as `symbols` run daemon-first.
- `implementation` / `type-definition` currently have no daemon-backed commands and run by spawning the server over stdio.


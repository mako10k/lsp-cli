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
- **Client capabilities**: `initialize` advertises a conservative LSP 3.18-oriented baseline for the commands implemented here. Per-profile `clientCapabilities` in config are deep-merged on top for server-specific narrowing.

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
| Events | `textDocument/publishDiagnostics` notification | `events --kind diagnostics` | 🟡 | Exposes notifications as pull-based events (daemon-specific) |
| Events | `window/logMessage` notification | `events --kind log` | ✅ | Pulls daemon-buffered server log messages |
| Events | `window/showMessage` notification | `events --kind message` | ✅ | Pulls daemon-buffered server messages |
| Events | `$/progress` notification | `events --kind progress` | ✅ | Pulls daemon-buffered work progress notifications |
| Document symbols | `textDocument/documentSymbol` | `symbols` | ✅ | Daemon-first + fallback |
| Document symbols | `textDocument/documentSymbol` | `symbols-daemon` | ✅ | Daemon-only (marked experimental) |
| References | `textDocument/references` | `references` | ✅ | Daemon-first + fallback |
| References | `textDocument/references` | `references-daemon` | ✅ | Daemon-only |
| Definition | `textDocument/definition` | `definition` | ✅ | Daemon-first + fallback |
| Definition | `textDocument/definition` | `definition-daemon` | ✅ | Daemon-only |
| Type definition | `textDocument/typeDefinition` | `type-definition` | ✅ | Daemon-first + fallback |
| Implementation | `textDocument/implementation` | `implementation` | ✅ | Daemon-first + fallback |
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
| Formatting | `textDocument/formatting` | `format` | ✅ | Returns edits; apply with `--apply` |
| Formatting | `textDocument/rangeFormatting` | `format-range` | ✅ | Returns edits; apply with `--apply` |
| Completion | `textDocument/completion` | `completion` | ✅ | Returns `CompletionList`/items |
| Highlight | `textDocument/documentHighlight` | `document-highlight` | ✅ | Returns `DocumentHighlight[]` |
| Inlay hints | `textDocument/inlayHint` | `inlay-hints` | ✅ | Returns `InlayHint[]` |
| Semantic tokens | `textDocument/semanticTokens/full` | `semantic-tokens-full` | ✅ | Raw tokens (server-dependent legend) |
| Semantic tokens | `textDocument/semanticTokens/range` | `semantic-tokens-range` | ✅ | Raw tokens |
| Semantic tokens | `textDocument/semanticTokens/full/delta` | `semantic-tokens-delta` | ✅ | Raw delta tokens |
| Workspace | `workspace/didChangeConfiguration` | `did-change-configuration` | ✅ | Sends notification (daemon-first where supported) |
| Text document | `textDocument/didSave` | `did-save` | ✅ | Sends notification; can wait for diagnostics |
| Rename | `textDocument/prepareRename` | `prepare-rename` | ✅ | Returns range/placeholder |

---

## Examples of Not Implemented (No Dedicated Command)

Even if the server supports these, the CLI currently has no dedicated command for them (you may still be able to invoke them via `daemon-request`, etc.).

- `textDocument/codeLens`
- `textDocument/linkedEditingRange`
- `textDocument/selectionRange`
- `textDocument/foldingRange`
- `workspace/willRenameFiles` / `workspace/didRenameFiles`

---

## Additional Notes

- The `*-daemon` commands such as `symbols-daemon` are “daemon-only”, but in normal usage the non-suffixed commands such as `symbols` run daemon-first.
- `implementation` / `type-definition` run daemon-first (and fall back to direct stdio when needed).

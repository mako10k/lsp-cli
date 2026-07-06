# lsp-cli 要件定義

## 1. 目的

`lsp-cli` は、任意の Language Server Protocol (LSP) サーバを CLI から操作し、構造解析、参照探索、整形、リファクタリング、WorkspaceEdit 適用を自動化する軽量クライアントである。主対象は `rust-analyzer` だが、サーバプロファイルにより `typescript-language-server` などへ差し替え可能にする。

## 2. 現行スコープ

- Runtime: Node.js 22 以上、TypeScript。
- LSP transport: stdio JSON-RPC。
- Protocol baseline: LSP 3.18 系を意識した保守的な `initialize` client capabilities。
- Workspace: 単一 `--root`。位置指定は LSP 準拠の 0-based `line` / `col`。
- Execution model: daemon-first。通常コマンドは daemon 接続を試し、必要なら自動起動し、失敗時は直接 stdio 実行へ fallback する。
- Safety: ファイル変更は dry-run 既定。`--apply` 指定時のみ書き込む。

## 3. 実装済み機能

### Core / Navigation

- `ping`: initialize/shutdown 疎通。
- `symbols`, `references`, `definition`, `type-definition`, `implementation`, `hover`, `signature-help`, `ws-symbols`。
- daemon-only 実験コマンド: `symbols-daemon`, `references-daemon`, `definition-daemon`, `hover-daemon`, `signature-help-daemon`, `ws-symbols-daemon`。

### Edits / Refactoring

- `rename`, `code-actions`, `delete-symbol`, `apply-edits`。
- `format`, `format-range`。
- WorkspaceEdit は `changes` と `documentChanges` を扱い、create/rename/delete file operations も適用する。
- `--save-after-apply` と `--wait-diagnostics-ms` により、適用後の `didSave` と diagnostics 収集を明示的に要求できる。

### Language Features

- `completion`, `document-highlight`, `folding-ranges`, `selection-ranges`, `linked-editing-ranges`, `code-lenses`, `diagnostics`, `workspace-diagnostics`, `inlay-hints`。
- `diagnostics` は `textDocument/diagnostic` 未対応時に同一 document の `textDocument/publishDiagnostics` を待つ fallback を行う。
- `semantic-tokens-full`, `semantic-tokens-range`, `semantic-tokens-delta`。
- `prepare-rename`, `did-change-configuration`, `did-save`。

### Daemon / Operations

- `daemon-status`, `daemon-stop`, `daemon-log`。
- `server-status`, `server-stop`, `server-restart`。
- daemon endpoint は root, server name, 明示 `--config`, `--server-cmd` の組み合わせで分離し、異なる server identity の既存 daemon を誤再利用しない。
- `events --kind diagnostics|log|message|progress`: daemon が受け取った `textDocument/publishDiagnostics`, `window/logMessage`, `window/showMessage`, `$/progress` を cursor 付きで pull 取得する。
- daemon event queue は既定で 1000 件をメモリ内保持し、永続化しない。古い cursor の取り逃しは `truncated` / `droppedBeforeCursor` で通知する。
- `daemon-request`: daemon 経由で任意 LSP request を送る。
- `batch`: JSONL 入力を同一 LSP セッション内で逐次実行する。

## 4. 設定要件

設定ファイルは `<root>/.lsp-cli.json` または `<root>/lsp-cli.config.json` を自動探索し、`--config <path>` で明示指定できる。

- `presets`: 再利用可能なサーバ設定。
- `servers`: custom server profile と built-in profile override。
- `augment`: built-in/custom profile に重ねる追加設定。
- per-server fields: `command`, `args`, `initializationOptions`, `languageIdByExt`, `defaultLanguageId`, `cwd`, `env`, `waitMs`, `warmup`, `clientCapabilities`。
- `clientCapabilities` は既定 capability に deep merge し、サーバごとに advertised support を狭める用途で使う。

## 5. アーキテクチャ

- `src/cli.ts`: Commander ベースの CLI entrypoint。
- `src/lsp/LspClient.ts`: LSP process 起動、JSON-RPC connection、document sync、request/notification handling。
- `src/lsp/workspaceEdit.ts`: WorkspaceEdit の preview/apply 共通処理。
- `src/daemon/`: UDS JSONL daemon、イベントキュー、daemon/server 操作。
- `src/servers/`: built-in/custom server profile 解決。
- `src/mock/mockLspServer.ts`: hermetic integration tests 用 mock LSP server。

## 6. 品質・検証要件

- `npm run typecheck`: TypeScript 型検査。
- `npm run build`: `src/` から `dist/` へ compile。
- `npm run test:unit`: build 済み `dist/test/**/*.test.js` を Node test runner で実行。
- `npm test`: build 後に `test:unit` を実行。
- `npm run release:check`: `typecheck`, `build`, `test:unit`, `npm pack --dry-run --json` を順に実行し、npm package に `dist/test/`, `dist/mock/`, `src/`, `scripts/` が混入しないことを確認する。
- `npm run version:bump -- <patch|minor|major|x.y.z>`: git worktree が clean な場合のみ `package.json` / `package-lock.json` の version を更新する。tag は作成しない。
- CI は Node 22 / 24 matrix で `npm ci`, `typecheck`, `build`, `test:unit` を実行する。

## 7. 非スコープ

- エディタ統合。
- multi-root workspace。
- dynamic registration の完全対応。
- `SnippetTextEdit` の apply 対応。未対応のため既定 capability では `snippetEditSupport` を広告しない。
- 任意のサーバ固有 protocol extension の専用 UI。

## 8. Backlog

- 現時点の既知未実装項目はなし。新規候補は実装判断時にここへ追加する。

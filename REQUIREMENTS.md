# LSPクライアント（軽量）要件/方式（たたき台）

## 1. 目的
- 任意のLSPサーバの機能をCLIから呼び出し、**構造解析**（例: symbol/references 取得）や **リファクタリング**（例: rename/codeAction適用）を自動化できる軽量クライアントを作る。
- まずは **rust-analyzer** を対象にMVPを作り、その後 **別言語(LSPサーバ)へ容易に切り替え**できる構成にする。

## 2. スコープ（MVP案）
### 2.1 最初に対応するLSPサーバ
- rust-analyzer（stdio起動）

### 2.2 最初に提供するコマンド（案）
- `lsp-cli ping` : initialize/initialized/shutdown の疎通
- `lsp-cli symbols <file>` : `textDocument/documentSymbol`
- `lsp-cli references <file> <line> <col>` : `textDocument/references`
- `lsp-cli rename <file> <line> <col> <newName>` : `textDocument/rename`（WorkspaceEdit適用）
- `lsp-cli code-actions <file> <range>` : `textDocument/codeAction`（一覧/適用）

※ 出力は `--format json|pretty` で選択できる（デフォルト: json）。

## 3. 非スコープ（当面やらない）
- エディタ統合（VSCode等）
- 常駐デーモン（watchモード）
- 複雑なプロジェクト自動検出（必要最小限に留める）

## 4. 方式（アーキテクチャ）
### 4.1 構成方針
- **LSPコア**（JSON-RPC / メッセージフレーミング / stdio transport / request管理）と、
  **サーバプロファイル**（起動コマンド、initialize options、languageId判定等）を分離する。
- LSPサーバの差し替えは「プロファイル追加」で完結させる（可能な限り）。

### 4.2 LSPコア（共通）
- transport: stdio
- protocol: JSON-RPC 2.0 + LSP framing（`Content-Length`）
- 主要責務:
  - サーバ起動/終了（initialize/initialized/shutdown/exit）
  - request id の採番と response の待ち合わせ
  - `$/progress` 等の通知は捨ててもよい（まずはログ）
  - `workspace/applyEdit` を受け取る/自前で適用する方針は後述

### 4.3 ワークスペース/ファイル管理（共通）
- `--root <path>` を基本にし、未指定なら `cwd` をroot扱い。
- ファイル入力は原則パス、位置指定は (line, col) で受ける（0/1-indexは要統一）。
- `textDocument/didOpen` は必要なファイルのみ送る（MVPはオンデマンド）。

### 4.4 変更適用（WorkspaceEdit）
- リファクタ結果は LSP の `WorkspaceEdit`（主に `changes` / `documentChanges`）を解釈して適用。
- 安全のためデフォルトは `--dry-run`（差分表示/JSON）で、`--apply` 明示時のみ書き込み。

### 4.5 サーバプロファイル（差し替えポイント）
プロファイルが持つ情報（案）:
- `name`（例: `rust-analyzer`）
- 起動コマンド（例: `rust-analyzer` or `rust-analyzer --stdio`）
- `initialize` パラメータ差分
  - `rootUri` / `workspaceFolders`
  - `initializationOptions`（必要なら）
  - `capabilities`（基本は汎用テンプレ）
- languageId 判定（拡張子→languageId。例: `.rs`→`rust`）

## 5. rust-analyzer プロファイル（MVP想定）
- 起動: `rust-analyzer`（stdio）
- ルート: Cargo workspace を想定（ただし root はユーザ指定優先）
- 最小 initialize:
  - `rootUri` or `workspaceFolders`
  - `capabilities.textDocument.rename` 等を有効

## 6. CLI（たたき台）
- `lsp-cli --server rust-analyzer --root . <subcommand> ...`
- サーバ差し替えの基本は `--server` と `--server-cmd`（上書き）で実現
  - 例: `lsp-cli --server rust-analyzer --server-cmd "rust-analyzer" ping`
- パイプ連携のため、入力/出力の補助を持つ
  - 入力: `<file>` に `-` を指定するとstdinからファイルパスを読む
  - 入力: `--stdin` でstdinからJSONを読んでコマンド引数を与える
  - 出力: `--jq '<filter>'` でJSON出力を `jq` に通して抽出/整形できる（`jq` がPATHに必要）

## 7. 合意事項（2026-01-15）
- 実装言語: **Node.js + TypeScript**（LSP/JSON-RPC周りのSDKが充実しているため。例: `vscode-jsonrpc`）
- 出力: `--format json|pretty` で切替
- 位置指定: **LSP準拠の0-based**（CLIヘルプに明記）
- 変更適用: **`--dry-run` デフォルト**（`--apply` 明示時のみ書き込み）
- 対象範囲: **単一root**（`--root`）

## 8. マイルストーン（案）
- M0: `ping` + initialize/shutdown
- M1: `documentSymbol` / `references`（read-only）
- M2: `rename`（WorkspaceEditのdry-run/適用）
- M3: `codeAction` 一覧 + 1件適用
- M4: プロファイル追加で別LSP（例: pyright/gopls）に切替できることを確認

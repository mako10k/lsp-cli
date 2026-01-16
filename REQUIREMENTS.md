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
- 複雑なプロジェクト自動検出（必要最小限に留める）

※ 方針更新: 単発CLIの起動コスト削減と通知(PUSH)の取り回しのため、「常駐デーモン」をスコープに含める。

## 4. 方式（アーキテクチャ）
### 4.1 構成方針
- **LSPコア**（JSON-RPC / メッセージフレーミング / stdio transport / request管理）と、
  **サーバプロファイル**（起動コマンド、initialize options、languageId判定等）を分離する。
- LSPサーバの差し替えは「プロファイル追加」で完結させる（可能な限り）。

### 4.1.1 新アーキテクチャ: daemon(常駐) + client(単発)
- 目的:
  - 毎回の `initialize/initialized` 等のオーバーヘッド削減（同一rootでセッションを再利用）
  - サーバからの通知(PUSH)を「CLIの同期I/Oモデル」に無理に混ぜず、**イベントとして分離**する
- 方式:
  - `lsp-cli daemon` が LSP サーバ（stdio）に接続して常駐する
  - `lsp-cli <command>` は daemon に接続して request/response を行う（既存のCLI I/Fを基本踏襲）
  - daemon は LSP 通知を受け取り、ローカルにキューして **pull型** で取得できるようにする

### 4.2 LSPコア（共通）
- transport: stdio
- protocol: JSON-RPC 2.0 + LSP framing（`Content-Length`）
- 主要責務:
  - サーバ起動/終了（initialize/initialized/shutdown/exit）
  - request id の採番と response の待ち合わせ
  - `workspace/applyEdit` を受け取る/自前で適用する方針は後述

#### 4.2.1 通知(PUSH)の扱い: events として分離
- クライアント側が LSP 通知をリアルタイムに扱う代わりに、daemon が通知を受けて蓄積する。
- CLI は `events` コマンドでイベントを取得する（種類フィルタ付き）。
- 例（対象通知の候補）:
  - `textDocument/publishDiagnostics`（構文エラー等）
  - `window/logMessage` / `window/showMessage`
  - `$/progress`

### 4.3 ワークスペース/ファイル管理（共通）
- `--root <path>` を基本にし、未指定なら `cwd` をroot扱い。
- ファイル入力は原則パス、位置指定は (line, col) で受ける（0/1-indexは要統一）。
- `textDocument/didOpen` は必要なファイルのみ送る（MVPはオンデマンド）。

#### 4.3.1 daemon endpoint の配置（推奨）
- 基本要件: **workspace(root)ごとに独立**し、かつリポジトリを汚さない。
- 推奨配置（デフォルト）:
  - `$XDG_RUNTIME_DIR/lsp-cli/<hash(root)>/sock`（なければ `os.tmpdir()` 配下に同様）
  - `hash(root)` は realpath(root) 等の安定な値から導出する
- オプション配置（必要なら）:
  - `<root>/.lsp-cli/sock`（ただし `/.lsp-cli/` を `.gitignore` で無視する前提）

### 4.4 変更適用（WorkspaceEdit）
- リファクタ結果は LSP の `WorkspaceEdit`（主に `changes` / `documentChanges`）を解釈して適用。
- 安全のためデフォルトは `--dry-run`（差分表示/JSON）で、`--apply` 明示時のみ書き込み。

#### 4.4.1 変更適用コマンド（追加）
- `apply-edits`（仮）: `TextEdit` / `WorkspaceEdit` の適用を明示的に行う。
  - `--apply` 指定時のみ書き換え（デフォルトはdry-runでプレビュー）
  - daemon経由の適用と、単発(従来)の適用の両方を許容

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

### 6.1 追加コマンド案（daemon運用）
- `daemon`:
  - 指定rootの LSP サーバを起動して常駐し、Unix socketで request を受ける
- `events`:
  - daemonが蓄積した通知イベントを取得する
  - 例: `--kind diagnostics|log|progress` のような種類別フィルタ
  - 例: `--since <cursor>` により差分取得（カーソルは単調増加IDを想定）
- `server stop` / `server restart`:
  - daemon内の LSP サーバを停止/再起動する（initializeをやり直す）
  - クライアントから安全にトリガできるようにする

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

## 9. マイルストーン（daemon化）
- D0: `daemon` 起動 + `request` 経由で `initialize` は一度だけ
- D1: `events` で `publishDiagnostics` 等をpull型で取得
- D2: `server restart/stop` を追加
- D3: `apply-edits` を追加（dry-run/適用）

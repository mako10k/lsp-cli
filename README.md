# lsp-cli

任意のLSPサーバをCLIから駆動して、構造解析/リファクタリングを行うための軽量クライアント（MVP: rust-analyzer）。

## Quickstart

```bash
# 疎通（rust-analyzerがPATHに必要）
# rustupプロキシの場合は先に:
#   rustup component add rust-analyzer
npx @mako10k/lsp-cli --root . ping

# documentSymbol（line/colは0-based）
npx @mako10k/lsp-cli --root . --format pretty symbols path/to/file.rs
```

### Development (from source)

```bash
npm install
npm run build

# repo をローカルにCLIとして入れる（lsp-cli コマンドが生える）
npm link
lsp-cli --help
```

## Sample (for testing)

Rustの簡易サンプルを同梱しています:

- `samples/rust-basic`

例:

```bash
# initialize疎通
npx @mako10k/lsp-cli --root samples/rust-basic ping

# documentSymbol
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty symbols samples/rust-basic/src/math.rs

# references: main.rs 内の add 呼び出し位置（0-based）
# 例: 9行目の "add" の a 位置（"    let x = add(1, 2);"）
npx @mako10k/lsp-cli --root samples/rust-basic --format json references samples/rust-basic/src/main.rs 8 12

# definition（rust-analyzerの初期化直後は結果が空になることがあるのでwait推奨）
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 definition samples/rust-basic/src/main.rs 8 12

# hover
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 hover samples/rust-basic/src/main.rs 8 12

# signature help（add( の中あたり）
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 signature-help samples/rust-basic/src/main.rs 8 16

# workspace symbols
npx @mako10k/lsp-cli --root samples/rust-basic --format pretty --wait-ms 500 ws-symbols add --limit 20
```

## Notes
- 位置指定 (line, col) は **0-based**（LSP準拠）です。
- `--server typescript-language-server` を指定すると TypeScript Language Server を npx で起動します（TypeScriptはワークスペース側に必要）:

  ```bash
  npx -y typescript-language-server --stdio
  ```

- 変更適用はデフォルト dry-run で、`--apply` 指定時のみファイルを書き換えます。

## Daemon mode（常駐）

同一 `--root` での繰り返し実行コスト（initialize等）を下げるため、CLIはデフォルトで **daemonへの接続を試みます**。接続できない場合は **暗黙にdaemonを起動**して再接続し、それでも失敗した場合は従来通り **単発でLSPを起動（フォールバック）**します。

明示的な `daemon start` コマンドはありません（自動起動のみ）。

### Daemon events（pull型）

daemonは `textDocument/publishDiagnostics` などの通知を蓄積し、`events` で取得できます。

```bash
# diagnostics を取得（生JSON）
npx @mako10k/lsp-cli --root samples/rust-basic events --kind diagnostics

# cursor を使って差分取得（前回結果の cursor を --since に渡す）
npx @mako10k/lsp-cli --root samples/rust-basic events --kind diagnostics --since 0
```

### Daemon server control（LSPのみ停止/再起動）

daemon自体は落とさず、daemon内のLSPセッションだけを止めたり、initializeからやり直したりできます。

```bash
# daemon内のLSPが動いているか確認
npx @mako10k/lsp-cli --root samples/rust-basic server-status

# LSPだけ停止（daemonは生存）
npx @mako10k/lsp-cli --root samples/rust-basic server-stop

# LSPを再起動（initializeからやり直し）
npx @mako10k/lsp-cli --root samples/rust-basic server-restart
```

### Daemon stop（daemonプロセス停止）

```bash
npx @mako10k/lsp-cli --root samples/rust-basic daemon-stop
```

## apply-edits（WorkspaceEdit適用/ドライラン）

LSPが返した `WorkspaceEdit` を、stdinから与えて dry-run/適用できます（既存のWorkspaceEdit適用ロジックを再利用）。

```bash
# dry-run（内容をプレビュー）
cat workspaceEdit.json | npx @mako10k/lsp-cli apply-edits

# 適用（ファイルを書き換える）
cat workspaceEdit.json | npx @mako10k/lsp-cli apply-edits --apply
```

### Batch mode (JSONL)

stdin から JSON Lines（1行=1リクエスト）を読み、同一LSPセッションで順に実行します。

```bash
cat <<'JSONL' | npx @mako10k/lsp-cli --root . --server typescript-language-server --format json batch
{"cmd":"references","file":"src/index.ts","line":0,"col":0}
{"cmd":"definition","file":"src/index.ts","line":0,"col":0}
JSONL
```

編集/リファクタを適用する場合は `batch --apply` を付けます（安全のため明示指定が必要）:

```bash
cat <<'JSONL' | npx @mako10k/lsp-cli --root . --server typescript-language-server --format json batch --apply
{"cmd":"rename","file":"src/index.ts","line":0,"col":0,"newName":"renamed","apply":true}
JSONL
```

### Structured edit (delete symbol)

`documentSymbol` を使ってシンボル名からブロック単位で削除します（dry-run例）:

```bash
npx @mako10k/lsp-cli --server typescript-language-server --root . --format pretty \
  delete-symbol src/servers/typescriptLanguageServer.ts typescriptLanguageServerProfile
```
- `--jq '<filter>'` を付けるとJSON出力を `jq` に通して整形/抽出できます（`jq` がPATHに必要）。
- `<file>` は `-` を指定すると stdin からファイルパスを読みます。
- `--stdin` を指定すると、stdinからJSONでコマンド入力を受け取ります。

### Config file (server profiles)
- デフォルトで以下を探索します:
  - `<root>/.lsp-cli.json`
  - `<root>/lsp-cli.config.json`
- `--config <path>` で明示指定できます（相対パスは `<root>` からの相対として扱います）。

例: `.lsp-cli.json`

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

使い方:

```bash
npx @mako10k/lsp-cli --root samples/rust-basic --config .lsp-cli.json ping
```

### Examples (stdin / jq)

```bash
# stdinでfileパスを渡す
printf '%s\n' samples/rust-basic/src/math.rs \
  | npx @mako10k/lsp-cli --root samples/rust-basic --jq 'length' symbols -

# JSON stdinでreferences入力を渡す
printf '{"file":"samples/rust-basic/src/main.rs","line":8,"col":12}' \
  | npx @mako10k/lsp-cli --root samples/rust-basic --stdin --jq '.[0]' references
```

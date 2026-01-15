# lsp-cli

任意のLSPサーバをCLIから駆動して、構造解析/リファクタリングを行うための軽量クライアント（MVP: rust-analyzer）。

## Quickstart

```bash
npm install
npm run build

# repo をローカルにCLIとして入れる（lsp-cli コマンドが生える）
npm link

# 疎通（rust-analyzerがPATHに必要）
# rustupプロキシの場合は先に:
#   rustup component add rust-analyzer
lsp-cli --root . ping

# documentSymbol（line/colは0-based）
lsp-cli --root . --format pretty symbols path/to/file.rs
```

### (planned) npx

公開後は以下で動かす想定です:

```bash
npx @mako10k/lsp-cli --root . ping
```

## Sample (for testing)

Rustの簡易サンプルを同梱しています:

- `samples/rust-basic`

例:

```bash
# initialize疎通
node dist/cli.js --root samples/rust-basic ping

# documentSymbol
node dist/cli.js --root samples/rust-basic --format pretty symbols samples/rust-basic/src/math.rs

# references: main.rs 内の add 呼び出し位置（0-based）
# 例: 9行目の "add" の a 位置（"    let x = add(1, 2);"）
node dist/cli.js --root samples/rust-basic --format json references samples/rust-basic/src/main.rs 8 12

# definition（rust-analyzerの初期化直後は結果が空になることがあるのでwait推奨）
node dist/cli.js --root samples/rust-basic --format pretty --wait-ms 500 definition samples/rust-basic/src/main.rs 8 12

# hover
node dist/cli.js --root samples/rust-basic --format pretty --wait-ms 500 hover samples/rust-basic/src/main.rs 8 12

# signature help（add( の中あたり）
node dist/cli.js --root samples/rust-basic --format pretty --wait-ms 500 signature-help samples/rust-basic/src/main.rs 8 16

# workspace symbols
node dist/cli.js --root samples/rust-basic --format pretty --wait-ms 500 ws-symbols add --limit 20
```

## Notes
- 位置指定 (line, col) は **0-based**（LSP準拠）です。
- `--server typescript-language-server` を指定すると TypeScript Language Server を npx で起動します（TypeScriptはワークスペース側に必要）:

  ```bash
  npx -y typescript-language-server --stdio
  ```
- 変更適用はデフォルト `--dry-run` で、`--apply` 指定時のみファイルを書き換えます。
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
node dist/cli.js --root samples/rust-basic --config .lsp-cli.json ping
```

### Examples (stdin / jq)

```bash
# stdinでfileパスを渡す
printf '%s\n' samples/rust-basic/src/math.rs \
  | node dist/cli.js --root samples/rust-basic --jq 'length' symbols -

# JSON stdinでreferences入力を渡す
printf '{"file":"samples/rust-basic/src/main.rs","line":8,"col":12}' \
  | node dist/cli.js --root samples/rust-basic --stdin --jq '.[0]' references
```

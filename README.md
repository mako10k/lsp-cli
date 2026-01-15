# lsp-cli

任意のLSPサーバをCLIから駆動して、構造解析/リファクタリングを行うための軽量クライアント（MVP: rust-analyzer）。

## Quickstart

```bash
npm install
npm run build

# 疎通（rust-analyzerがPATHに必要）
# rustupプロキシの場合は先に:
#   rustup component add rust-analyzer
node dist/cli.js ping --root .

# documentSymbol（line/colは0-based）
node dist/cli.js symbols path/to/file.rs --root . --format pretty
```

## Sample (for testing)

Rustの簡易サンプルを同梱しています:

- `samples/rust-basic`

例:

```bash
# initialize疎通
node dist/cli.js ping --root samples/rust-basic

# documentSymbol
node dist/cli.js symbols samples/rust-basic/src/math.rs --root samples/rust-basic --format pretty

# references: main.rs 内の add 呼び出し位置（0-based）
# 例: 9行目の "add" の a 位置（"    let x = add(1, 2);"）
node dist/cli.js references samples/rust-basic/src/main.rs 8 12 --root samples/rust-basic --format json
```

## Notes
- 位置指定 (line, col) は **0-based**（LSP準拠）です。
- 変更適用はデフォルト `--dry-run` で、`--apply` 指定時のみファイルを書き換えます。
- `--jq '<filter>'` を付けるとJSON出力を `jq` に通して整形/抽出できます（`jq` がPATHに必要）。
- `<file>` は `-` を指定すると stdin からファイルパスを読みます。
- `--stdin` を指定すると、stdinからJSONでコマンド入力を受け取ります。

### Examples (stdin / jq)

```bash
# stdinでfileパスを渡す
printf '%s\n' samples/rust-basic/src/math.rs | node dist/cli.js symbols - --root samples/rust-basic --jq 'length'

# JSON stdinでreferences入力を渡す
printf '{"file":"samples/rust-basic/src/main.rs","line":8,"col":12}' \
  | node dist/cli.js references --stdin --root samples/rust-basic --jq '.[0]'
```

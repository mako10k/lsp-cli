# lsp-cli

任意のLSPサーバをCLIから駆動して、構造解析/リファクタリングを行うための軽量クライアント（MVP: rust-analyzer）。

## Quickstart

```bash
npm install
npm run build

# 疎通（rust-analyzerがPATHに必要）
# rustupプロキシの場合は先に:
#   rustup component add rust-analyzer
node dist/cli.js --root . ping

# documentSymbol（line/colは0-based）
node dist/cli.js --root . --format pretty symbols path/to/file.rs
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
printf '%s\n' samples/rust-basic/src/math.rs \
  | node dist/cli.js --root samples/rust-basic --jq 'length' symbols -

# JSON stdinでreferences入力を渡す
printf '{"file":"samples/rust-basic/src/main.rs","line":8,"col":12}' \
  | node dist/cli.js --root samples/rust-basic --stdin --jq '.[0]' references
```

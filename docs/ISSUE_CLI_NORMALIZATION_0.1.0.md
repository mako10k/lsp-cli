# Issue draft: CLI/Docs/Help normalization (0.1.0)

Title:
- 正常化方針: CLI/README/Help Hub/daemon サブコマンド体系の一貫性整理（0.1.0向け）

## 背景
`lsp-cli` はここまでに以下の整備が進んだ一方で、機能追加に伴う表記ゆれ・導線不足が目立ち始めている。

- Help Hub の導入（`lsp-cli help toc|commands|examples|<command>`）
- daemon / events（常駐実行 + pull-based notifications）
- 変更系コマンドは dry-run がデフォルト（`--apply` で適用）
- `typescript-language-server` を使った統合テスト追加
- 0.1.0 リリース準備
- 直近の改善: `--version` 追加、pretty出力の改善、help examples に設定ファイルガイド追加

## 問題
現状、次のような不整合/見えづらさがある。

- README の Command index に `ping` が載っていない（実装/Help hubには存在）
- `*-daemon`（daemon-only / experimental）系コマンドが README / Help hub から見つけにくい（`PROTOCOL_SUPPORT.md` にはある）
- 変更系の説明文で `--dry-run` といった存在しないオプション表現が紛れる可能性（本来は "dry-run by default"）
- daemon 関連が「daemon管理」「daemon内LSP制御」「daemon-onlyリクエスト」の3層だが、分類/導線が十分に吸収できていない

## 目的
- 0.1.0 に向けて、CLI/README/Helpの一貫性を高め、学習コストを下げる
- dry-run / apply の方針を軸に、文言と導線を統一する
- README / Help hub / `--help` が齟齬なく、検索可能で、取りこぼしがない状態にする

## スコープ
### 含む
- README/Help hub/CLI help 出力の正常化（表記ゆれ解消、索引整備、分類整理）
- コマンド一覧の網羅性チェック（欠落/命名ブレ/カテゴリずれ）
- 変更系コマンド（rename/code-actions/apply-edits/delete-symbol/format等）の dry-run / apply 規約の明確化
- daemon 系コマンドの情報設計見直し（カテゴリ/命名/導線）

### 含まない
- 新規LSP機能の大幅追加
- CLIの破壊的変更（コマンド名変更や必須引数変更など）
- daemon内部アーキ刷新

## 具体的タスク
- README
  - Command index を `src/cli.ts` と突合し、欠落（例: `ping`）を補完
  - `*-daemon` の扱いを明確化（experimental/daemon-onlyとして列挙、通常は非サフィックス推奨と注記）
  - dry-run default 方針の説明を集約し、重複/矛盾を削る
- Help hub (`help toc/commands/examples`)
  - 「config/daemon/events」へ辿れる導線を点検・整理
  - 必要なら `help commands` に experimental (daemon-only) を追加
- CLI per-command help
  - 変更系の説明文を統一: "dry-run by default; pass `--apply` to modify files"
  - `rename` などに混入している `--dry-run` の表現を排除
- チェックリスト化
  - README / Help hub / `--help` の三点突合の観点を明文化

## 受け入れ条件
- `npm test` が green
- README の Command index が現行CLIと一致し、`ping` を含む主要コマンドが欠落しない
- dry-run と `--apply` の規約が README/Help/コマンドhelpで矛盾しない
- daemon関連コマンドが "隠れていない"（一覧・カテゴリ・説明で辿れる）

## 追加メモ
- 0.1.0 の品質として「最初の印象（わかりやすさ）」を優先
- 破壊的変更は避ける（必要なら将来のdeprecate方針を別途）

## 最新状況（このIssueでやる/やったことのメモ）
- READMEのCommand indexに `ping` と `*-daemon` (experimental) の露出を追加
- `lsp-cli help commands` に `Experimental (daemon-only)` の一覧を追加
- `rename` の説明文を `default: dry-run` に統一し、`--dry-run` という表現（およびオプション）を排除

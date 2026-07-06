# Repository Guidelines

## Project Structure & Module Organization

This is a Node.js/TypeScript CLI for driving LSP servers. The Commander entrypoint is `src/cli.ts`. LSP transport lives in `src/lsp/`, daemon code in `src/daemon/`, server profiles in `src/servers/`, utilities in `src/util/`, and the mock server in `src/mock/`. Tests are in `src/test/*.test.ts`; `samples/rust-basic/` is the Rust fixture. Do not edit `dist/`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run build`: compile TypeScript from `src/` into `dist/`.
- `npm run typecheck`: run TypeScript checks without emitting files.
- `npm test`: build, then run `node --test dist/test/**/*.test.js`.
- `npm run start -- --help`: run the built CLI.
- `node dist/cli.js --root samples/rust-basic ping`: smoke test the CLI.

## Coding Style & Naming Conventions

Use strict TypeScript targeting ES2020/CommonJS. Match existing style: two-space indentation, double quotes, semicolons, `camelCase` values, and `PascalCase` types/classes. Keep command parsing in `src/cli.ts` aligned with existing helpers. CLI positions are 0-based; put global options before subcommands in examples.

## Workflow & Review Rules

For substantive implementation, prefer an issue-backed flow: confirm or create the GitHub issue, implement, verify, review, commit, then update/close the issue. Documentation-only or time-boxed work may use a lighter path. Before non-WIP commits, run `codex review --uncommitted` when available. For bugs, fix the root cause, not just the symptom.

For GPT-5.5/Codex work, use outcome-first guidance instead of long step-by-step scripts. Before coding, make the requested outcome, acceptance criteria, allowed side effects, validation commands, and stop/ask conditions explicit. Do not optimize this guide for an old fixed word-count target; optimize it for stable, actionable repository context. Keep `AGENTS.md` concise enough to scan, but include durable rules that prevent repeated mistakes. If review, release, or incident procedures grow beyond a short checklist, move them to a separate Markdown file and reference it here.

## Testing Guidelines

Tests use Node's built-in `node:test` and `node:assert/strict`. Name tests by feature area, for example `cli.renameDaemon.test.ts` or `daemon.events.diagnostics.test.ts`. Prefer temporary directories and the mock server. When changing LSP behavior, update source and tests, then run `npm test`. For narrow documentation-only changes, a read-through and `git diff --check` are usually enough.

## Commit & Pull Request Guidelines

Recent history uses short, conventional-style subjects such as `feat: ...`, `chore: ...`, `docs: ...`, and `doc/cli: ...`. Keep commits focused and user-visible. Pull requests should include a summary, linked issue when applicable, tests run, and CLI output examples when help text or formatted output changes.

## Remote Git & GitHub Operations

Use `secdat exec gh ...` and `secdat exec git ...` for all remote GitHub or git operations. Do not rely on the active `gh` account or default credential helper. Examples: `secdat exec gh issue view 123`, `secdat exec git push origin <branch>`. For multi-line comments, use `gh ... --body-file FILE` through `secdat exec`.

## Security & Configuration Tips

Do not commit local `.lsp-cli.json`, daemon logs, `node_modules/`, `dist/`, or sample Rust `target/` output. Mutating commands are dry-run by default; require explicit `--apply` when writes are intended.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCli } from "./helpers";

async function canRunTsls(root: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (process.env.LSP_CLI_SKIP_TSLS === "1") return { ok: false, reason: "LSP_CLI_SKIP_TSLS=1" };

  // typescript-language-server requires a TypeScript installation available from the workspace.
  // Provide it by symlinking the repo's devDependency into the temp workspace.
  try {
    const tsserver = require.resolve("typescript/lib/tsserver.js");
    if (!tsserver) return { ok: false, reason: "TypeScript not installed" };
  } catch {
    return { ok: false, reason: "TypeScript not installed" };
  }

  try {
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.symlink(path.join(process.cwd(), "node_modules", "typescript"), path.join(root, "node_modules", "typescript"), "dir");
  } catch (e) {
    // Best-effort: if symlink fails (e.g. permissions), let the test attempt and fail with a clear message.
    return { ok: false, reason: `failed to link typescript into workspace: ${String((e as any)?.message ?? e)}` };
  }

  return { ok: true };
}

test(
  "cli format works with typescript-language-server (dry-run and apply)",
  { timeout: 30_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-cli-tsls-format-"));
    const file = path.join(root, "a.ts");

    await fs.writeFile(file, "const   x=1\n", "utf8");

    // Minimal TS project so tsserver is enabled.
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "tmp", private: true, version: "0.0.0" }, null, 2),
      "utf8"
    );
    await fs.writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }, null, 2),
      "utf8"
    );

    const envCheck = await canRunTsls(root);
    if (!envCheck.ok) {
      test.skip(`typescript-language-server prereq missing: ${envCheck.reason}`);
    }

    // Dry-run
    {
      const res = await runCli(
        ["--root", root, "--server", "typescript-language-server", "--format", "json", "format", file],
        { timeoutMs: 20_000 }
      );
      if (res.code !== 0 && /Could not find a valid TypeScript installation/i.test(res.stderr + res.stdout)) {
        test.skip(`typescript-language-server could not find TypeScript: ${res.stderr || res.stdout}`);
      }

      assert.equal(res.code, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.ok(out);
      assert.ok(out.changes);

      const unchanged = await fs.readFile(file, "utf8");
      assert.equal(unchanged, "const   x=1\n");
    }

    // Apply
    {
      const res = await runCli(
        ["--root", root, "--server", "typescript-language-server", "--format", "json", "format", file, "--apply"],
        { timeoutMs: 20_000 }
      );
      if (res.code !== 0 && /Could not find a valid TypeScript installation/i.test(res.stderr + res.stdout)) {
        test.skip(`typescript-language-server could not find TypeScript: ${res.stderr || res.stdout}`);
      }

      assert.equal(res.code, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.equal(out.applied, true);

      const after = await fs.readFile(file, "utf8");
      // Exact formatting may vary by TS version, but it should at least normalize spacing.
      assert.ok(after.includes("const x = 1"), after);
    }

    // format-range (dry-run + apply)
    {
      await fs.writeFile(file, "const   y=2\n", "utf8");

      // Dry-run
      {
        const res = await runCli(
          [
            "--root",
            root,
            "--server",
            "typescript-language-server",
            "--format",
            "json",
            "format-range",
            file,
            "0",
            "0",
            "0",
            "100"
          ],
          { timeoutMs: 20_000 }
        );
        if (res.code !== 0 && /Could not find a valid TypeScript installation/i.test(res.stderr + res.stdout)) {
          test.skip(`typescript-language-server could not find TypeScript: ${res.stderr || res.stdout}`);
        }

        assert.equal(res.code, 0, res.stderr);
        const out = JSON.parse(res.stdout);
        assert.ok(out);
        assert.ok(out.changes);

        const unchanged = await fs.readFile(file, "utf8");
        assert.equal(unchanged, "const   y=2\n");
      }

      // Apply
      {
        const res = await runCli(
          [
            "--root",
            root,
            "--server",
            "typescript-language-server",
            "--format",
            "json",
            "format-range",
            file,
            "0",
            "0",
            "0",
            "100",
            "--apply"
          ],
          { timeoutMs: 20_000 }
        );
        if (res.code !== 0 && /Could not find a valid TypeScript installation/i.test(res.stderr + res.stdout)) {
          test.skip(`typescript-language-server could not find TypeScript: ${res.stderr || res.stdout}`);
        }

        assert.equal(res.code, 0, res.stderr);
        const out = JSON.parse(res.stdout);
        assert.equal(out.applied, true);

        const after = await fs.readFile(file, "utf8");
        assert.ok(after.includes("const y = 2"), after);
      }
    }
  }
);

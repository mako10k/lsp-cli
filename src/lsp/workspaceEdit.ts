import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

type Position = { line: number; character: number };

type TextEdit = {
  range: { start: Position; end: Position };
  newText: string;
};

type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<
    | { textDocument: { uri: string; version?: number | null }; edits: TextEdit[] }
    | { kind: string }
  >;
};

export function formatWorkspaceEditPretty(edit: WorkspaceEdit): string {
  const perFile = collectEdits(edit);
  const lines: string[] = [];
  for (const [uri, edits] of perFile.entries()) {
    lines.push(`${uri} (${edits.length} edits)`);
    for (const e of edits) {
      lines.push(
        `  [${e.range.start.line}:${e.range.start.character} -> ${e.range.end.line}:${e.range.end.character}] ${JSON.stringify(
          e.newText
        )}`
      );
    }
  }
  return lines.join("\n");
}

export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<void> {
  const perFile = collectEdits(edit);
  for (const [uri, edits] of perFile.entries()) {
    const filePath = fileURLToPath(uri);
    const before = await fs.readFile(filePath, "utf8");
    const after = applyTextEdits(before, edits);
    await fs.writeFile(filePath, after, "utf8");
  }
}

function collectEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
  const out = new Map<string, TextEdit[]>();

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      out.set(uri, [...(out.get(uri) ?? []), ...edits]);
    }
  }

  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if ((dc as any).edits && (dc as any).textDocument?.uri) {
        const uri = (dc as any).textDocument.uri as string;
        const edits = (dc as any).edits as TextEdit[];
        out.set(uri, [...(out.get(uri) ?? []), ...edits]);
      }
    }
  }

  return out;
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  // Apply from bottom to top to keep offsets stable.
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });

  let cur = text;
  for (const e of sorted) {
    const start = offsetFromPosition(cur, e.range.start);
    const end = offsetFromPosition(cur, e.range.end);
    cur = cur.slice(0, start) + e.newText + cur.slice(end);
  }
  return cur;
}

function offsetFromPosition(text: string, pos: Position): number {
  // 0-based line/character; character is UTF-16 code unit in LSP, but for MVP we treat it as JS string index.
  // rust-analyzer typically uses UTF-16 as well; this can be refined later.
  let line = 0;
  let idx = 0;
  while (line < pos.line && idx < text.length) {
    const nl = text.indexOf("\n", idx);
    if (nl === -1) return text.length;
    idx = nl + 1;
    line++;
  }
  return Math.min(idx + pos.character, text.length);
}

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type Position = { line: number; character: number };

type TextEdit = {
  range: { start: Position; end: Position };
  newText: string;
};

type AnnotatedTextEdit = TextEdit & { annotationId?: string };

type TextDocumentEdit = {
  textDocument: { uri: string; version?: number | null };
  edits: Array<TextEdit | AnnotatedTextEdit>;
};

type CreateFile = {
  kind: "create";
  uri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
};

type RenameFile = {
  kind: "rename";
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
};

type DeleteFile = {
  kind: "delete";
  uri: string;
  options?: { recursive?: boolean; ignoreIfNotExists?: boolean };
};

type WorkspaceEdit = {
  changes?: Record<string, TextEdit[]>;
  documentChanges?: Array<TextDocumentEdit | CreateFile | RenameFile | DeleteFile | { kind: string }>;
};

export function formatWorkspaceEditPretty(edit: WorkspaceEdit): string {
  const perFile = collectEdits(edit);
  const lines: string[] = [];

  const uriToDisplay = (uri: string): string => {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  };

  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if ((dc as any)?.kind === "create" && typeof (dc as any)?.uri === "string") {
        lines.push(`create ${uriToDisplay((dc as any).uri)}`);
      } else if ((dc as any)?.kind === "rename" && typeof (dc as any)?.oldUri === "string" && typeof (dc as any)?.newUri === "string") {
        lines.push(`rename ${uriToDisplay((dc as any).oldUri)} -> ${uriToDisplay((dc as any).newUri)}`);
      } else if ((dc as any)?.kind === "delete" && typeof (dc as any)?.uri === "string") {
        lines.push(`delete ${uriToDisplay((dc as any).uri)}`);
      }
    }
  }

  for (const [uri, edits] of perFile.entries()) {
    lines.push(`${uriToDisplay(uri)} (${edits.length} edits)`);
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
  // Prefer ordered documentChanges (may include file ops).
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (isTextDocumentEdit(dc)) {
        await applyTextDocumentEdits(dc.textDocument.uri, dc.edits);
        continue;
      }

      if (isCreateFile(dc)) {
        await applyCreateFile(dc);
        continue;
      }

      if (isRenameFile(dc)) {
        await applyRenameFile(dc);
        continue;
      }

      if (isDeleteFile(dc)) {
        await applyDeleteFile(dc);
        continue;
      }

      if ((dc as any)?.kind) {
        throw new Error(`unsupported WorkspaceEdit.documentChanges kind: ${(dc as any).kind}`);
      }

      throw new Error("unsupported WorkspaceEdit.documentChanges entry");
    }
  }

  // Also apply plain `changes` (unordered) if present.
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      await applyTextDocumentEdits(uri, edits);
    }
  }
}

function isTextDocumentEdit(x: any): x is TextDocumentEdit {
  return !!(x && x.textDocument?.uri && Array.isArray(x.edits));
}

function isCreateFile(x: any): x is CreateFile {
  return x?.kind === "create" && typeof x?.uri === "string";
}

function isRenameFile(x: any): x is RenameFile {
  return x?.kind === "rename" && typeof x?.oldUri === "string" && typeof x?.newUri === "string";
}

function isDeleteFile(x: any): x is DeleteFile {
  return x?.kind === "delete" && typeof x?.uri === "string";
}

async function applyTextDocumentEdits(uri: string, edits: Array<TextEdit | AnnotatedTextEdit>): Promise<void> {
  const filePath = fileURLToPath(uri);
  const before = await fs.readFile(filePath, "utf8");
  const normalized = normalizeTextEdits(edits);
  const after = applyTextEdits(before, normalized);
  await fs.writeFile(filePath, after, "utf8");
}

function normalizeTextEdits(edits: Array<TextEdit | AnnotatedTextEdit>): TextEdit[] {
  return edits.map((e) => ({ range: e.range, newText: e.newText }));
}

async function applyCreateFile(op: CreateFile): Promise<void> {
  const filePath = fileURLToPath(op.uri);
  const overwrite = !!op.options?.overwrite;
  const ignoreIfExists = !!op.options?.ignoreIfExists;

  const exists = await pathExists(filePath);
  if (exists) {
    if (ignoreIfExists) return;
    if (!overwrite) throw new Error(`create failed: file exists: ${filePath}`);
  } else {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  await fs.writeFile(filePath, "", "utf8");
}

async function applyRenameFile(op: RenameFile): Promise<void> {
  const oldPath = fileURLToPath(op.oldUri);
  const newPath = fileURLToPath(op.newUri);

  const overwrite = !!op.options?.overwrite;
  const ignoreIfExists = !!op.options?.ignoreIfExists;

  if (!(await pathExists(oldPath))) throw new Error(`rename failed: source does not exist: ${oldPath}`);

  if (await pathExists(newPath)) {
    if (ignoreIfExists) return;
    if (!overwrite) throw new Error(`rename failed: destination exists: ${newPath}`);
    await fs.rm(newPath, { recursive: true, force: true });
  }

  await fs.mkdir(path.dirname(newPath), { recursive: true });
  await fs.rename(oldPath, newPath);
}

async function applyDeleteFile(op: DeleteFile): Promise<void> {
  const filePath = fileURLToPath(op.uri);
  const recursive = !!op.options?.recursive;
  const ignoreIfNotExists = !!op.options?.ignoreIfNotExists;

  const exists = await pathExists(filePath);
  if (!exists) {
    if (ignoreIfNotExists) return;
    throw new Error(`delete failed: path does not exist: ${filePath}`);
  }

  if (recursive) {
    await fs.rm(filePath, { recursive: true, force: true });
    return;
  }

  await fs.unlink(filePath);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
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
        const edits = normalizeTextEdits((dc as any).edits as Array<TextEdit | AnnotatedTextEdit>);
        out.set(uri, [...(out.get(uri) ?? []), ...edits]);
      }
    }
  }

  return out;
}

function applyTextEdits(text: string, edits: TextEdit[]): string {
  const computed = edits.map((e) => {
    const start = offsetFromPositionStrict(text, e.range.start);
    const end = offsetFromPositionStrict(text, e.range.end);
    if (end < start) throw new Error("invalid edit range: end < start");
    return { start, end, edit: e };
  });

  // Detect overlap on original text.
  const asc = [...computed].sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  for (let i = 1; i < asc.length; i++) {
    if (asc[i - 1].end > asc[i].start) {
      throw new Error("overlapping TextEdits are not supported (conflict detected)");
    }
  }

  // Apply from bottom to top to keep offsets stable.
  const desc = [...computed].sort((a, b) => (a.start !== b.start ? b.start - a.start : b.end - a.end));
  let cur = text;
  for (const c of desc) {
    cur = cur.slice(0, c.start) + c.edit.newText + cur.slice(c.end);
  }
  return cur;
}

function offsetFromPositionStrict(text: string, pos: Position): number {
  if (pos.line < 0 || pos.character < 0) throw new Error("invalid position: negative");

  let line = 0;
  let lineStart = 0;

  while (line < pos.line) {
    const nl = text.indexOf("\n", lineStart);
    if (nl === -1) throw new Error(`position line out of range: ${pos.line}`);
    lineStart = nl + 1;
    line++;
  }

  const rawLineEnd = text.indexOf("\n", lineStart);
  const rawEnd = rawLineEnd === -1 ? text.length : rawLineEnd;
  const lineEnd = rawEnd > lineStart && text[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
  const lineLen = lineEnd - lineStart;

  if (pos.character > lineLen) {
    throw new Error(`position character out of range: line=${pos.line} character=${pos.character} (lineLen=${lineLen})`);
  }

  // LSP character offsets are UTF-16 code units; JS string indices are also UTF-16 code units.
  return lineStart + pos.character;
}

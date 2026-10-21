import type { ReviewComment } from '@hive/core';

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffFileView {
  path: string;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

/** Splits a unified git patch into files and numbered lines, so lines can carry comments. */
export function parsePatch(patch: string): DiffFileView[] {
  const files: DiffFileView[] = [];
  let file: DiffFileView | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      // "diff --git a/x b/y": the b/ side is the file as it is now.
      const target = / b\/(.+)$/.exec(line)?.[1] ?? line.slice(11);
      file = { path: target, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('Binary files'))
        file.lines.push({ kind: 'meta', text: 'Arquivo binário', oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ });
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'ctx', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    } else if (line.startsWith('\\')) {
      file.lines.push({ kind: 'meta', text: line.slice(2), oldLine: null, newLine: null });
    }
  }
  return files;
}

/** Where a comment on this line is anchored: the new file, or the old one for a removed line. */
export function anchorOf(path: string, line: DiffLine): Omit<ReviewComment, 'body'> | null {
  if (line.kind === 'add' || line.kind === 'ctx')
    return { path, line: line.newLine!, side: 'new', code: line.text };
  if (line.kind === 'del') return { path, line: line.oldLine!, side: 'old', code: line.text };
  return null;
}

export const anchorKey = (anchor: Pick<ReviewComment, 'path' | 'line' | 'side'>) =>
  `${anchor.path}:${anchor.side}:${anchor.line}`;

/**
 * Unsent review notes, per task result. They survive closing the diff and are dropped once
 * sent, or when the agent delivers a new result (a different commit).
 */
const drafts = new Map<string, { comments: ReviewComment[]; note: string }>();

export const draftKey = (taskId: string, commit: string | null | undefined) =>
  `${taskId}@${commit ?? ''}`;

export function loadDraft(key: string) {
  return drafts.get(key) ?? { comments: [], note: '' };
}

export function saveDraft(key: string, draft: { comments: ReviewComment[]; note: string }) {
  if (!draft.comments.length && !draft.note.trim()) drafts.delete(key);
  else drafts.set(key, draft);
}

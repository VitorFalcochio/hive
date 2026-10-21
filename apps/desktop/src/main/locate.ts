import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ElementHint, LocateCandidate } from '@hive/core';
import { resolveInside, toPosixRelative } from '@hive/shared';
import { git } from '@hive/workspace';

/** Files where markup is written; styles alone rarely identify one element. */
const MARKUP_GLOBS = [
  '*.tsx',
  '*.jsx',
  '*.ts',
  '*.js',
  '*.vue',
  '*.svelte',
  '*.html',
  '*.htm',
  '*.astro',
  '*.mdx',
];
const MAX_CANDIDATES = 5;
const MAX_TEXT_NEEDLE = 60;

interface Needle {
  text: string;
  weight: number;
}

/**
 * Guesses which project file (and line) renders an element of the Live Preview. A location a
 * dev build reported wins; otherwise the element's id, text and classes are searched with
 * `git grep`, and files matching more of them rank higher.
 */
export async function locateElement(root: string, hint: ElementHint): Promise<LocateCandidate[]> {
  const found = new Map<string, LocateCandidate>();
  const reported = hint.source ? await projectPath(root, hint.source.file) : null;
  if (reported)
    found.set(reported, {
      path: reported,
      line: hint.source?.line ?? null,
      score: 1_000,
      reason: 'framework',
    });

  const results = await Promise.all(
    needlesOf(hint).map(async (needle) => ({ needle, hits: await grep(root, needle.text) })),
  );
  // Per file: each needle counts once, and the line of the strongest needle is the one shown.
  const best = new Map<string, { score: number; line: number; weight: number }>();
  for (const { needle, hits } of results) {
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.path)) continue;
      seen.add(hit.path);
      const current = best.get(hit.path) ?? { score: 0, line: hit.line, weight: 0 };
      current.score += needle.weight;
      if (needle.weight > current.weight) {
        current.weight = needle.weight;
        current.line = hit.line;
      }
      best.set(hit.path, current);
    }
  }
  for (const [file, entry] of best) {
    const existing = found.get(file);
    if (existing) existing.score += entry.score;
    else found.set(file, { path: file, line: entry.line, score: entry.score, reason: 'match' });
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_CANDIDATES);
}

export function needlesOf(hint: ElementHint): Needle[] {
  const needles: Needle[] = [];
  if (hint.id && hint.id.length >= 2) needles.push({ text: hint.id, weight: 6 });
  const text = hint.text.replace(/\s+/g, ' ').trim();
  // Long text is usually a container's children joined together, which no file contains.
  if (text.length >= 3 && text.length <= 120)
    needles.push({ text: text.slice(0, MAX_TEXT_NEEDLE).trim(), weight: 5 });
  const classes = [...new Set(hint.classes)].filter((name) => name.length >= 3);
  if (classes.length >= 2) needles.push({ text: classes.join(' '), weight: 4 });
  for (const name of classes.slice(0, 6)) needles.push({ text: name, weight: 1 });
  return needles;
}

async function grep(root: string, needle: string): Promise<{ path: string; line: number }[]> {
  const result = await git(
    root,
    [
      'grep',
      '-n',
      '-I',
      '-F',
      '--null',
      '--untracked',
      '--exclude-standard',
      '-e',
      needle,
      '--',
      ...MARKUP_GLOBS,
    ],
    { allowFailure: true, timeoutMs: 15_000 },
  );
  if (result.code !== 0) return [];
  const hits: { path: string; line: number }[] = [];
  for (const row of result.stdout.split('\n')) {
    const [file, line] = row.split('\0');
    if (file && line && Number.isFinite(Number(line)))
      hits.push({ path: file, line: Number(line) });
  }
  return hits;
}

/**
 * A dev build reports an absolute path, a URL path (`/src/App.tsx?t=1`) or a path relative to
 * the project. Returns it relative to the project when the file exists there.
 */
export async function projectPath(root: string, reported: string): Promise<string | null> {
  let value = reported.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = new URL(value).pathname;
  } catch {
    return null;
  }
  value = decodeURIComponent(value.split(/[?#]/)[0] ?? '').replace(/\\/g, '/');
  if (value.startsWith('/@fs/')) value = value.slice(4);
  const absolute = path.isAbsolute(value) || /^[a-z]:\//i.test(value);
  const candidates = absolute ? [value, value.replace(/^\/+/, '')] : [value.replace(/^\.?\/+/, '')];
  for (const candidate of candidates) {
    try {
      const full = path.isAbsolute(candidate)
        ? await resolveInside(root, path.relative(root, candidate))
        : await resolveInside(root, candidate);
      if ((await stat(full)).isFile()) return toPosixRelative(root, full);
    } catch {
      // Outside the project or missing: try the next reading of the path.
    }
  }
  return null;
}

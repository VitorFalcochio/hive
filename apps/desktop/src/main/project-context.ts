import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { git } from '@hive/workspace';

/**
 * What the Queen reads about a project before planning: its folder tree, README, notes for
 * agents and manifests. She plans without tools, so this is all she sees of the code; a plan
 * that names real folders and the project's own commands starts every task better.
 */

/** Whole context, in characters; the Queen's model also needs room for the mission and reply. */
const MAX_CONTEXT = 24_000;
const TREE_DEPTH = 3;
const ENTRIES_PER_FOLDER = 25;
const MAX_TREE_LINES = 220;

/** Read as they are; the first one found wins within each group. */
const documents: { files: string[]; limit: number }[] = [
  { files: ['README.md', 'README', 'readme.md', 'README.rst', 'README.txt'], limit: 7_000 },
  { files: ['AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md'], limit: 4_000 },
  { files: ['CONTRIBUTING.md'], limit: 2_500 },
];

const manifests = [
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'docker-compose.yml',
  'compose.yaml',
];

async function readText(file: string, limit: number): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const text = (await readFile(file, 'utf8')).trim();
    if (!text) return null;
    return text.length > limit ? `${text.slice(0, limit)}\n[… cortado]` : text;
  } catch {
    return null;
  }
}

/** Files Git knows about plus new ones it does not ignore: the project without its build output. */
async function projectFiles(root: string): Promise<string[]> {
  const listed = await git(root, ['ls-files', '-co', '--exclude-standard', '-z'], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  if (listed.code !== 0) return [];
  return listed.stdout.split('\0').filter(Boolean);
}

interface Folder {
  folders: Map<string, Folder>;
  files: string[];
  count: number;
}

const emptyFolder = (): Folder => ({ folders: new Map(), files: [], count: 0 });

/** The tree, a few levels deep; deeper folders and long listings are summed up as counts. */
export function renderTree(files: string[]): string[] {
  const root = emptyFolder();
  for (const file of files) {
    const parts = file.split('/');
    let folder = root;
    folder.count++;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) folder.folders.set(part, (next = emptyFolder()));
      next.count++;
      folder = next;
    }
    folder.files.push(parts[parts.length - 1]!);
  }
  const lines: string[] = [];
  const walk = (folder: Folder, depth: number) => {
    const indent = '  '.repeat(depth);
    const names = [...folder.folders.keys()].sort();
    const entries = [
      ...names.map((name) => ({ name, sub: folder.folders.get(name)! })),
      ...[...folder.files].sort().map((name) => ({ name, sub: null })),
    ];
    for (const [index, { name, sub }] of entries.entries()) {
      if (index >= ENTRIES_PER_FOLDER) {
        lines.push(`${indent}… +${entries.length - index} itens`);
        break;
      }
      if (!sub) lines.push(`${indent}${name}`);
      else if (depth + 1 >= TREE_DEPTH) lines.push(`${indent}${name}/ (${sub.count} arquivos)`);
      else {
        lines.push(`${indent}${name}/`);
        walk(sub, depth + 1);
      }
    }
  };
  walk(root, 0);
  return lines.length > MAX_TREE_LINES
    ? [...lines.slice(0, MAX_TREE_LINES), `… +${lines.length - MAX_TREE_LINES} linhas`]
    : lines;
}

/** package.json reduced to what matters for planning: the scripts and what it is built with. */
export function summarizePackageJson(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const names = (key: string) =>
      value[key] && typeof value[key] === 'object' ? Object.keys(value[key]) : [];
    const lines: string[] = [];
    if (typeof value.name === 'string') lines.push(`name: ${value.name}`);
    if (typeof value.description === 'string') lines.push(`description: ${value.description}`);
    if (typeof value.type === 'string') lines.push(`type: ${value.type}`);
    const scripts = value.scripts && typeof value.scripts === 'object' ? value.scripts : {};
    const scriptLines = Object.entries(scripts as Record<string, unknown>).map(
      ([name, command]) => `  ${name}: ${String(command)}`,
    );
    if (scriptLines.length) lines.push('scripts:', ...scriptLines);
    for (const key of ['dependencies', 'devDependencies'])
      if (names(key).length) lines.push(`${key}: ${names(key).join(', ')}`);
    if (value.workspaces) lines.push(`workspaces: ${JSON.stringify(value.workspaces)}`);
    return lines.join('\n') || null;
  } catch {
    return null;
  }
}

/** Everything the Queen should know about the project at `root`, ready for her prompt. */
export async function describeProject(
  root: string,
  info: { name: string; branch: string | null },
): Promise<string> {
  const sections: string[] = [
    `Repository: ${info.name}${info.branch ? `\nBranch: ${info.branch}` : ''}`,
  ];
  const document = async (group: (typeof documents)[number]) => {
    for (const name of group.files) {
      const text = await readText(path.join(root, name), group.limit);
      if (text) return sections.push(`### ${name}\n${text}`);
    }
  };
  // Most telling first: when the context runs long, it is the end of the tree that goes.
  await document(documents[0]!);
  await document(documents[1]!);
  const packageJson = await readText(path.join(root, 'package.json'), 200_000);
  const summary = packageJson ? summarizePackageJson(packageJson) : null;
  if (summary) sections.push(`### package.json\n${summary}`);
  for (const name of manifests) {
    const text = await readText(path.join(root, name), 2_000);
    if (text) sections.push(`### ${name}\n${text}`);
  }
  await document(documents[2]!);
  const files = await projectFiles(root);
  if (files.length)
    sections.push(
      `### Files (${files.length} in total; build output and ignored files left out)\n${renderTree(files).join('\n')}`,
    );

  const context = sections.join('\n\n');
  return context.length > MAX_CONTEXT
    ? `${context.slice(0, MAX_CONTEXT)}\n[contexto do projeto cortado]`
    : context;
}

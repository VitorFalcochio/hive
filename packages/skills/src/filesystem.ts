import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/** Same limits SkillForge applies to catalogs and skill trees. */
export const LIMITS = {
  files: 1000,
  bytesPerFile: 2 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  depth: 32,
} as const;

const ignored = new Set(['node_modules', 'dist', 'coverage']);
export const resourceFolders = new Set(['references', 'scripts', 'assets', 'agents']);

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(file: string): Promise<string> {
  const info = await lstat(file);
  if (info.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${file}`);
  if (info.size > LIMITS.bytesPerFile) throw new Error(`File is too large: ${file}`);
  return readFile(file, 'utf8');
}

/** List regular files inside a skill directory (relative, posix). Rejects links and limits size. */
export async function listSkillFiles(directory: string): Promise<{ relative: string; size: number }[]> {
  const files: { relative: string; size: number }[] = [];
  let total = 0;
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > LIMITS.depth) throw new Error('Skill tree is too deep.');
    for (const name of (await readdir(current)).sort()) {
      const target = path.join(current, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Symlinks and junctions are not allowed: ${target}`);
      if (info.isDirectory()) await walk(target, depth + 1);
      else if (info.isFile()) {
        total += info.size;
        if (files.length >= LIMITS.files || total > LIMITS.totalBytes || info.size > LIMITS.bytesPerFile) {
          throw new Error('Skill exceeds size limits.');
        }
        files.push({ relative: path.relative(directory, target).split(path.sep).join('/'), size: info.size });
      } else throw new Error(`Unsupported file type: ${target}`);
    }
  }
  await walk(directory, 0);
  return files;
}

/**
 * Discover skill directories with SkillForge's rules: descent stops at a SKILL.md; hidden folders,
 * node_modules, dist and coverage are skipped; leaves without SKILL.md stay visible so validation
 * can report them as malformed instead of silently dropping them.
 */
export async function discoverSkillDirectories(root: string): Promise<string[]> {
  root = path.resolve(root);
  const found: string[] = [];
  let entries = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (++entries > LIMITS.files || depth > LIMITS.depth) throw new Error('Catalog exceeds discovery limits.');
    if (await exists(path.join(directory, 'SKILL.md'))) {
      found.push(directory);
      return;
    }
    const children: string[] = [];
    let hasResources = false;
    for (const name of (await readdir(directory)).sort()) {
      if (name.startsWith('.') || ignored.has(name)) continue;
      const target = path.join(directory, name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Symlinks and junctions are not allowed: ${target}`);
      if (info.isDirectory()) {
        children.push(target);
        if (resourceFolders.has(name)) hasResources = true;
      }
    }
    if (depth > 0 && (!children.length || hasResources)) {
      found.push(directory);
      return;
    }
    for (const child of children) await walk(child, depth + 1);
  }
  await walk(root, 0);
  return found;
}

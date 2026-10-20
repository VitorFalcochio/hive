import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { HiveError } from './errors';

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function realpathOfExistingAncestor(target: string): Promise<string> {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...rest.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current) throw error;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolve a user- or model-supplied path against an authorised root and refuse anything that
 * escapes it, including escapes through symlinks or junctions in already-existing components.
 * Returns the absolute, canonical path.
 */
export async function resolveInside(root: string, requested: string): Promise<string> {
  if (requested.includes('\0')) throw new HiveError('FORBIDDEN_PATH', 'Path contains a NUL byte.');
  const realRoot = await realpath(root);
  const candidate = path.resolve(realRoot, requested);
  if (!isInside(realRoot, candidate)) {
    throw new HiveError('FORBIDDEN_PATH', `Path is outside the authorised directory: ${requested}`);
  }
  const real = await realpathOfExistingAncestor(candidate);
  if (!isInside(realRoot, real)) {
    throw new HiveError(
      'FORBIDDEN_PATH',
      `Path resolves outside the authorised directory: ${requested}`,
    );
  }
  return real;
}

/** Relative path with forward slashes, for display and for model-facing tool output. */
export function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/') || '.';
}

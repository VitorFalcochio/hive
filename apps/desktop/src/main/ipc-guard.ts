import { clipText } from '@hive/shared';

/**
 * Longest string sent to a window. The renderer froze for good on records of tens of
 * megabytes (a git diff stored as an error); whatever the source, no single text that size
 * crosses IPC. A shown patch is at most 400 KB, so real content is never cut.
 */
export const MAX_IPC_STRING = 1024 * 1024;

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The value with every oversized string cut down (the cut stated in the text), plus how many
 * were cut. Untouched parts keep their identity, so the common case allocates nothing.
 */
export function boundForIpc<T>(value: T, max = MAX_IPC_STRING): { value: T; clipped: number } {
  let clipped = 0;
  const walk = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      if (item.length <= max) return item;
      clipped++;
      return clipText(item, max);
    }
    if (!item || typeof item !== 'object' || depth > 64) return item;
    if (Array.isArray(item)) {
      let copy: unknown[] | null = null;
      for (let i = 0; i < item.length; i++) {
        const next = walk(item[i], depth + 1);
        if (next !== item[i]) (copy ??= item.slice())[i] = next;
      }
      return copy ?? item;
    }
    if (!isPlain(item)) return item;
    let copy: Record<string, unknown> | null = null;
    for (const [key, entry] of Object.entries(item)) {
      const next = walk(entry, depth + 1);
      if (next !== entry) (copy ??= { ...(item as Record<string, unknown>) })[key] = next;
    }
    return copy ?? item;
  };
  return { value: walk(value, 0) as T, clipped };
}

import { randomUUID } from 'node:crypto';

/** Prefixed random identifiers make logs readable (`run_…`, `task_…`) without leaking ordering. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

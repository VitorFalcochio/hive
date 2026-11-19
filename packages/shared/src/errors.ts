export type HiveErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'FORBIDDEN_PATH'
  | 'NOT_A_GIT_REPO'
  | 'GIT'
  | 'PROVIDER'
  | 'PROVIDER_AUTH'
  | 'SECRET_STORE'
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'LIMIT'
  | 'SKILL'
  /** An operation that needs the user's approval was not approved. */
  | 'DENIED'
  /** A remote could not be reached: no network, DNS, TLS, timeout. */
  | 'NETWORK'
  /** A remote refused the credentials, or none were available. */
  | 'AUTH'
  | 'INTERNAL';

/** Error type that is safe to show to the user: its message never contains secrets. */
export class HiveError extends Error {
  constructor(
    public readonly code: HiveErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HiveError';
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Longest error text Hive stores or shows: enough for a stack or a compiler error, never a dump. */
export const MAX_ERROR_TEXT = 8_000;

/**
 * Bounds a text that came from outside (a process, a model, an error), keeping its start and
 * end. The cut is stated in the text itself, so nothing is hidden: a 60 MB git output once
 * landed in an error message and froze the whole app.
 */
export function clipText(text: string, max = MAX_ERROR_TEXT): string {
  if (text.length <= max) return text;
  const tail = Math.floor(max / 4);
  const head = Math.max(0, max - tail - 80);
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted.toLocaleString('pt-BR')} caracteres omitidos …]\n${text.slice(text.length - tail)}`;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof HiveError && error.code === 'CANCELLED')
  );
}

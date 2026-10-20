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

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof HiveError && error.code === 'CANCELLED')
  );
}

/** Show only enough of a secret to recognise it: `sk-…a1b2`. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

/**
 * Process-wide registry of secret values that must never reach logs, events or the database.
 * Every secret loaded from the secret store is registered here, and `redact` replaces any
 * occurrence before text is persisted or sent to the renderer.
 */
class SecretRedactor {
  private readonly values = new Set<string>();

  register(secret: string): void {
    if (secret.length >= 6) this.values.add(secret);
  }

  unregister(secret: string): void {
    this.values.delete(secret);
  }

  redact(text: string): string {
    let result = text;
    for (const value of this.values) {
      if (result.includes(value)) result = result.split(value).join('[REDACTED]');
    }
    // Common bearer token shapes, in case a provider echoes a header back.
    return result.replace(/(Bearer\s+)[A-Za-z0-9._-]{12,}/g, '$1[REDACTED]');
  }

  redactDeep<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.redactDeep(item)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) out[key] = this.redactDeep(item);
      return out as T;
    }
    return value;
  }
}

export const secretRedactor = new SecretRedactor();

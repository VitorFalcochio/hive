export type Listener<T> = (value: T) => void;

/** Minimal typed event emitter; returns an unsubscribe function from `on`. */
export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  on(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(value);
      } catch {
        // A faulty listener must not break event delivery to the others.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}

import type { SQLInputValue } from 'node:sqlite';
import type { z } from 'zod';
import type { HiveDatabase } from './database';

export interface Row {
  data: string;
}

/**
 * A table whose rows hold one validated JSON entity plus lookup columns. Reads are validated
 * again, so a corrupted or hand-edited database fails loudly instead of leaking bad state.
 */
export class JsonTable<T extends { id: string }> {
  constructor(
    private readonly db: HiveDatabase,
    private readonly table: string,
    private readonly schema: z.ZodType<T>,
    private readonly columns: (entity: T) => Record<string, SQLInputValue> = () => ({}),
  ) {}

  get(id: string): T | null {
    const row = this.db.get<Row>(`SELECT data FROM ${this.table} WHERE id = ?`, id);
    return row ? this.parse(row) : null;
  }

  require(id: string, what: string): T {
    const found = this.get(id);
    if (!found) throw Object.assign(new Error(`${what} not found: ${id}`), { code: 'NOT_FOUND' });
    return found;
  }

  list(where = '', ...params: SQLInputValue[]): T[] {
    const sql = `SELECT data FROM ${this.table} ${where ? `WHERE ${where}` : ''} ORDER BY updated_at DESC`;
    return this.db.all<Row>(sql, ...params).map((row) => this.parse(row));
  }

  put(entity: T): T {
    const valid = this.schema.parse(entity);
    const extra = this.columns(valid);
    const names = ['id', ...Object.keys(extra), 'updated_at', 'data'];
    const values: SQLInputValue[] = [
      valid.id,
      ...Object.values(extra),
      new Date().toISOString(),
      JSON.stringify(valid),
    ];
    const updates = names
      .filter((name) => name !== 'id')
      .map((name) => `${name} = excluded.${name}`);
    this.db.run(
      `INSERT INTO ${this.table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${updates.join(', ')}`,
      ...values,
    );
    return valid;
  }

  delete(id: string): void {
    this.db.run(`DELETE FROM ${this.table} WHERE id = ?`, id);
  }

  private parse(row: Row): T {
    return this.schema.parse(JSON.parse(row.data));
  }
}

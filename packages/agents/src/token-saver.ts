import type { ToolDefinition } from '@hive/providers';
import { HiveError } from '@hive/shared';

/**
 * What one agent loop remembers to spend fewer tokens: the file windows it has read (so a
 * re-read of an unchanged window costs one line and a changed one only its changed lines),
 * the full output of long commands (so the prompt carries a condensed view and the rest stays
 * one `read_output` away) and the failures in a row of each command (so a loop is called out).
 * One per loop: a soldier never gets "unchanged" for a read only its captain saw.
 */
export class TokenSaver {
  private readonly reads = new Map<string, ReadRecord>();
  private readonly outputs = new Map<string, string[]>();
  private readonly failures = new Map<string, { signature: string; count: number }>();

  /** The window last read for this path and range, while the model can still see it. */
  lastRead(key: string): ReadRecord | undefined {
    return this.reads.get(key);
  }

  /**
   * Records a read whose output is the tool message `callId`. A diff or "unchanged" output
   * (`buildsOnEarlier`) is only readable next to the reads it builds on, so it keeps them.
   */
  remember(key: string, lines: string[], callId: string, buildsOnEarlier: boolean): void {
    const earlier = buildsOnEarlier ? (this.reads.get(key)?.calls ?? []) : [];
    this.reads.set(key, { lines, calls: [...earlier, callId] });
  }

  /** The tool message `callId` was shortened: reads that relied on it must be sent in full. */
  forgetCall(callId: string): void {
    for (const [key, record] of this.reads)
      if (record.calls.includes(callId)) this.reads.delete(key);
  }

  storeOutput(lines: string[]): string {
    const id = `out${this.outputs.size + 1}`;
    this.outputs.set(id, lines);
    return id;
  }

  output(id: string): string[] | undefined {
    return this.outputs.get(id);
  }

  /** Counts failures in a row of `command` with the same error; a success resets it. */
  commandResult(command: string, failed: boolean, output: string): number {
    if (!failed) {
      this.failures.delete(command);
      return 0;
    }
    // Durations, timestamps and ports change between runs of the same failure.
    const signature = output.slice(-800).replace(/\d+/g, '#');
    const earlier = this.failures.get(command);
    const count = earlier?.signature === signature ? earlier.count + 1 : 1;
    this.failures.set(command, { signature, count });
    return count;
  }
}

export interface ReadRecord {
  lines: string[];
  /** The tool messages the model needs to rebuild this window. */
  calls: string[];
}

/** The same command failing this many times in a row with the same error is a loop. */
export const LOOP_AFTER = 3;

export const LOOP_NOTE =
  '\n\n[Hive: this exact command has now failed 3 times in a row with the same error. Running it again will not help. Read the error above and change the code or the approach, or call finish and explain what blocks you.]';

/* ------------------------------------------------------------- Re-reads */

/**
 * The output for a window read again: one line when nothing changed, the changed lines when
 * that is clearly shorter than the window, or null to send the window in full.
 */
export function rereadOutput(
  header: { path: string; start: number; end: number; total: number },
  before: string[],
  after: string[],
): string | null {
  const range = `${header.path} (lines ${header.start}-${header.end} of ${header.total})`;
  if (before.length === after.length && before.every((line, index) => line === after[index]))
    return `${range} is unchanged since you last read it: use that earlier output.`;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix++;
  const added = after.slice(prefix, after.length - suffix);
  const removed = before.length - prefix - suffix;
  // Worth it only when most of the window is the same as before.
  if (added.length > after.length * 0.5 || after.length < 20) return null;
  const first = header.start + prefix;
  const lines = [
    `${range} changed since you last read it. Only the changed part is shown; every other line is as in your earlier read.`,
  ];
  if (removed)
    lines.push(
      `Lines ${first}-${first + removed - 1} of your earlier read were replaced${added.length ? ' by:' : ' by nothing (deleted).'}`,
    );
  else lines.push(`New lines inserted at line ${first}:`);
  lines.push(...added.map((line, index) => `${String(first + index).padStart(5)}  ${line}`));
  const shift = added.length - removed;
  if (shift && suffix)
    lines.push(
      `The lines after them are unchanged and moved ${shift > 0 ? 'down' : 'up'} by ${Math.abs(shift)}.`,
    );
  return lines.join('\n');
}

/* ------------------------------------------------------- Command output */

/** Outputs longer than this are condensed; the full text is kept for read_output. */
export const CONDENSE_OVER_CHARS = 3_000;
const HEAD_LINES = 5;
const TAIL_LINES = 25;
const MAX_PICKED = 80;
const LINE_CHARS = 300;
const NOTABLE =
  /error|fail|exception|traceback|panic|fatal|assert|expected|received|not ok|cannot|unable|denied|missing|undefined|warn|✗|✖|×|❌/i;

/**
 * A long command output cut down to what decides the next step: its first lines, every line
 * that looks like an error or a warning (with a line of context), and its last lines, where
 * test runners and builders print their summary. Lines keep their numbers for read_output.
 */
export function condenseOutput(lines: string[], id: string): string {
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(HEAD_LINES, lines.length); index++) keep.add(index);
  for (let index = Math.max(0, lines.length - TAIL_LINES); index < lines.length; index++)
    keep.add(index);
  let picked = 0;
  for (let index = 0; index < lines.length && picked < MAX_PICKED; index++) {
    if (!NOTABLE.test(lines[index]!)) continue;
    for (const near of [index - 1, index, index + 1, index + 2])
      if (near >= 0 && near < lines.length && !keep.has(near)) {
        keep.add(near);
        picked++;
      }
  }
  const out: string[] = [];
  let previous = -1;
  for (const index of [...keep].sort((a, b) => a - b)) {
    if (index > previous + 1) out.push(`      [… ${index - previous - 1} lines …]`);
    const line = lines[index]!;
    out.push(
      `${String(index + 1).padStart(5)}  ${line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line}`,
    );
    previous = index;
  }
  out.push(
    `[Condensed: ${keep.size} of ${lines.length} lines shown (start, errors and warnings, end). The full output is kept: read_output with id "${id}" and a line range or a query.]`,
  );
  return out.join('\n');
}

export const readOutputDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_output',
    description:
      'Read more of a long command output that run_command condensed, by its id: a 1-based line range, or the lines containing a query.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'For example "out1".' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
        query: { type: 'string', description: 'Case-insensitive text to find.' },
      },
      required: ['id'],
    },
  },
};

const OUTPUT_WINDOW = 200;
const MAX_MATCHES = 100;

export function readOutput(saver: TokenSaver, args: Record<string, unknown>): string {
  const id = typeof args.id === 'string' ? args.id.trim() : '';
  const lines = saver.output(id);
  if (!lines) throw new HiveError('NOT_FOUND', `No kept output with id "${id}".`);
  const number = (index: number) => `${String(index + 1).padStart(5)}  ${lines[index]}`;
  if (typeof args.query === 'string' && args.query.trim()) {
    const query = args.query.trim().toLowerCase();
    const hits = lines.flatMap((line, index) =>
      line.toLowerCase().includes(query) ? [index] : [],
    );
    if (!hits.length) return `No line of ${id} contains "${args.query}".`;
    const shown = hits.slice(0, MAX_MATCHES).map(number);
    const more = hits.length > MAX_MATCHES ? `\n[${hits.length - MAX_MATCHES} more matches]` : '';
    return `${id}: ${hits.length} lines contain "${args.query}"\n${shown.join('\n')}${more}`;
  }
  const start = Math.max(1, Number(args.start_line ?? 1));
  const end = Math.min(lines.length, Number(args.end_line ?? start + OUTPUT_WINDOW - 1));
  if (start > lines.length) return `${id} has only ${lines.length} lines.`;
  const body: string[] = [];
  for (let index = start - 1; index < end; index++) body.push(number(index));
  const more = end < lines.length ? `; pass start_line=${end + 1} to read on` : '';
  return `${id} (lines ${start}-${end} of ${lines.length}${more})\n${body.join('\n')}`;
}

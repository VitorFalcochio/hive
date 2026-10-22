import { beePixels } from '@hive/core';

/** The bee is drawn two pixels per character cell: ▀ in the top colour over the bottom one. */
export const BEE_COLUMNS = 16;
export const BEE_ROWS = 6;
export const SMALL_BEE_COLUMNS = 12;
export const SMALL_BEE_ROWS = 4;

function channels(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

/** The pixel bee as terminal lines (truecolor ANSI), `BEE_COLUMNS` cells wide or the small one's. */
export function beeLines(
  options: { body?: string; crowned?: boolean; wingsUp?: boolean; small?: boolean } = {},
): string[] {
  const pixels = beePixels(options);
  const lines: string[] = [];
  for (let y = 0; y < pixels.length; y += 2) {
    let line = '';
    pixels[y]!.forEach((top, x) => {
      const bottom = pixels[y + 1]?.[x] ?? null;
      if (top && bottom) line += `\x1b[38;2;${channels(top)};48;2;${channels(bottom)}m▀`;
      else if (top) line += `\x1b[49;38;2;${channels(top)}m▀`;
      else if (bottom) line += `\x1b[49;38;2;${channels(bottom)}m▄`;
      else line += '\x1b[0m ';
    });
    lines.push(`${line}\x1b[0m`);
  }
  return lines;
}

/** The bee with text beside it, row by row; the text may run longer than the bee. */
export function besideBee(
  bee: string[],
  text: string[],
  { indent = '  ', width = BEE_COLUMNS, gap = 3 } = {},
): string[] {
  const rows = Math.max(bee.length, text.length);
  return Array.from({ length: rows }, (_, row) =>
    `${indent}${bee[row] ?? ' '.repeat(width)}${' '.repeat(gap)}${text[row] ?? ''}`.trimEnd(),
  );
}

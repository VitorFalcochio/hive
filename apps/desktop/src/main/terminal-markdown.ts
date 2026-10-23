/**
 * The agent's Markdown as terminal lines: headings, bold, inline code, lists, quotes, code
 * blocks and tables drawn with ANSI styles instead of raw `**` and `|`, word-wrapped to the
 * terminal's width so a wrapped line keeps its indent.
 */

const reset = '\x1b[0m';
const bold = '\x1b[1m';

function rgb(hex: string): string {
  const value = parseInt(hex.slice(1), 16);
  return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
}
const gray = rgb('#62666d');
const light = rgb('#9ba1a9');
const code = rgb('#e8a87c');

/** A run of text in one style (an ANSI prefix, '' for plain). */
interface Segment {
  text: string;
  style: string;
}

/**
 * Cells a character takes: 0 for combining marks and joiners, 2 for emoji and CJK. A guess on
 * the wide side only wraps a little early; on the narrow side the terminal would wrap for us.
 */
function charWidth(character: string): number {
  const point = character.codePointAt(0)!;
  if (
    (point >= 0x300 && point <= 0x36f) ||
    point === 0x200d ||
    (point >= 0xfe00 && point <= 0xfe0f)
  )
    return 0;
  if (
    (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2600 && point <= 0x27bf) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0x1f300 && point <= 0x1faff)
  )
    return 2;
  return 1;
}

export function textWidth(text: string): number {
  let width = 0;
  for (const character of text) width += charWidth(character);
  return width;
}

function paint(segments: Segment[]): string {
  // Neighbours in the same style share one escape code.
  const runs: Segment[] = [];
  for (const segment of segments) {
    const last = runs[runs.length - 1];
    if (last?.style === segment.style) last.text += segment.text;
    else runs.push({ ...segment });
  }
  return runs.map(({ text, style }) => (style ? `${style}${text}${reset}` : text)).join('');
}

function segmentsWidth(segments: Segment[]): number {
  return segments.reduce((sum, segment) => sum + textWidth(segment.text), 0);
}

/* ---------------------------------------------------------------- Inline */

const wordCharacter = /[\p{L}\p{N}]/u;

/** `**bold**`, `` `code` ``, `*emphasis*`, `[link](url)` and `\` escapes, markers removed. */
export function parseInline(text: string, style = ''): Segment[] {
  const segments: Segment[] = [];
  let plain = '';
  const flush = () => {
    if (plain) segments.push({ text: plain, style });
    plain = '';
  };
  for (let index = 0; index < text.length;) {
    const rest = text.slice(index);
    const character = text[index]!;
    if (character === '\\' && index + 1 < text.length && /[\\`*_[\]#|~-]/.test(text[index + 1]!)) {
      plain += text[index + 1];
      index += 2;
      continue;
    }
    if (character === '`') {
      const ticks = /^`+/.exec(rest)![0];
      const close = text.indexOf(ticks, index + ticks.length);
      if (close > index) {
        flush();
        segments.push({ text: text.slice(index + ticks.length, close).trim(), style: code });
        index = close + ticks.length;
        continue;
      }
    }
    const strong = /^(\*\*|__)(?=\S)/.exec(rest);
    if (strong) {
      const close = text.indexOf(strong[1]!, index + 2);
      if (close > index + 2 && !/\s/.test(text[close - 1]!)) {
        flush();
        segments.push(...parseInline(text.slice(index + 2, close), `${style}${bold}`));
        index = close + 2;
        continue;
      }
    }
    if ((character === '*' || character === '_') && /^\S/.test(rest.slice(1))) {
      // An underscore inside a word (snake_case) is not emphasis.
      const opensWord = character === '*' || !wordCharacter.test(text[index - 1] ?? '');
      let close = text.indexOf(character, index + 1);
      while (close > 0 && character === '_' && wordCharacter.test(text[close + 1] ?? ''))
        close = text.indexOf(character, close + 1);
      if (opensWord && close > index + 1 && !/\s/.test(text[close - 1]!)) {
        flush();
        segments.push(...parseInline(text.slice(index + 1, close), style));
        index = close + 1;
        continue;
      }
    }
    if (rest.startsWith('~~')) {
      const close = text.indexOf('~~', index + 2);
      if (close > index + 2) {
        flush();
        segments.push(...parseInline(text.slice(index + 2, close), style));
        index = close + 2;
        continue;
      }
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      segments.push(...parseInline(link[1]!, style));
      if (link[2] !== link[1]) segments.push({ text: ` (${link[2]})`, style: gray });
      index += link[0].length;
      continue;
    }
    plain += character;
    index++;
  }
  flush();
  return segments;
}

/* ---------------------------------------------------------------- Wrapping */

/**
 * Breaks styled text into lines of at most `width` cells, at spaces when it can. `first` starts
 * the first line (a bullet), `indent` the others, so a list item's text lines up under itself.
 */
function wrap(
  segments: Segment[],
  width: number,
  first: Segment[] = [],
  indent: Segment[] = [],
): string[] {
  const lines: Segment[][] = [];
  let line: Segment[] = [...first];
  let used = segmentsWidth(first);
  const lead = segmentsWidth(first);
  const room = Math.max(8, width - lead);
  const breakLine = () => {
    lines.push(line);
    line = [...indent];
    used = segmentsWidth(indent);
  };
  const atStart = () => used === (lines.length ? segmentsWidth(indent) : lead);

  for (const segment of segments) {
    for (const piece of segment.text.split(/(\s+)/)) {
      if (!piece) continue;
      const blank = /^\s+$/.test(piece);
      if (blank) {
        if (atStart()) continue;
        const space = ' ';
        if (used + 1 > lead + room) breakLine();
        else {
          line.push({ text: space, style: segment.style });
          used += 1;
        }
        continue;
      }
      let word = piece;
      let size = textWidth(word);
      if (used + size > lead + room && !atStart()) {
        // The space before the word stays on the line it ends.
        const last = line[line.length - 1];
        if (last?.text === ' ') line.pop();
        breakLine();
      }
      // A word wider than the line (a long path) is cut where it reaches the edge.
      while (size > lead + room - used) {
        let cut = '';
        let cutSize = 0;
        for (const character of word) {
          if (used + cutSize + charWidth(character) > lead + room) break;
          cut += character;
          cutSize += charWidth(character);
        }
        if (!cut) break;
        line.push({ text: cut, style: segment.style });
        word = word.slice(cut.length);
        size = textWidth(word);
        breakLine();
      }
      if (word) {
        line.push({ text: word, style: segment.style });
        used += size;
      }
    }
  }
  if (line.length) lines.push(line);
  return lines.map((segments) => paint(segments).trimEnd());
}

/** Cuts a styled line at `width` cells; code is not wrapped, it is cut. */
function cut(segments: Segment[], width: number): string {
  if (segmentsWidth(segments) <= width) return paint(segments);
  const kept: Segment[] = [];
  let room = width - 1;
  for (const segment of segments) {
    let text = '';
    for (const character of segment.text) {
      if (charWidth(character) > room) break;
      text += character;
      room -= charWidth(character);
    }
    if (text) kept.push({ text, style: segment.style });
    if (text.length < segment.text.length) break;
  }
  return `${paint(kept)}${gray}…${reset}`;
}

/* ---------------------------------------------------------------- Blocks */

const fence = /^\s*(```|~~~)/;
const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const rule = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const bullet = /^(\s*)([-*+])\s+(.*)$/;
const numbered = /^(\s*)(\d{1,3}[.)])\s+(.*)$/;
const quote = /^\s*>\s?(.*)$/;
const tableRow = /^\s*\|.*\|\s*$/;
const tableDivider = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function table(rows: string[], width: number): string[] {
  const parsed = rows.filter((row) => !tableDivider.test(row)).map(cells);
  const header = tableDivider.test(rows[1] ?? '') ? parsed.shift()! : null;
  const columns = Math.max(...[header ?? [], ...parsed].map((row) => row.length));
  const render = (row: string[], style: string) =>
    Array.from({ length: columns }, (_, column) => parseInline(row[column] ?? '', style));
  const head = header ? render(header, bold) : null;
  const body = parsed.map((row) => render(row, ''));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.max(...[head, ...body].filter(Boolean).map((row) => segmentsWidth(row![column]!))),
  );
  const total = widths.reduce((sum, size) => sum + size, 0) + 3 * (columns - 1);

  if (total <= width) {
    const line = (row: Segment[][]) =>
      row
        .map((cell, column) => {
          const pad = ' '.repeat(widths[column]! - segmentsWidth(cell));
          return paint(cell) + (column < columns - 1 ? `${pad} ${gray}│${reset} ` : '');
        })
        .join('');
    return [
      ...(head ? [line(head), `${gray}${'─'.repeat(total)}${reset}`] : []),
      ...body.map(line),
    ];
  }
  // Too wide to line up: each row becomes an item, "Coluna: valor · Coluna: valor".
  return body.flatMap((row) => {
    const parts: Segment[] = [];
    row.forEach((cell, column) => {
      if (!segmentsWidth(cell)) return;
      if (parts.length) parts.push({ text: ' · ', style: gray });
      if (head?.[column]?.length) parts.push(...head[column]!, { text: ': ', style: bold });
      parts.push(...cell);
    });
    return wrap(parts, width, [{ text: '• ', style: gray }], [{ text: '  ', style: '' }]);
  });
}

/** The Markdown as lines no wider than `width` cells, styled for the terminal. */
export function renderMarkdown(markdown: string, width: number, accent = bold): string[] {
  const source = markdown.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  const out: string[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1] !== '') out.push('');
  };

  for (let index = 0; index < source.length; index++) {
    const line = source[index]!;
    const opening = fence.exec(line);
    if (opening) {
      const body: string[] = [];
      for (
        index++;
        index < source.length && !source[index]!.trim().startsWith(opening[1]!);
        index++
      )
        body.push(source[index]!);
      for (const codeLine of body)
        out.push(
          cut(
            [
              { text: '│ ', style: gray },
              { text: codeLine.trimEnd(), style: code },
            ],
            width,
          ),
        );
      continue;
    }
    if (tableRow.test(line)) {
      const rows: string[] = [];
      while (index < source.length && tableRow.test(source[index]!)) rows.push(source[index++]!);
      index--;
      out.push(...table(rows, width));
      continue;
    }
    if (!line.trim()) {
      blank();
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      if (out.length) blank();
      const level = title[1]!.length;
      out.push(...wrap(parseInline(title[2]!, level <= 2 ? `${accent}${bold}` : bold), width));
      continue;
    }
    if (rule.test(line)) {
      out.push(`${gray}${'─'.repeat(Math.min(width, 40))}${reset}`);
      continue;
    }
    const said = quote.exec(line);
    if (said) {
      const bar = { text: '│ ', style: gray };
      out.push(...wrap(parseInline(said[1]!, light), width, [bar], [bar]));
      continue;
    }
    const item = bullet.exec(line) ?? numbered.exec(line);
    if (item) {
      const depth = '  '.repeat(Math.min(3, Math.floor(item[1]!.length / 2)));
      const marker = /\d/.test(item[2]!) ? `${item[2]} ` : '• ';
      const checkbox = /^\[([ xX])\]\s+(.*)$/.exec(item[3]!);
      const mark = checkbox ? (checkbox[1] === ' ' ? '☐ ' : '☑ ') : marker;
      out.push(
        ...wrap(
          parseInline(checkbox ? checkbox[2]! : item[3]!),
          width,
          [{ text: `${depth}${mark}`, style: gray }],
          [{ text: ' '.repeat(textWidth(depth + mark)), style: '' }],
        ),
      );
      continue;
    }
    // A paragraph runs until a blank line or another block.
    let paragraph = line.trim();
    while (
      index + 1 < source.length &&
      source[index + 1]!.trim() &&
      ![fence, heading, rule, bullet, numbered, quote, tableRow].some((block) =>
        block.test(source[index + 1]!),
      )
    )
      paragraph += ` ${source[++index]!.trim()}`;
    out.push(...wrap(parseInline(paragraph), width));
  }
  while (out[out.length - 1] === '') out.pop();
  return out;
}

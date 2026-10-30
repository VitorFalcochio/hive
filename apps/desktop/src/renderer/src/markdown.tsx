import { Fragment, type ReactNode } from 'react';

/**
 * The Markdown agents write in their summaries, drawn as React elements: headings, lists,
 * paragraphs, tables, code blocks, and **bold**, *italic* and `code` inline. Anything else stays text,
 * and nothing is ever parsed as HTML.
 */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] };

const bullet = /^\s*[-*+•]\s+(.*)$/;
const numbered = /^\s*\d+[.)]\s+(.*)$/;
const heading = /^(#{1,6})\s+(.*?)\s*#*$/;
const tableRow = /^\s*\|.*\|\s*$/;
const tableRule = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index++;
      continue;
    }
    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trim().startsWith('```'))
        code.push(lines[index++]!);
      index++;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (tableRow.test(line) && index + 1 < lines.length && tableRule.test(lines[index + 1]!)) {
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && tableRow.test(lines[index]!))
        rows.push(cells(lines[index++]!));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const title = heading.exec(line);
    if (title) {
      blocks.push({ kind: 'heading', level: title[1]!.length, text: title[2]! });
      index++;
      continue;
    }
    const ordered = numbered.test(line);
    if (ordered || bullet.test(line)) {
      const pattern = ordered ? numbered : bullet;
      const items: string[] = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index]!);
        if (match) items.push(match[1]!);
        // An indented line without a marker continues the item above it.
        else if (items.length && /^\s{2,}\S/.test(lines[index]!))
          items[items.length - 1] += ` ${lines[index]!.trim()}`;
        else break;
        index++;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const text: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      !heading.test(lines[index]!) &&
      !bullet.test(lines[index]!) &&
      !numbered.test(lines[index]!) &&
      !tableRow.test(lines[index]!) &&
      !lines[index]!.trim().startsWith('```')
    )
      text.push(lines[index++]!.trim());
    blocks.push({ kind: 'paragraph', text: text.join(' ') });
  }
  return blocks;
}

const inline = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;

function renderInline(text: string): ReactNode[] {
  return text.split(inline).map((part, index) => {
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`'))
      return <code key={index}>{part.slice(1, -1)}</code>;
    if (part.length > 4 && (part.startsWith('**') || part.startsWith('__')))
      return <strong key={index}>{renderInline(part.slice(2, -2))}</strong>;
    if (part.length > 2 && /^([*_]).*\1$/.test(part))
      return <em key={index}>{part.slice(1, -1)}</em>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  return (
    <div className={`markdown${className ? ` ${className}` : ''}`}>
      {parseMarkdown(source).map((block, index) => {
        switch (block.kind) {
          case 'heading':
            return (
              <p key={index} className={`md-heading md-h${Math.min(block.level, 3)}`}>
                {renderInline(block.text)}
              </p>
            );
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul';
            return (
              <List key={index}>
                {block.items.map((item, at) =>
                  /^\[([ xX])\]\s+/.test(item) ? (
                    <li key={at} className="md-check-item">
                      <input
                        type="checkbox"
                        checked={/^\[[xX]\]/.test(item)}
                        disabled
                        aria-label={item.replace(/^\[[ xX]\]\s+/, '')}
                      />{' '}
                      {renderInline(item.replace(/^\[[ xX]\]\s+/, ''))}
                    </li>
                  ) : (
                    <li key={at}>{renderInline(item)}</li>
                  ),
                )}
              </List>
            );
          }
          case 'table':
            return (
              <div key={index} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {block.head.map((cell, at) => (
                        <th key={at}>{renderInline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, at) => (
                      <tr key={at}>
                        {row.map((cell, col) => (
                          <td key={col}>{renderInline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'code':
            return (
              <pre key={index}>
                <code>{block.text}</code>
              </pre>
            );
          default:
            return <p key={index}>{renderInline(block.text)}</p>;
        }
      })}
    </div>
  );
}

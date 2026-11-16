import type { Product } from './store.ts';

const HEADER = ['sku', 'name', 'priceCents', 'category'] as const;

function field(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(products: Product[]): string {
  const rows = products.map((p) =>
    [p.sku, p.name, String(p.priceCents), p.category].map(field).join(','),
  );
  return [HEADER.join(','), ...rows].join('\n');
}

/** Splits CSV text into rows of fields, honouring quoted fields with commas, quotes and newlines. */
function parse(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(value);
      value = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else value += char;
  }
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

export function fromCsv(text: string): Product[] {
  const [, ...rows] = parse(text);
  return rows.map(([sku = '', name = '', price = '0', category = '']) => ({
    sku,
    name,
    priceCents: Number(price),
    category,
  }));
}

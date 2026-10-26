import { HiveError } from '@hive/shared';

const FETCH_TIMEOUT_MS = 20_000;
/** Enough for a long documentation page; what is past it is cut off, not refused. */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const TEXT_TYPES = /text\/|json|xml|javascript|markdown|yaml|toml/i;

/** A page an agent opens in a hidden browser: what it looks like and what it logged. */
export interface PageView {
  title: string;
  /** PNG of the visible area as a data URL. */
  dataUrl: string;
  /** The HTTP status of the page itself, null when it is unknown. */
  status: number | null;
  /** Errors and warnings from the page's console and failed loads, oldest first. */
  console: string[];
}

/** Opens a local page and screenshots it. The desktop app supplies one; tests can fake it. */
export type PageViewer = (request: {
  url: string;
  width: number;
  height: number;
  signal: AbortSignal;
}) => Promise<PageView>;

export function parseWebUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new HiveError(
      'VALIDATION',
      `"${value}" is not a valid URL. Include http:// or https://.`,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new HiveError('VALIDATION', 'Only http and https URLs can be opened.');
  return url;
}

/** Pages served from this computer, the only ones view_page opens. */
export function isLocalUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * The readable text of an HTML page, with headings, list items and links kept in Markdown so
 * the agent can follow them. Scripts, styles and markup are dropped.
 */
export function htmlToText(html: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
      const inner = String(label)
        .replace(/<[^>]+>/g, '')
        .trim();
      return inner && /^https?:|^\//.test(href) ? `[${inner}](${href})` : inner;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(
      /<\/(p|div|h[1-6]|tr|pre|section|article|header|footer|ul|ol|table|blockquote)>/gi,
      '\n\n',
    )
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  const body = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return title ? `# ${decodeEntities(title)}\n\n${body}` : body;
}

async function readCapped(response: Response): Promise<{ text: string; cut: boolean }> {
  if (!response.body) return { text: '', cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_FETCH_BYTES) {
      cut = true;
      await reader.cancel();
      break;
    }
  }
  return {
    text: new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_FETCH_BYTES)),
    cut,
  };
}

export interface FetchedPage {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  text: string;
}

/** GETs a URL and returns its text, HTML turned into readable Markdown-ish text. */
export async function fetchPage(value: string, signal: AbortSignal): Promise<FetchedPage> {
  const url = parseWebUrl(value);
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
    redirect: 'follow',
    headers: {
      'user-agent': 'Hive/0.1 (AI coding agent; +https://github.com/VitorFalcochio/hive)',
      accept: 'text/html,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.5',
    },
  });
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const base = {
    url: response.url || url.href,
    status: response.status,
    ok: response.ok,
    contentType,
  };
  if (contentType && !TEXT_TYPES.test(contentType)) {
    await response.body?.cancel();
    return { ...base, text: `(${contentType} content is not text and is not shown)` };
  }
  const { text, cut } = await readCapped(response);
  const readable =
    /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text) ? htmlToText(text) : text;
  return { ...base, text: cut ? `${readable}\n\n[page cut off at 2 MB]` : readable };
}

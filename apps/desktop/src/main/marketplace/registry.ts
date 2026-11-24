import { createHash } from 'node:crypto';
import { marketplaceIndexSchema, type MarketplaceIndex } from '@hive/core';
import { HiveError, errorMessage } from '@hive/shared';
import index from '../../../../../marketplace/index.json?raw';
import esquadraoWeb from '../../../../../marketplace/packages/esquadrao-web.json?raw';
import qaDeInterface from '../../../../../marketplace/packages/qa-de-interface.json?raw';
import revisorDeAcessibilidade from '../../../../../marketplace/packages/revisor-de-acessibilidade.json?raw';

/** Where packages come from. The page lists them all; each says which source it came from. */
export interface MarketplaceRegistry {
  id: string;
  label: string;
  index(): Promise<MarketplaceIndex>;
  /** The exact text of a package, by its path in the index. */
  read(path: string): Promise<string>;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function parseIndex(raw: string, where: string): MarketplaceIndex {
  try {
    return marketplaceIndexSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new HiveError('VALIDATION', `O índice de ${where} é inválido: ${errorMessage(error)}`);
  }
}

/**
 * The packages that ship with Hive: the files in the repository's marketplace/ folder, built
 * into the app. The same files are what the community catalog on GitHub will hold.
 */
export class BuiltinRegistry implements MarketplaceRegistry {
  readonly id = 'hive';
  readonly label = 'Hive';
  private readonly files: Record<string, string> = {
    'packages/esquadrao-web.json': esquadraoWeb,
    'packages/qa-de-interface.json': qaDeInterface,
    'packages/revisor-de-acessibilidade.json': revisorDeAcessibilidade,
  };

  async index(): Promise<MarketplaceIndex> {
    return parseIndex(index, 'Hive');
  }

  async read(path: string): Promise<string> {
    const text = this.files[path];
    if (text === undefined) throw new HiveError('NOT_FOUND', `Pacote ${path} não está no Hive.`);
    return text;
  }
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 1024 * 1024;

/**
 * A community catalog: an index.json and its packages served as plain files, such as a GitHub
 * repository read through raw.githubusercontent.com. No account or backend is needed.
 */
export class RemoteRegistry implements MarketplaceRegistry {
  readonly id = 'comunidade';
  readonly label = 'Comunidade';

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:')
      throw new HiveError('VALIDATION', 'O catálogo da comunidade precisa de um endereço https.');
  }

  private async get(relative: string): Promise<string> {
    const url = new URL(relative, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`);
    const response = await this.fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok)
      throw new HiveError(
        'NETWORK',
        `O catálogo respondeu ${response.status} para ${url.pathname}.`,
      );
    const text = await response.text();
    if (text.length > MAX_BYTES) throw new HiveError('LIMIT', `${url.pathname} passa de 1 MB.`);
    return text;
  }

  async index(): Promise<MarketplaceIndex> {
    return parseIndex(await this.get('index.json'), 'catálogo da comunidade');
  }

  read(path: string): Promise<string> {
    return this.get(path);
  }
}

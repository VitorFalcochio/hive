import { createHash } from 'node:crypto';
import type { EmbeddingClient } from '@hive/providers';
import { errorMessage, secretRedactor } from '@hive/shared';

/** Turns texts into unit vectors of one space; `model` names that space in the index. */
export interface Embedder {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export const LOCAL_MODEL = 'hive-local-concepts-v1';
const DIMENSIONS = 512;

const stopwords = new Set(
  (
    'a o os as um uma uns umas de do da dos das em no na nos nas por para pra com sem sob sobre ' +
    'e ou mas que se ao aos à às como qual quais quando onde porque pelo pela pelos pelas este esta ' +
    'isso isto esse essa ele ela eles elas seu sua seus suas nosso nossa devemos deve devem ser ' +
    'foi sao são está estao the an of to in on for with without by from and or but that this these ' +
    'those is are was were be been it its as at we our you your should must how what which when ' +
    'where why do does use using usar uso vamos'
  ).split(/\s+/),
);

/**
 * Software concepts, in Portuguese and English, as stems. A text that mentions any member also
 * carries the concept, so "identificação dos usuários" and "autenticação JWT" meet on `auth`
 * even without a shared word. Groups may overlap.
 */
const concepts: Record<string, string[]> = {
  auth: [
    'autentic',
    'authent',
    'auth',
    'login',
    'logon',
    'logout',
    'signin',
    'signup',
    'jwt',
    'token',
    'oauth',
    'openid',
    'oidc',
    'sessa',
    'session',
    'identific',
    'identidad',
    'identity',
    'credenc',
    'credential',
    'senha',
    'password',
    'sso',
    'bearer',
    'refresh',
    'mfa',
    '2fa',
    'cadastr',
  ],
  user: ['usuari', 'user', 'account', 'conta', 'perfil', 'profile', 'cliente', 'member', 'membro'],
  security: [
    'segur',
    'secur',
    'criptograf',
    'encrypt',
    'hash',
    'bcrypt',
    'argon',
    'xss',
    'csrf',
    'cors',
    'injec',
    'sanitiz',
    'vulnerab',
    'ataque',
    'attack',
  ],
  access: [
    'permiss',
    'autoriz',
    'authoriz',
    'role',
    'papel',
    'papei',
    'acess',
    'access',
    'rbac',
    'acl',
    'privileg',
    'admin',
  ],
  database: [
    'banco',
    'database',
    'db',
    'sql',
    'sqlite',
    'postgr',
    'mysql',
    'mongo',
    'tabela',
    'table',
    'migra',
    'orm',
    'prisma',
    'drizzle',
    'typeorm',
    'query',
    'consult',
    'indice',
    'index',
    'persist',
    'repositori',
    'repository',
    'registro',
    'record',
    'coluna',
    'column',
  ],
  api: [
    'api',
    'endpoint',
    'rota',
    'route',
    'rest',
    'graphql',
    'grpc',
    'contrato',
    'contract',
    'request',
    'requisi',
    'respost',
    'respons',
    'http',
    'payload',
    'status',
    'json',
    'webhook',
    'servic',
    'service',
  ],
  ui: [
    'tela',
    'screen',
    'pagina',
    'page',
    'component',
    'botao',
    'botoe',
    'button',
    'layout',
    'css',
    'estil',
    'style',
    'tailwind',
    'react',
    'vue',
    'svelte',
    'view',
    'formulari',
    'form',
    'ui',
    'interfac',
    'frontend',
    'front',
    'modal',
    'menu',
    'tema',
    'theme',
    'design',
    'visual',
    'ux',
  ],
  test: [
    'teste',
    'test',
    'qa',
    'spec',
    'vitest',
    'jest',
    'playwright',
    'cypress',
    'cobertur',
    'coverage',
    'assert',
    'e2e',
    'unitari',
    'unit',
    'integra',
    'mock',
    'fixture',
    'regress',
  ],
  requirement: [
    'requisit',
    'requirement',
    'criteri',
    'criteria',
    'aceita',
    'accept',
    'regra',
    'rule',
    'negoci',
    'business',
    'escopo',
    'scope',
    'historia',
    'story',
    'funcionalidad',
    'feature',
  ],
  error: [
    'erro',
    'error',
    'excec',
    'exception',
    'falha',
    'failure',
    'fail',
    'bug',
    'crash',
    'trat',
  ],
  logging: ['log', 'logging', 'monitor', 'observab', 'telemetri', 'metric', 'trace', 'sentry'],
  config: [
    'config',
    'env',
    'ambient',
    'environment',
    'variave',
    'variable',
    'setting',
    'secret',
    'segredo',
    'chave',
    'key',
    'dotenv',
  ],
  deploy: [
    'deploy',
    'build',
    'ci',
    'pipeline',
    'docker',
    'container',
    'release',
    'produc',
    'hospedag',
    'hosting',
    'kubernet',
    'infra',
    'servidor',
    'server',
  ],
  performance: [
    'desempenh',
    'perform',
    'cache',
    'lent',
    'slow',
    'otimiz',
    'optim',
    'latenc',
    'rapid',
    'fast',
    'paginac',
    'pagination',
    'lazy',
  ],
  payment: [
    'pagament',
    'payment',
    'cobranc',
    'billing',
    'fatur',
    'invoice',
    'checkout',
    'stripe',
    'pix',
    'assinatur',
    'subscription',
    'preco',
    'price',
    'carrinh',
    'cart',
  ],
  state: ['estado', 'state', 'store', 'redux', 'zustand', 'context', 'cache', 'sincroniz', 'sync'],
  validation: [
    'valid',
    'zod',
    'yup',
    'schema',
    'esquema',
    'formato',
    'format',
    'obrigatori',
    'required',
  ],
  files: [
    'arquiv',
    'file',
    'upload',
    'download',
    'storage',
    'armazen',
    's3',
    'imag',
    'image',
    'blob',
  ],
  messaging: [
    'email',
    'e-mail',
    'notific',
    'push',
    'mensag',
    'message',
    'fila',
    'queue',
    'evento',
    'event',
  ],
  time: ['date', 'hora', 'time', 'fuso', 'timezone', 'agend', 'schedul', 'cron', 'prazo'],
  i18n: ['idioma', 'language', 'tradu', 'translat', 'i18n', 'locale', 'moeda', 'currency'],
  architecture: [
    'arquitet',
    'architect',
    'padra',
    'pattern',
    'camada',
    'layer',
    'modul',
    'module',
    'monorepo',
    'pacote',
    'package',
    'dependen',
    'decisa',
    'decision',
    'estrutur',
    'structure',
    'convenc',
    'convention',
  ],
};

const conceptEntries = Object.entries(concepts);

/** Lowercase, no accents, words of letters and digits. */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !stopwords.has(word));
}

/** A light stemmer for Portuguese and English plurals and common endings. */
export function stem(word: string): string {
  let value = word;
  for (const suffix of [
    'coes',
    'cao',
    'mente',
    'ings',
    'ing',
    'ados',
    'adas',
    'ado',
    'ada',
    'oes',
    'ies',
    'es',
    's',
    'ed',
  ]) {
    if (value.length - suffix.length >= 4 && value.endsWith(suffix)) {
      value = value.slice(0, -suffix.length);
      break;
    }
  }
  return value;
}

/** Concepts a text touches, for the role and topic affinity used in ranking. */
export function conceptsOf(text: string): Set<string> {
  const found = new Set<string>();
  for (const word of normalizeWords(text))
    for (const [concept, stems] of conceptEntries)
      if (
        stems.some((item) =>
          // Short stems (db, ci, ui…) must be the whole word, or "cidade" would mean CI.
          item.length <= 3
            ? word === item || stem(word) === item
            : word.startsWith(item) || (item.length >= 6 && word.includes(item)),
        )
      )
        found.add(concept);
  return found;
}

function bucket(feature: string): { index: number; sign: number } {
  const digest = createHash('md5').update(feature).digest();
  return { index: digest.readUInt32LE(0) % DIMENSIONS, sign: digest[4]! & 1 ? 1 : -1 };
}

/**
 * Hive's offline embedder: hashed word stems, character trigrams (for typos and inflections) and
 * software concepts. It has no learned weights, so it is weaker than a real embedding model, but it
 * links synonyms the concept table knows about and never needs a network or a paid service.
 */
export class LocalConceptEmbedder implements Embedder {
  readonly model = LOCAL_MODEL;

  embedOne(text: string): Float32Array {
    const vector = new Float32Array(DIMENSIONS);
    const add = (feature: string, weight: number) => {
      const { index, sign } = bucket(feature);
      vector[index] = vector[index]! + sign * weight;
    };
    const words = normalizeWords(text);
    for (const word of words) {
      const root = stem(word);
      add(`w:${root}`, 1);
      const padded = `^${root}$`;
      for (let at = 0; at + 3 <= padded.length; at++) add(`t:${padded.slice(at, at + 3)}`, 0.25);
    }
    for (let at = 0; at + 1 < words.length; at++)
      add(`b:${stem(words[at]!)}_${stem(words[at + 1]!)}`, 0.5);
    for (const concept of conceptsOf(text)) add(`c:${concept}`, 2.2);
    return normalize(vector);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text));
  }
}

/**
 * Embeddings from an OpenAI-compatible provider (a local Ollama or LM Studio costs nothing).
 * Inputs are redacted first, so a key that slipped into a memory never leaves the machine.
 */
export class ProviderEmbedder implements Embedder {
  readonly model: string;

  constructor(
    private readonly client: EmbeddingClient,
    private readonly modelId: string,
    providerId: string,
  ) {
    this.model = `provider:${providerId}:${modelId}`;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const vectors: Float32Array[] = [];
    for (let at = 0; at < texts.length; at += 32) {
      const batch = texts
        .slice(at, at + 32)
        .map((text) => secretRedactor.redact(text).slice(0, 8_000));
      const result = await this.client.embed(
        this.modelId,
        batch,
        signal ?? AbortSignal.timeout(30_000),
      );
      vectors.push(...result.map((values) => normalize(Float32Array.from(values))));
    }
    return vectors;
  }
}

/**
 * The configured embedder, falling back to the local one when it fails. The failure is reported
 * (once per call) and remembered so the block can show the search is degraded.
 */
export class FallbackEmbedder {
  degraded: string | null = null;
  private readonly local = new LocalConceptEmbedder();

  constructor(
    private readonly primary: Embedder | null,
    private readonly onFailure: (message: string) => void = () => {},
  ) {}

  get model(): string {
    return this.primary?.model ?? this.local.model;
  }

  async embed(
    texts: string[],
    signal?: AbortSignal,
  ): Promise<{ model: string; vectors: Float32Array[]; degraded: string | null }> {
    if (this.primary)
      try {
        const vectors = await this.primary.embed(texts, signal);
        this.degraded = null;
        return { model: this.primary.model, vectors, degraded: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        this.degraded = secretRedactor.redact(errorMessage(error)).slice(0, 300);
        this.onFailure(this.degraded);
      }
    return {
      model: this.local.model,
      vectors: await this.local.embed(texts),
      degraded: this.degraded,
    };
  }

  /** The local engine, used when a search already fell back for its query. */
  get fallback(): Embedder {
    return this.local;
  }

  /** The engine that produced `model`: the provider's (which may throw) or the local one. */
  engineFor(model: string): Embedder {
    return this.primary && this.primary.model === model ? this.primary : this.local;
  }
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let index = 0; index < vector.length; index++) vector[index]! /= norm;
  return vector;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let index = 0; index < a.length; index++) dot += a[index]! * b[index]!;
  return dot;
}

/** What is embedded for a memory; its hash tells when the stored vector is stale. */
export function memoryText(memory: {
  kind: string;
  title: string;
  content: string;
  rationale: string;
  tags: string[];
}): string {
  return [memory.title, memory.content, memory.rationale, memory.tags.join(' '), memory.kind].join(
    '\n',
  );
}

export const textHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 24);

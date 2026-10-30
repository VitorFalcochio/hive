import {
  estimateTokens,
  type CortexConfig,
  type CortexMemory,
  type CortexSearchHit,
  type CortexSearchResult,
  type WorkerRole,
} from '@hive/core';
import type { CortexRepository } from '@hive/persistence';
import {
  LOCAL_MODEL,
  conceptsOf,
  cosine,
  memoryText,
  normalizeWords,
  stem,
  textHash,
  type Embedder,
  type FallbackEmbedder,
} from './embeddings';
import { renderMemory } from './sanitize';

/** Topics each role usually needs; a memory on one of them ranks higher for that role. */
const roleTopics: Partial<Record<WorkerRole, string[]>> = {
  frontend: ['ui', 'api', 'auth', 'state', 'validation', 'i18n', 'files', 'user'],
  backend: [
    'api',
    'database',
    'auth',
    'security',
    'access',
    'requirement',
    'error',
    'messaging',
    'payment',
    'performance',
    'user',
  ],
  qa: ['test', 'requirement', 'error', 'validation', 'api', 'access'],
  architect: ['architecture', 'database', 'api', 'deploy', 'security', 'performance', 'config'],
  reviewer: ['architecture', 'security', 'test', 'error', 'performance'],
};

const kindWeight: Record<CortexMemory['kind'], number> = {
  decision: 1,
  api_contract: 0.9,
  convention: 0.8,
  requirement: 0.7,
  fact: 0.5,
  discovery: 0.4,
};

/** Lowest similarity worth returning, per engine: hashed vectors sit lower than learned ones. */
const minSimilarity = (model: string) => (model === LOCAL_MODEL ? 0.1 : 0.25);
const DUPLICATE = 0.92;

/**
 * Vectors of memories, kept in SQLite per model. A memory edited since its vector was made has a
 * different text hash and is embedded again; nothing else is recomputed.
 */
export async function vectorsFor(
  repo: CortexRepository,
  memories: CortexMemory[],
  embedder: Embedder,
  signal?: AbortSignal,
): Promise<Map<string, Float32Array>> {
  const vectors = new Map<string, Float32Array>();
  const missing: { memory: CortexMemory; text: string; hash: string }[] = [];
  for (const memory of memories) {
    const text = memoryText(memory);
    const hash = textHash(text);
    const stored = repo.vector(memory.id, embedder.model);
    if (stored && stored.hash === hash) vectors.set(memory.id, stored.vector);
    else missing.push({ memory, text, hash });
  }
  if (missing.length) {
    const made = await embedder.embed(
      missing.map((item) => item.text),
      signal,
    );
    missing.forEach((item, index) => {
      const vector = made[index]!;
      repo.putVector(item.memory.id, embedder.model, item.hash, vector);
      vectors.set(item.memory.id, vector);
    });
  }
  return vectors;
}

/** Word overlap, for a Cortex with semantic search turned off. */
function keywordSimilarity(query: string, memory: CortexMemory): number {
  const wanted = new Set(normalizeWords(query).map(stem));
  if (!wanted.size) return 0;
  const have = new Set(normalizeWords(memoryText(memory)).map(stem));
  let shared = 0;
  for (const word of wanted) if (have.has(word)) shared++;
  return shared / wanted.size;
}

export interface SearchRequest {
  repo: CortexRepository;
  /** Already filtered to what the reader may see: active memories of its project. */
  memories: CortexMemory[];
  embedder: FallbackEmbedder;
  config: CortexConfig;
  query: string;
  role: WorkerRole | null;
  budgetTokens: number;
  exclude?: ReadonlySet<string>;
  signal?: AbortSignal;
}

/**
 * Finds the memories most related to a query: by meaning (embeddings), then weighted by what the
 * reader's role works on, how recent and how binding the memory is. Near-duplicates are dropped
 * and the result stops at the token budget.
 */
export async function searchMemories(request: SearchRequest): Promise<CortexSearchResult> {
  const { config, memories, query } = request;
  const candidates = memories.filter(
    (memory) => memory.status === 'active' && !request.exclude?.has(memory.id),
  );
  if (!candidates.length || !query.trim())
    return { hits: [], model: request.embedder.model, degraded: null, tokens: 0 };

  let model = 'keyword';
  let degraded: string | null = null;
  const similarity = new Map<string, number>();
  let vectors = new Map<string, Float32Array>();
  if (config.semanticSearch) {
    const asked = await request.embedder.embed([query], request.signal);
    model = asked.model;
    degraded = asked.degraded;
    // The memories go in the same space as the query: the local one when the provider failed.
    const engine = request.embedder.engineFor(asked.model);
    try {
      vectors = await vectorsFor(request.repo, candidates, engine, request.signal);
    } catch {
      // The provider answered the query and then failed: rank everything locally instead.
      model = request.embedder.fallback.model;
      const local = (await request.embedder.fallback.embed([query]))[0]!;
      vectors = await vectorsFor(
        request.repo,
        candidates,
        request.embedder.fallback,
        request.signal,
      );
      for (const memory of candidates)
        similarity.set(memory.id, cosine(local, vectors.get(memory.id)!));
    }
    if (!similarity.size)
      for (const memory of candidates)
        similarity.set(memory.id, cosine(asked.vectors[0]!, vectors.get(memory.id)!));
  } else
    for (const memory of candidates) similarity.set(memory.id, keywordSimilarity(query, memory));

  const topics = new Set(request.role ? (roleTopics[request.role] ?? []) : []);
  const now = Date.now();
  const scored = candidates.map((memory) => {
    const sim = similarity.get(memory.id) ?? 0;
    if (!config.relevanceFiltering) return { memory, similarity: sim, score: sim };
    const forRole =
      (request.role && request.role !== 'queen' && memory.audience.includes(request.role)) ||
      [...conceptsOf(memoryText(memory))].some((concept) => topics.has(concept))
        ? 1
        : 0;
    const ageDays = (now - Date.parse(memory.updatedAt)) / 86_400_000;
    const recency = Math.exp(-Math.max(0, ageDays) / 120);
    const score = 0.72 * sim + 0.1 * forRole + 0.08 * recency + 0.1 * kindWeight[memory.kind] * sim;
    return { memory, similarity: sim, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const floor = model === 'keyword' ? 0.2 : minSimilarity(model);
  const top = scored[0]?.score ?? 0;
  const hits: CortexSearchHit[] = [];
  let tokens = 0;
  for (const hit of scored) {
    if (hits.length >= config.maxResults) break;
    if (hit.similarity < floor) continue;
    if (config.relevanceFiltering && hit.score < top * 0.5) continue;
    if (config.deduplication) {
      const vector = vectors.get(hit.memory.id);
      const repeated =
        vector &&
        hits.some((kept) => {
          const other = vectors.get(kept.memory.id);
          return other ? cosine(vector, other) >= DUPLICATE : false;
        });
      if (repeated) continue;
    }
    const cost = estimateTokens(renderMemory(hit.memory));
    if (tokens + cost > request.budgetTokens) continue;
    tokens += cost;
    hits.push(hit);
  }
  return { hits, model, degraded, tokens };
}

/** Active memories that say about the same thing as a draft, for the reviewer. */
export async function findDuplicates(
  repo: CortexRepository,
  memories: CortexMemory[],
  embedder: FallbackEmbedder,
  draft: {
    kind: CortexMemory['kind'];
    title: string;
    content: string;
    rationale: string;
    tags: string[];
  },
): Promise<{ memoryId: string; score: number }[]> {
  const active = memories.filter((memory) => memory.status === 'active');
  if (!active.length) return [];
  const asked = await embedder.embed([memoryText(draft)]);
  let model = asked.model;
  let query = asked.vectors[0]!;
  let vectors: Map<string, Float32Array>;
  try {
    vectors = await vectorsFor(repo, active, embedder.engineFor(model));
  } catch {
    model = embedder.fallback.model;
    query = (await embedder.fallback.embed([memoryText(draft)]))[0]!;
    vectors = await vectorsFor(repo, active, embedder.fallback);
  }
  const threshold = model === LOCAL_MODEL ? 0.6 : 0.85;
  return active
    .map((memory) => ({ memoryId: memory.id, score: cosine(query, vectors.get(memory.id)!) }))
    .filter((item) => item.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => ({ ...item, score: Math.round(item.score * 1000) / 1000 }));
}

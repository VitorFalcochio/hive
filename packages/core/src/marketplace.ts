import { z } from 'zod';
import { toolNameSchema, workerRoleSchema } from './domain';

/**
 * Hive Marketplace: packages of agents, teams and skills made by the community. A package is
 * declarative only: what an agent is (instructions, tools it asks for, skills) and never what
 * runs on its own or what is personal (keys, models chosen, commands approved in advance, MCP
 * servers, memories). The schema is strict, so a package carrying anything else is refused.
 */

export const MARKETPLACE_SCHEMA_VERSION = 1;

const semver = z.string().regex(/^\d+\.\d+\.\d+$/, 'Use uma versão no formato 1.2.3.');

export const marketplaceCategorySchema = z.enum([
  'agent',
  'team',
  'skill',
  'workflow',
  'template',
  'tool',
]);
export type MarketplaceCategory = z.infer<typeof marketplaceCategorySchema>;

/** What this version of Hive can install: declarative agents, teams and skills. */
export const installableCategories: ReadonlySet<MarketplaceCategory> = new Set([
  'agent',
  'team',
  'skill',
]);

export const marketplaceAgentSchema = z
  .object({
    /** Name of the agent inside the package, for teams and updates. */
    key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Use letras minúsculas, números e hífens.'),
    name: z.string().trim().min(1).max(60),
    role: workerRoleSchema.exclude(['queen']),
    description: z.string().max(500),
    /** The agent's instructions (its system prompt). */
    instructions: z.string().max(20_000),
    tools: z.array(toolNameSchema).max(12),
    skills: z.array(z.string().min(1).max(64)).max(30),
    /** Free text for the user ("um modelo grátis bom em código"); never set on install. */
    recommendedModels: z.array(z.string().max(120)).max(5).default([]),
    /** Bee colour (HEX), the agent's avatar on the canvas. */
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .optional(),
  })
  .strict();
export type MarketplaceAgent = z.infer<typeof marketplaceAgentSchema>;

export const marketplaceSkillSchema = z
  .object({
    name: z.string().min(1).max(64),
    /** The whole SKILL.md: Hive validates it as it does a skill written by hand. */
    raw: z.string().min(1).max(100_000),
  })
  .strict();

export const marketplacePackageSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_SCHEMA_VERSION),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'O id usa letras minúsculas, números e hífens.'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(1_000),
    author: z
      .object({ name: z.string().trim().min(1).max(80), url: z.url().max(300).optional() })
      .strict(),
    version: semver,
    license: z.string().trim().min(1).max(60),
    category: marketplaceCategorySchema,
    tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
    /** The oldest Hive this package works with. */
    minHiveVersion: semver,
    agents: z.array(marketplaceAgentSchema).max(12).default([]),
    skills: z.array(marketplaceSkillSchema).max(20).default([]),
    /** Other packages it needs, installed first by the user. */
    dependencies: z
      .array(z.object({ id: z.string().min(1).max(64), version: semver }).strict())
      .max(10)
      .default([]),
    /**
     * The tools its agents may use, declared up front: every agent's tools must be in here, so
     * the user sees all of it before installing.
     */
    permissions: z.array(toolNameSchema).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    const declared = new Set(value.permissions);
    const keys = new Set<string>();
    value.agents.forEach((agent, index) => {
      if (keys.has(agent.key))
        context.addIssue({
          code: 'custom',
          path: ['agents', index, 'key'],
          message: `Agente repetido: ${agent.key}.`,
        });
      keys.add(agent.key);
      for (const tool of agent.tools)
        if (!declared.has(tool))
          context.addIssue({
            code: 'custom',
            path: ['agents', index, 'tools'],
            message: `O agente “${agent.name}” usa ${tool}, que não está em permissions.`,
          });
    });
    if (value.category === 'agent' && value.agents.length !== 1)
      context.addIssue({
        code: 'custom',
        path: ['agents'],
        message: 'Um pacote de agente traz exatamente um agente.',
      });
    if (value.category === 'team' && value.agents.length < 2)
      context.addIssue({
        code: 'custom',
        path: ['agents'],
        message: 'Uma equipe traz pelo menos dois agentes.',
      });
    if (value.category === 'skill' && (!value.skills.length || value.agents.length))
      context.addIssue({
        code: 'custom',
        path: ['skills'],
        message: 'Um pacote de skill traz skills e nenhum agente.',
      });
  });
export type MarketplacePackage = z.infer<typeof marketplacePackageSchema>;

/** One line of a catalog's index: where the package is and the hash of its exact text. */
export const marketplaceIndexEntrySchema = z
  .object({
    id: z.string().min(1).max(64),
    version: semver,
    /** Relative to the index (a file name in packages/). */
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\w./-]+\.json$/)
      .refine(
        (value) => !value.startsWith('/') && !value.split('/').includes('..'),
        'Caminho fora do catálogo.',
      ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const marketplaceIndexSchema = z
  .object({
    schemaVersion: z.literal(MARKETPLACE_SCHEMA_VERSION),
    packages: z.array(marketplaceIndexEntrySchema).max(2_000),
  })
  .strict();
export type MarketplaceIndex = z.infer<typeof marketplaceIndexSchema>;

/** A package as the Marketplace page shows it. */
export interface MarketplaceListing {
  source: string;
  package: MarketplacePackage;
  /** Whether this Hive can install it, and if not, why. */
  installable: boolean;
  problem: string | null;
  installedVersion: string | null;
  updateAvailable: boolean;
}

/** Every source's packages, and the ones refused (invalid, tampered, with a key inside…). */
export interface MarketplaceCatalog {
  listings: MarketplaceListing[];
  rejected: { source: string; path: string; problem: string }[];
  /** The community catalog's address, when one is set. */
  registryUrl: string | null;
  syncedAt: string | null;
}

/** What installing would do, shown before the user says yes. */
export interface MarketplacePreview {
  listing: MarketplaceListing;
  /** Plain words for each tool the package asks for. */
  permissions: { tool: string; description: string; sensitive: boolean }[];
  /** Skills the package brings, and the ones it uses that this Hive does not have. */
  newSkills: string[];
  keptSkills: string[];
  missingSkills: string[];
  missingDependencies: string[];
  warnings: string[];
}

export interface MarketplaceInstalled {
  packageId: string;
  name: string;
  category: MarketplaceCategory;
  version: string;
  source: string;
  installedAt: string;
  /** Agent key in the package → the worker made from it. */
  workers: Record<string, string>;
  skills: string[];
  /** Earlier versions, newest first, to go back to. */
  history: { version: string; at: string }[];
}

export const marketplaceExportSchema = z
  .object({
    workerIds: z.array(z.string().min(1).max(100)).min(1).max(12),
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'O id usa letras minúsculas, números e hífens.'),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(1_000),
    author: z.string().trim().min(1).max(80),
    version: semver,
    license: z.string().trim().min(1).max(60),
    tags: z.array(z.string().trim().min(1).max(30)).max(12),
    /** Also pack the agents' own local skills (Hive's built-in ones are already everywhere). */
    includeSkills: z.boolean(),
  })
  .strict();
export type MarketplaceExport = z.infer<typeof marketplaceExportSchema>;

/** Compares two versions written as 1.2.3: negative, zero or positive like a sort. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

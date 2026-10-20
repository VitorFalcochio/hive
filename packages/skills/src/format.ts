import { parseDocument } from 'yaml';
import { z } from 'zod';

/**
 * Mirrors SkillForge's portable metadata schema (`@agentskills/core` metadata.ts), which follows
 * the open Agent Skills specification. Kept in sync manually because SkillForge does not publish
 * its packages; see docs/architecture/skillforge.md.
 */
export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Use lowercase ASCII letters, digits, and single hyphens; no leading or trailing hyphen.',
  );

export const skillMetadataSchema = z
  .object({
    name: skillNameSchema,
    description: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value.trim().length > 0, 'Description must not be blank.'),
    license: z.string().min(1).optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    'allowed-tools': z.string().min(1).optional(),
  })
  .passthrough();

export type SkillMetadata = z.infer<typeof skillMetadataSchema>;

export const knownMetadataKeys = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);

export interface ParsedSkill {
  metadata: SkillMetadata;
  body: string;
  bodyOffset: number;
}

export class SkillParseError extends Error {
  constructor(
    readonly code: 'FRONTMATTER' | 'YAML' | 'METADATA',
    message: string,
  ) {
    super(message);
    this.name = 'SkillParseError';
  }
}

export function parseSkillMarkdown(text: string): ParsedSkill {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!match) throw new SkillParseError('FRONTMATTER', 'Start SKILL.md with YAML between two --- lines.');
  let value: unknown;
  try {
    const document = parseDocument(match[1]!, { uniqueKeys: true });
    if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join('; '));
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new SkillParseError(
      'YAML',
      `Fix YAML syntax (aliases are not supported): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = skillMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new SkillParseError(
      'METADATA',
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'frontmatter'}: ${issue.message}`).join('; '),
    );
  }
  return {
    metadata: parsed.data,
    body: normalized.slice(match[0].length),
    bodyOffset: match[0].split('\n').length - 1,
  };
}

export function skillTemplate(name: string, description: string): string {
  return `---
name: ${name}
description: ${JSON.stringify(description)}
license: MIT
---

# ${name
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')}

Describe what this skill helps an agent do, and when it applies.

## Workflow

1. First step.
2. Second step.

## Output

Describe what the agent should deliver.
`;
}

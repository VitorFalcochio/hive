import path from 'node:path';
import type { SkillDiagnostic } from '@hive/core';
import { exists, isWithin, listSkillFiles, readTextFile } from './filesystem';
import { knownMetadataKeys, parseSkillMarkdown, SkillParseError, type ParsedSkill } from './format';

const MAX_BODY_LINES = 500;
const linkPattern = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

function diag(
  severity: SkillDiagnostic['severity'],
  code: string,
  message: string,
  file: string | null = 'SKILL.md',
): SkillDiagnostic {
  return { severity, code, message, file };
}

/** Checks that need only the SKILL.md text (used for drafts in the editor, too). */
export function validateSkillText(
  raw: string,
  expectedName: string | null,
): { parsed: ParsedSkill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  let parsed: ParsedSkill;
  try {
    parsed = parseSkillMarkdown(raw);
  } catch (error) {
    const code = error instanceof SkillParseError ? error.code : 'PARSE';
    diagnostics.push(diag('error', code, error instanceof Error ? error.message : String(error)));
    return { parsed: null, diagnostics };
  }
  if (expectedName && parsed.metadata.name !== expectedName) {
    diagnostics.push(
      diag(
        'error',
        'NAME_MISMATCH',
        `Skill name "${parsed.metadata.name}" must match its folder "${expectedName}".`,
      ),
    );
  }
  for (const key of Object.keys(parsed.metadata)) {
    if (!knownMetadataKeys.has(key)) {
      diagnostics.push(
        diag(
          'warning',
          'UNSUPPORTED_FIELD',
          `Frontmatter field "${key}" is not part of the portable format.`,
        ),
      );
    }
  }
  if (parsed.metadata['allowed-tools']) {
    diagnostics.push(
      diag(
        'warning',
        'EXPERIMENTAL_TOOLS',
        '`allowed-tools` is experimental. Hive enforces tool permissions per worker, not per skill.',
      ),
    );
  }
  const body = parsed.body.trim();
  if (!body)
    diagnostics.push(
      diag('warning', 'EMPTY_BODY', 'The skill has no instructions after the frontmatter.'),
    );
  const lines = parsed.body.split('\n').length;
  if (lines > MAX_BODY_LINES) {
    diagnostics.push(
      diag(
        'warning',
        'LONG_BODY',
        `Body has ${lines} lines; move detail into references/ (limit ${MAX_BODY_LINES}).`,
      ),
    );
  }
  return { parsed, diagnostics };
}

/** Full validation of a skill directory on disk. Never executes anything in the skill. */
export async function validateSkillDirectory(directory: string): Promise<SkillDiagnostic[]> {
  const diagnostics: SkillDiagnostic[] = [];
  const skillFile = path.join(directory, 'SKILL.md');
  if (!(await exists(skillFile))) {
    return [diag('error', 'MISSING_SKILL_MD', 'Directory has no SKILL.md.', null)];
  }
  let files: { relative: string }[];
  try {
    files = await listSkillFiles(directory);
  } catch (error) {
    return [diag('error', 'LIMITS', error instanceof Error ? error.message : String(error), null)];
  }
  const raw = await readTextFile(skillFile);
  const text = validateSkillText(raw, path.basename(directory));
  diagnostics.push(...text.diagnostics);
  if (files.some((file) => file.relative.startsWith('scripts/'))) {
    diagnostics.push(
      diag(
        'warning',
        'SCRIPTS_PRESENT',
        'This skill ships scripts. Hive never executes skill scripts; agents only read them.',
        'scripts/',
      ),
    );
  }
  if (text.parsed) {
    for (const match of text.parsed.body.matchAll(linkPattern)) {
      const reference = match[1]!;
      if (/^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('#')) continue;
      const target = decodeURIComponent(reference.split('#')[0]!);
      if (!target) continue;
      if (path.isAbsolute(target) || /^[a-z]:/i.test(target)) {
        diagnostics.push(
          diag('error', 'ABSOLUTE_REFERENCE', `Use a relative path inside the skill: ${reference}`),
        );
        continue;
      }
      const resolved = path.resolve(directory, target);
      if (!isWithin(directory, resolved)) {
        diagnostics.push(
          diag('error', 'REFERENCE_ESCAPES', `Reference escapes the skill directory: ${reference}`),
        );
      } else if (!(await exists(resolved))) {
        diagnostics.push(
          diag('error', 'BROKEN_REFERENCE', `Referenced file does not exist: ${reference}`),
        );
      }
    }
  }
  return diagnostics;
}

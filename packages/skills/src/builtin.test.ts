import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rolePresets } from '@hive/core';
import { SkillForgeAdapter } from './adapter';
import { builtinSkillNames, builtinSkills } from './builtin';
import { validateSkillText } from './validator';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function library() {
  const libraryDir = await mkdtemp(path.join(os.tmpdir(), 'hive-skills-'));
  folders.push(libraryDir);
  return {
    libraryDir,
    adapter: new SkillForgeAdapter({ catalogPath: null, libraryDir, cliValidation: false }),
  };
}

describe('skills de fábrica', () => {
  it('são válidas, curtas e com nomes únicos', () => {
    expect(new Set(builtinSkillNames).size).toBe(builtinSkills.length);
    for (const skill of builtinSkills) {
      const { parsed, diagnostics } = validateSkillText(skill.raw, skill.name);
      expect(diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
      expect(parsed?.metadata.name).toBe(skill.name);
      // Every step carries the agent's skills in its prompt.
      expect(skill.raw.length).toBeLessThan(4_000);
    }
  });

  it('cobrem todas as skills que os papéis pedem', () => {
    for (const preset of Object.values(rolePresets))
      for (const name of preset.skills) expect(builtinSkillNames).toContain(name);
  });

  it('instalam uma vez, sem sobrescrever edições, e podem ser restauradas', async () => {
    const { adapter, libraryDir } = await library();
    expect(await adapter.installBuiltins(['revisar-codigo', 'nao-existe'])).toEqual([
      'revisar-codigo',
    ]);
    const file = path.join(libraryDir, 'revisar-codigo', 'SKILL.md');
    const [listed] = await adapter.listLocal();
    expect(listed).toMatchObject({ name: 'revisar-codigo', builtin: true, modified: false });

    await writeFile(file, `${await readFile(file, 'utf8')}\nRegra minha.\n`);
    expect(await adapter.installBuiltins(['revisar-codigo'])).toEqual([]);
    expect(await readFile(file, 'utf8')).toContain('Regra minha.');
    expect((await adapter.listLocal())[0]).toMatchObject({ builtin: true, modified: true });

    await adapter.restoreBuiltin('revisar-codigo');
    expect(await readFile(file, 'utf8')).not.toContain('Regra minha.');
    expect((await adapter.listLocal())[0]).toMatchObject({ modified: false });
  });
});

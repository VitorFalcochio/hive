import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rolePresets } from '@hive/core';
import { SkillForgeAdapter } from './adapter';
import {
  builtinSkillNames,
  builtinSkills,
  retiredSkill,
  retiredSkillReplacements,
} from './builtin';
import { parseSkillMarkdown } from './format';
import { validateSkillDirectory, validateSkillText } from './validator';

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
  it('são válidas, com nomes únicos, e dizem de quem vieram e sob qual licença', () => {
    expect(new Set(builtinSkillNames).size).toBe(builtinSkills.length);
    for (const skill of builtinSkills) {
      const { parsed, diagnostics } = validateSkillText(skill.raw, skill.name);
      expect(
        diagnostics.filter((item) => item.severity === 'error'),
        skill.name,
      ).toEqual([]);
      expect(parsed?.metadata.name).toBe(skill.name);
      expect(['Superpowers', 'Addy Osmani', 'Anthropic']).toContain(
        parsed?.metadata.metadata?.origin,
      );
      expect(parsed?.metadata.metadata?.source).toMatch(/^https:\/\/github\.com\//);
      // The author's license ships beside every imported skill.
      expect(skill.files['LICENSE.txt'], skill.name).toMatch(/MIT License|Apache License/);
    }
  });

  it('cobrem todas as skills que os papéis pedem, e as antigas têm para onde ir', () => {
    for (const preset of Object.values(rolePresets))
      for (const name of preset.skills) expect(builtinSkillNames).toContain(name);
    for (const [old, replacements] of Object.entries(retiredSkillReplacements)) {
      expect(retiredSkill(old), old).toBeDefined();
      for (const name of replacements) expect(builtinSkillNames).toContain(name);
    }
  });

  it('todo arquivo que uma skill cita está junto dela', () => {
    for (const skill of builtinSkills) {
      const { body } = parseSkillMarkdown(skill.raw);
      for (const [, file] of body.matchAll(/`((?:references\/)?[a-z-]+\.md)`/g))
        if (file !== 'SKILL.md')
          expect(Object.keys(skill.files), `${skill.name}: ${file}`).toContain(file);
    }
  });

  it('instalam com os arquivos de apoio, sem sobrescrever edições, e podem ser restauradas', async () => {
    const { adapter, libraryDir } = await library();
    expect(await adapter.installBuiltins(['systematic-debugging', 'nao-existe'])).toEqual([
      'systematic-debugging',
    ]);
    const folder = path.join(libraryDir, 'systematic-debugging');
    const file = path.join(folder, 'SKILL.md');
    const [listed] = await adapter.listLocal();
    expect(listed).toMatchObject({
      name: 'systematic-debugging',
      builtin: true,
      modified: false,
      origin: 'Superpowers',
      license: 'MIT',
    });
    expect(listed?.resources).toEqual(
      expect.arrayContaining(['LICENSE.txt', 'root-cause-tracing.md', 'defense-in-depth.md']),
    );
    expect((await validateSkillDirectory(folder)).filter((d) => d.severity === 'error')).toEqual(
      [],
    );

    await writeFile(file, `${await readFile(file, 'utf8')}\nRegra minha.\n`);
    expect(await adapter.installBuiltins(['systematic-debugging'])).toEqual([]);
    expect(await readFile(file, 'utf8')).toContain('Regra minha.');
    expect((await adapter.listLocal())[0]).toMatchObject({ builtin: true, modified: true });

    await adapter.restoreBuiltin('systematic-debugging');
    expect(await readFile(file, 'utf8')).not.toContain('Regra minha.');
    expect((await adapter.listLocal())[0]).toMatchObject({ modified: false });
  });

  it('removem as antigas que ninguém editou e deixam as editadas', async () => {
    const { adapter, libraryDir } = await library();
    for (const name of ['revisar-codigo', 'escrever-testes']) {
      await mkdir(path.join(libraryDir, name), { recursive: true });
      await writeFile(path.join(libraryDir, name, 'SKILL.md'), retiredSkill(name)!.raw);
    }
    const edited = path.join(libraryDir, 'escrever-testes', 'SKILL.md');
    await writeFile(edited, `${await readFile(edited, 'utf8')}\nRegra minha.\n`);

    expect(await adapter.removeRetired(['revisar-codigo', 'escrever-testes'])).toEqual([
      'revisar-codigo',
    ]);
    expect((await adapter.listLocal()).map((skill) => skill.name)).toEqual(['escrever-testes']);
  });
});

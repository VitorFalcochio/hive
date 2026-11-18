import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HiveDatabase } from '@hive/persistence';
import { retiredSkill, retiredSkillReplacements } from '@hive/skills';
import { DesktopService } from './service';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it('troca as skills antigas pelas novas nos agentes, uma vez, e guarda as que o usuário editou', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hive-skills-migration-'));
  const library = path.join(dataDir, 'skills');
  // A Hive 0.2.2 library: the old skills, one of them edited by the user.
  const old = Object.keys(retiredSkillReplacements);
  for (const name of old) {
    await mkdir(path.join(library, name), { recursive: true });
    await writeFile(path.join(library, name, 'SKILL.md'), retiredSkill(name)!.raw);
  }
  const edited = path.join(library, 'revisar-codigo', 'SKILL.md');
  await writeFile(edited, `${await readFile(edited, 'utf8')}\nRegra minha.\n`);

  const db = new HiveDatabase(':memory:');
  const service = new DesktopService(db, dataDir, () => undefined);
  cleanups.push(() => {
    service.dispose();
    db.close();
  });
  const byRole = (role: string) => service.repos.workers.list().find((w) => w.role === role)!;
  // The team as 0.2.2 left it: old names on the agents, old built-ins already installed.
  const oldTeam: Record<string, string[]> = {
    frontend: ['interface-de-qualidade', 'depurar-sistematicamente', 'verificar-antes-de-concluir'],
    reviewer: ['revisar-codigo', 'seguranca-no-codigo'],
  };
  for (const [role, skills] of Object.entries(oldTeam))
    service.repos.workers.put({ ...byRole(role), skills });
  service.repos.setValue('builtinSkills', JSON.stringify(old));

  await service.installBuiltinSkills();

  expect(byRole('frontend').skills.sort()).toEqual(
    [
      'accessibility-engineering',
      'frontend-design',
      'frontend-ui-engineering',
      'systematic-debugging',
      'verification-before-completion',
    ].sort(),
  );
  // The edited skill stays, on its agent and in the library, beside the new ones.
  expect(byRole('reviewer').skills).toContain('revisar-codigo');
  expect(byRole('reviewer').skills).toEqual(
    expect.arrayContaining([
      'code-review-and-quality',
      'code-simplification',
      'security-and-hardening',
    ]),
  );
  expect(byRole('reviewer').skills).not.toContain('seguranca-no-codigo');
  const folders = await readdir(library);
  expect(folders).toContain('revisar-codigo');
  expect(folders).not.toContain('depurar-sistematicamente');
  expect(folders).toContain('systematic-debugging');
  expect(
    await readFile(path.join(library, 'systematic-debugging', 'LICENSE.txt'), 'utf8'),
  ).toContain('MIT License');

  // Only once: an agent the user changes afterwards is left as it is.
  service.repos.workers.put({ ...byRole('frontend'), skills: ['frontend-design'] });
  await service.installBuiltinSkills();
  expect(byRole('frontend').skills).toEqual(['frontend-design']);
});

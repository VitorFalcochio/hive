import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { secretRedactor } from '@hive/shared';
import { git } from '../git';
import {
  GitManager,
  classifyGitFailure,
  type GitApprovalRequest,
  type GitAuditEntry,
} from './manager';
import { assertBranchName, assertRemoteUrl, literalPathspecs, repoRelativePath } from './validate';

/*
 * Real repositories in temporary folders, with a bare repository as the remote. Git's global
 * and system settings are switched off so the machine's own identity or hooks never matter.
 */
const saved: Record<string, string | undefined> = {};
beforeAll(async () => {
  const empty = path.join(await mkdtemp(path.join(os.tmpdir(), 'hive-gitcfg-')), 'config');
  await writeFile(empty, '');
  for (const [key, value] of Object.entries({
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: os.tmpdir(),
  })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

const exists = (target: string) =>
  access(target).then(
    () => true,
    () => false,
  );

function harness(answer: boolean | ((request: GitApprovalRequest) => boolean) = true) {
  const asked: GitApprovalRequest[] = [];
  const audit: GitAuditEntry[] = [];
  const manager = new GitManager({
    approve: async (request) => {
      asked.push(request);
      return typeof answer === 'function' ? answer(request) : answer;
    },
    audit: (entry) => audit.push(entry),
  });
  return { manager, asked, audit };
}

async function identity(root: string) {
  await git(root, ['config', 'user.name', 'Pessoa Teste']);
  await git(root, ['config', 'user.email', 'pessoa@hive.local']);
}

/** A bare remote with one commit on main, and a clone of it ready to work in. */
async function project(manager: GitManager) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'hive-gm-'));
  const remote = path.join(base, 'remote.git');
  await git(base, ['init', '-q', '--bare', '-b', 'main', remote]);
  const seed = path.join(base, 'seed');
  await mkdir(seed);
  await git(seed, ['init', '-q', '-b', 'main']);
  await identity(seed);
  await writeFile(path.join(seed, 'app.txt'), 'um\ndois\ntrês\n');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-q', '-m', 'inicio']);
  await git(seed, ['push', '-q', remote, 'main']);
  const root = await manager.clone(remote, base, 'work');
  await identity(root);
  return { base, remote, root };
}

/** A second clone that publishes a commit, as a colleague would. */
async function colleagueCommits(base: string, remote: string, file: string, text: string) {
  const other = path.join(base, `colega-${Math.random().toString(36).slice(2)}`);
  await git(base, ['clone', '-q', remote, other]);
  await identity(other);
  await writeFile(path.join(other, file), text);
  await git(other, ['add', '-A']);
  await git(other, ['commit', '-q', '-m', `colega muda ${file}`]);
  await git(other, ['push', '-q', 'origin', 'main']);
}

describe('validação do que chega ao git', () => {
  it('recusa nomes de branch que o git leria como opção ou que ele mesmo recusaria', () => {
    for (const bad of [
      '-f',
      '--orphan',
      'a..b',
      'a b',
      'x~1',
      'x^',
      'a:b',
      'x.lock',
      '.oculta',
      'fim/',
      '/ini',
      'HEAD',
      '@',
      'a@{1}',
      'a\\b',
      '',
    ])
      expect(() => assertBranchName(bad), bad).toThrow();
    for (const good of ['main', 'feature/login', 'hive/run-1/tarefa-2', 'fix_42', 'v1.2'])
      expect(assertBranchName(good)).toBe(good);
  });

  it('só aceita caminhos dentro do projeto, sempre como literais', () => {
    for (const bad of [
      '../fora',
      'a/../../fora',
      '/etc/passwd',
      'C:\\Windows',
      '.git/config',
      'sub/.git/HEAD',
      '',
    ])
      expect(() => repoRelativePath(bad), bad).toThrow();
    expect(repoRelativePath('src\\app.ts')).toBe('src/app.ts');
    expect(literalPathspecs(['*.ts', ':(exclude)x'])).toEqual([
      '--',
      ':(literal)*.ts',
      ':(literal):(exclude)x',
    ]);
  });

  it('recusa URLs com credencial, transportes que executam programas e opções', () => {
    for (const bad of [
      'https://usuario:ghp_segredo@github.com/a/b.git',
      'https://ghp_segredo@github.com/a/b.git',
      'ext::sh -c touch% /tmp/x',
      'fd::17',
      '--upload-pack=touch /tmp/x',
      'http://github.com/a/b.git',
      'ftp://x/y',
    ])
      expect(() => assertRemoteUrl(bad), bad).toThrow();
    for (const good of [
      'https://github.com/a/b.git',
      'git@github.com:a/b.git',
      'ssh://git@host/a/b.git',
      'file:///tmp/r.git',
      'C:\\Users\\Ana Maria\\repo.git',
      '/home/ana maria/repo.git',
    ])
      expect(assertRemoteUrl(good)).toBe(good);
  });
});

describe('GitManager', { timeout: 60_000 }, () => {
  it('mostra o status, faz stage só do que foi escolhido, commit e histórico', async () => {
    const { manager, audit } = harness();
    const { root } = await project(manager);
    await writeFile(path.join(root, 'app.txt'), 'um\nDOIS\ntrês\n');
    await writeFile(path.join(root, 'novo.txt'), 'novo\n');
    await writeFile(path.join(root, 'outro.txt'), 'não entra\n');

    const before = await manager.status(root);
    expect(before).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
      merging: false,
    });
    expect(before.files.map((f) => [f.path, f.untracked]).sort()).toEqual([
      ['app.txt', false],
      ['novo.txt', true],
      ['outro.txt', true],
    ]);
    expect(await manager.diff(root, 'app.txt')).toContain('+DOIS');

    await manager.stage(root, ['app.txt', 'novo.txt']);
    const staged = await manager.status(root);
    expect(
      staged.files
        .filter((f) => f.staged)
        .map((f) => f.path)
        .sort(),
    ).toEqual(['app.txt', 'novo.txt']);
    expect(staged.files.find((f) => f.path === 'outro.txt')!.untracked).toBe(true);
    await manager.unstage(root, ['novo.txt']);
    expect((await manager.status(root)).files.filter((f) => f.staged).map((f) => f.path)).toEqual([
      'app.txt',
    ]);

    const hash = await manager.commit(root, 'Muda o dois');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
    const log = await manager.log(root, { limit: 5 });
    expect(log.map((c) => c.subject)).toEqual(['Muda o dois', 'inicio']);
    expect(log[0]!.author).toBe('Pessoa Teste');
    expect((await manager.status(root)).ahead).toBe(1);
    // Every change is in the audit trail; reads are not.
    expect(audit.map((e) => `${e.op}:${e.outcome}`)).toEqual([
      'clone:ok',
      'stage:ok',
      'unstage:ok',
      'commit:ok',
    ]);
  });

  it('não faz commit sem nada preparado, nem sem identidade configurada', async () => {
    const { manager } = harness();
    const { root } = await project(manager);
    await expect(manager.commit(root, 'vazio')).rejects.toMatchObject({ code: 'VALIDATION' });
    await git(root, ['config', '--unset', 'user.email']);
    await writeFile(path.join(root, 'a.txt'), 'a');
    await manager.stage(root, ['a.txt']);
    await expect(manager.commit(root, 'sem e-mail')).rejects.toThrow(/Configure seu nome e e-mail/);
  });

  it('não interpreta nomes de arquivo como opções nem como padrões', async () => {
    const { manager } = harness();
    const { root } = await project(manager);
    await writeFile(path.join(root, 'a.txt'), 'a');
    await writeFile(path.join(root, 'b.txt'), 'b');
    await expect(manager.stage(root, ['--all'])).rejects.toMatchObject({ code: 'GIT' });
    await expect(manager.stage(root, ['*.txt'])).rejects.toMatchObject({ code: 'GIT' });
    await expect(manager.stage(root, ['../fora.txt'])).rejects.toMatchObject({
      code: 'FORBIDDEN_PATH',
    });
    await expect(manager.checkout(root, '-f')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect((await manager.status(root)).files.some((f) => f.staged)).toBe(false);
  });

  it('pede aprovação para publicar; negado, nada chega ao remote', async () => {
    const denied = harness(false);
    const { root, remote } = await project(denied.manager);
    await writeFile(path.join(root, 'app.txt'), 'mudou\n');
    await denied.manager.stage(root, ['app.txt']);
    await denied.manager.commit(root, 'Local');
    const remoteHead = (await git(remote, ['rev-parse', 'main'])).stdout.trim();

    await expect(denied.manager.push(root)).rejects.toMatchObject({ code: 'DENIED' });
    expect(denied.asked).toEqual([
      expect.objectContaining({
        op: 'push',
        kind: 'publish',
        summary: 'Publicar 1 commit(s) de main em origin',
      }),
    ]);
    expect((await git(remote, ['rev-parse', 'main'])).stdout.trim()).toBe(remoteHead);
    expect(denied.audit.at(-1)).toMatchObject({ op: 'push', approval: 'denied', outcome: 'error' });

    const approved = new GitManager({ approve: async () => true });
    await approved.push(root);
    expect((await git(remote, ['rev-parse', 'main'])).stdout.trim()).toBe(
      (await git(root, ['rev-parse', 'HEAD'])).stdout.trim(),
    );
  });

  it('atualiza só por fast-forward e avisa quando as branches divergiram', async () => {
    const { manager } = harness();
    const { root, base, remote } = await project(manager);
    await colleagueCommits(base, remote, 'colega.txt', 'oi\n');
    await manager.fetch(root);
    expect((await manager.status(root)).behind).toBe(1);
    expect(await manager.pull(root)).toEqual({ conflicts: [] });
    expect(await readFile(path.join(root, 'colega.txt'), 'utf8')).toBe('oi\n');

    await colleagueCommits(base, remote, 'colega2.txt', 'de novo\n');
    await writeFile(path.join(root, 'meu.txt'), 'meu\n');
    await manager.stage(root, ['meu.txt']);
    await manager.commit(root, 'Meu');
    await manager.fetch(root);
    await expect(manager.pull(root)).rejects.toMatchObject({ code: 'CONFLICT' });
    // Nothing was merged behind the user's back.
    expect((await manager.status(root)).merging).toBe(false);
  });

  it('mostra conflitos de merge e resolve à mão, por um lado com aprovação, ou aborta', async () => {
    const { manager, asked } = harness();
    const { root, base, remote } = await project(manager);
    await colleagueCommits(base, remote, 'app.txt', 'um\nDELES\ntrês\n');
    await writeFile(path.join(root, 'app.txt'), 'um\nMEU\ntrês\n');
    await manager.stage(root, ['app.txt']);
    await manager.commit(root, 'Meu dois');
    await manager.fetch(root);

    expect(await manager.pull(root, { merge: true })).toEqual({ conflicts: ['app.txt'] });
    const status = await manager.status(root);
    expect(status.merging).toBe(true);
    expect(status.files.find((f) => f.path === 'app.txt')!.conflicted).toBe(true);
    await expect(manager.commit(root, 'cedo')).rejects.toMatchObject({ code: 'CONFLICT' });
    // Still has conflict markers: not accepted as resolved.
    await expect(manager.resolve(root, 'app.txt', 'manual')).rejects.toThrow(/marcas de conflito/);

    asked.length = 0;
    await manager.resolve(root, 'app.txt', 'theirs');
    expect(asked.map((r) => r.op)).toEqual(['resolve.theirs']);
    expect(await readFile(path.join(root, 'app.txt'), 'utf8')).toBe('um\nDELES\ntrês\n');
    await manager.commit(root, 'Merge com o colega');
    expect((await manager.status(root)).merging).toBe(false);

    // And a merge can be given up, with approval, back to how things were.
    await colleagueCommits(base, remote, 'app.txt', 'um\nOUTRA\ntrês\n');
    await writeFile(path.join(root, 'app.txt'), 'um\nMINHA\ntrês\n');
    await manager.stage(root, ['app.txt']);
    await manager.commit(root, 'Minha');
    await manager.fetch(root);
    await manager.pull(root, { merge: true });
    asked.length = 0;
    await manager.abortMerge(root);
    expect(asked.map((r) => r.kind)).toEqual(['destructive']);
    expect((await manager.status(root)).merging).toBe(false);
    expect(await readFile(path.join(root, 'app.txt'), 'utf8')).toBe('um\nMINHA\ntrês\n');
  });

  it('exclui branches com segurança: nunca a atual nem as protegidas; não integradas só com aprovação', async () => {
    const { manager, asked } = harness();
    const { root } = await project(manager);
    await expect(manager.deleteBranch(root, 'main')).rejects.toMatchObject({ code: 'CONFLICT' });
    await manager.createBranch(root, 'feature/a');
    await manager.createBranch(root, 'feature/b', { switchTo: true });
    await writeFile(path.join(root, 'b.txt'), 'b');
    await manager.stage(root, ['b.txt']);
    await manager.commit(root, 'Trabalho em b');
    await expect(manager.deleteBranch(root, 'main')).rejects.toMatchObject({ code: 'DENIED' });

    await manager.checkout(root, 'main');
    asked.length = 0;
    await manager.deleteBranch(root, 'feature/a');
    expect(asked).toEqual([]);
    await manager.deleteBranch(root, 'feature/b');
    expect(asked.map((r) => [r.op, r.kind])).toEqual([['branch.delete', 'destructive']]);
    expect((await manager.branches(root)).local.map((b) => b.name)).toEqual(['main']);
  });

  it('não troca de branch com alterações não commitadas', async () => {
    const { manager } = harness();
    const { root } = await project(manager);
    await manager.createBranch(root, 'outra');
    await writeFile(path.join(root, 'app.txt'), 'sujo\n');
    await expect(manager.checkout(root, 'outra')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('descarta alterações só com aprovação e nunca apaga arquivo novo', async () => {
    const { manager, asked } = harness();
    const { root } = await project(manager);
    await writeFile(path.join(root, 'app.txt'), 'estraguei\n');
    await writeFile(path.join(root, 'novo.txt'), 'novo\n');
    await expect(manager.discard(root, ['novo.txt'])).rejects.toMatchObject({ code: 'VALIDATION' });
    await manager.discard(root, ['app.txt']);
    expect(asked.map((r) => r.kind)).toEqual(['destructive']);
    expect(await readFile(path.join(root, 'app.txt'), 'utf8')).toBe('um\ndois\ntrês\n');
    expect(await exists(path.join(root, 'novo.txt'))).toBe(true);
  });

  it('agentes alteram a branch principal só com aprovação; nas próprias branches, não', async () => {
    const { manager, asked } = harness();
    const { root } = await project(manager);
    const agent = { kind: 'agent' as const, id: 'w1', name: 'Dev' };
    await writeFile(path.join(root, 'a.txt'), 'a');
    await manager.stage(root, ['a.txt'], { actor: agent });
    await manager.commit(root, 'Do agente na main', { actor: agent });
    expect(asked.map((r) => [r.op, r.actor.kind])).toEqual([['commit', 'agent']]);

    asked.length = 0;
    await manager.createBranch(root, 'hive/tarefa-1', { switchTo: true, actor: agent });
    await writeFile(path.join(root, 'b.txt'), 'b');
    await manager.stage(root, ['b.txt'], { actor: agent });
    await manager.commit(root, 'Do agente na própria branch', { actor: agent });
    expect(asked).toEqual([]);
  });

  it('roda uma operação de cada vez por repositório, inclusive entre worktrees de agentes', async () => {
    const { manager } = harness();
    const { root, base } = await project(manager);
    const worktrees = await Promise.all(
      [1, 2, 3].map(async (n) => {
        const dir = path.join(base, `wt-${n}`);
        await git(root, ['worktree', 'add', '-q', '-b', `hive/agente-${n}`, dir]);
        return dir;
      }),
    );
    await Promise.all(
      worktrees.map(async (dir, n) => {
        for (let i = 0; i < 3; i++) {
          await writeFile(path.join(dir, `agente-${n}-${i}.txt`), `${i}`);
          await manager.stage(dir, [`agente-${n}-${i}.txt`]);
          await manager.commit(dir, `agente ${n} passo ${i}`);
        }
      }),
    );
    // Twenty stages of the same repository at once: no "index.lock exists" failure.
    const files = Array.from({ length: 20 }, (_, i) => `lote-${i}.txt`);
    await Promise.all(files.map((name) => writeFile(path.join(root, name), name)));
    await Promise.all(files.map((name) => manager.stage(root, [name])));
    expect((await manager.status(root)).files.filter((f) => f.staged)).toHaveLength(20);
    for (const [n, dir] of worktrees.entries())
      expect(
        (await manager.log(dir, { limit: 10 })).filter((c) => c.subject.startsWith(`agente ${n} `)),
      ).toHaveLength(3);
  });

  it('cancela uma operação em andamento e deixa o repositório utilizável', async () => {
    const { manager, audit } = harness();
    const { root } = await project(manager);
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nnode -e "setTimeout(() => {}, 4000)"\n');
    await chmod(hook, 0o755);
    await writeFile(path.join(root, 'a.txt'), 'a');
    await manager.stage(root, ['a.txt']);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    await expect(
      manager.commit(root, 'Lento', { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(audit.at(-1)).toMatchObject({ op: 'commit', outcome: 'cancelled' });
    expect(await exists(path.join(root, '.git', 'index.lock'))).toBe(false);

    await writeFile(hook, '#!/bin/sh\nexit 0\n');
    await manager.commit(root, 'Depois do cancelamento');
    expect((await manager.log(root, { limit: 1 }))[0]!.subject).toBe('Depois do cancelamento');
  });

  it('um clone que falha não deixa pasta para trás', async () => {
    const { manager, audit } = harness();
    const base = await mkdtemp(path.join(os.tmpdir(), 'hive-gm-'));
    await expect(
      manager.clone(path.join(base, 'nao-existe.git'), base, 'copia'),
    ).rejects.toBeTruthy();
    expect(await exists(path.join(base, 'copia'))).toBe(false);
    expect(audit.at(-1)).toMatchObject({ op: 'clone', outcome: 'error' });
  });

  it('distingue falha de rede e nunca deixa credencial vazar em erro ou auditoria', async () => {
    const secret = 'ghp_TokenFalsoDeTeste1234567890abcdef';
    secretRedactor.register(secret);
    try {
      const audit: GitAuditEntry[] = [];
      const manager = new GitManager({
        approve: async () => true,
        audit: (entry) => audit.push(entry),
        remoteEnv: async () => ({
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: 'http.extraHeader',
          GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}`,
        }),
      });
      const { root } = await project(manager);
      // Nothing listens on port 9 of this machine: the connection is refused at once.
      await manager.addRemote(root, 'fora', 'https://127.0.0.1:9/a/b.git');
      const failure = await manager
        .fetch(root, { remote: 'fora' })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'NETWORK' });
      expect(String((failure as Error).message)).not.toContain(secret);
      expect(JSON.stringify(audit)).not.toContain(secret);
      // A token never gets into the repository's configuration.
      expect(await readFile(path.join(root, '.git', 'config'), 'utf8')).not.toContain(secret);
      await expect(
        manager.addRemote(root, 'x', `https://u:${secret}@github.com/a/b.git`),
      ).rejects.toThrow(/não coloque usuário ou token/);
      expect(JSON.stringify(audit)).not.toContain(secret);
    } finally {
      secretRedactor.unregister(secret);
    }
  });
});

describe('classificação das falhas do git', () => {
  it('reconhece autenticação, rede, branch protegida e divergência', () => {
    expect(
      classifyGitFailure(
        'push',
        "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'",
      ).code,
    ).toBe('AUTH');
    expect(
      classifyGitFailure(
        'fetch',
        'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      ).code,
    ).toBe('AUTH');
    expect(
      classifyGitFailure(
        'fetch',
        "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403",
      ).code,
    ).toBe('AUTH');
    expect(
      classifyGitFailure('fetch', "fatal: unable to access 'https://x/': Could not resolve host: x")
        .code,
    ).toBe('NETWORK');
    expect(
      classifyGitFailure(
        'push',
        'remote: error: GH006: Protected branch update failed for refs/heads/main.',
      ).code,
    ).toBe('DENIED');
    expect(classifyGitFailure('push', ' ! [rejected]        main -> main (fetch first)').code).toBe(
      'CONFLICT',
    );
    expect(classifyGitFailure('status', 'fatal: something else').code).toBe('GIT');
  });

  it('apaga segredos conhecidos da mensagem', () => {
    const secret = 'ghp_OutroTokenFalso0987654321zyxw';
    secretRedactor.register(secret);
    try {
      expect(
        classifyGitFailure('push', `fatal: Authentication failed for token ${secret}`).message,
      ).not.toContain(secret);
    } finally {
      secretRedactor.unregister(secret);
    }
  });
});

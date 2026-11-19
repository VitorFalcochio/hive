import path from 'node:path';
import { HiveError } from '@hive/shared';

/*
 * Everything that reaches git from the user, an agent or the renderer goes through here first.
 * git runs without a shell, so the risks left are arguments read as options ("-f"), paths that
 * leave the repository, pathspec magic, and remote URLs that run programs or carry credentials.
 */

const MAX_REF = 250;

/**
 * A branch name as `git check-ref-format --branch` would accept it, and never one git could
 * read as an option. Checked here so a bad name fails before any process starts.
 */
export function assertBranchName(name: string): string {
  const value = typeof name === 'string' ? name.trim() : '';
  const bad = (reason: string) =>
    new HiveError('VALIDATION', `Nome de branch inválido "${value.slice(0, 80)}": ${reason}.`);
  if (!value) throw bad('vazio');
  if (value.length > MAX_REF) throw bad('longo demais');
  if (value.startsWith('-')) throw bad('não pode começar com "-"');
  if (value === '@' || value === 'HEAD') throw bad('nome reservado');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/.test(value)) throw bad('caractere não permitido');
  if (value.includes('..') || value.includes('@{') || value.includes('//'))
    throw bad('sequência não permitida');
  if (value.startsWith('/') || value.endsWith('/') || value.endsWith('.'))
    throw bad('começo ou fim não permitido');
  if (value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')))
    throw bad('parte começando com "." ou terminando em ".lock"');
  return value;
}

/** A remote name such as "origin". */
export function assertRemoteName(name: string): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value))
    throw new HiveError('VALIDATION', `Nome de remote inválido: "${value.slice(0, 80)}".`);
  return value;
}

/** A full or abbreviated commit id. */
export function assertCommitId(id: string): string {
  const value = typeof id === 'string' ? id.trim() : '';
  if (!/^[0-9a-f]{4,64}$/i.test(value))
    throw new HiveError('VALIDATION', `Identificador de commit inválido: "${value.slice(0, 80)}".`);
  return value;
}

/**
 * A path inside the repository, relative and with forward slashes. Absolute paths, ".." and
 * the .git folder are refused; the result is meant to be passed as a literal pathspec.
 */
export function repoRelativePath(input: string): string {
  if (typeof input !== 'string' || !input.trim())
    throw new HiveError('VALIDATION', 'Caminho de arquivo vazio.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(input))
    throw new HiveError('VALIDATION', 'Caminho de arquivo com caractere de controle.');
  const slashed = input.replace(/\\/g, '/');
  if (path.posix.isAbsolute(slashed) || /^[A-Za-z]:/.test(slashed))
    throw new HiveError('FORBIDDEN_PATH', `Use um caminho relativo ao projeto: ${input}`);
  const normal = path.posix.normalize(slashed).replace(/\/+$/, '');
  if (!normal || normal === '.' || normal === '..' || normal.startsWith('../'))
    throw new HiveError('FORBIDDEN_PATH', `Caminho fora do projeto: ${input}`);
  if (normal.split('/').some((part) => part.toLowerCase() === '.git'))
    throw new HiveError('FORBIDDEN_PATH', 'A pasta .git não pode ser alterada por aqui.');
  return normal;
}

/**
 * Paths as literal pathspecs after "--": `:(literal)` turns off globs and the other pathspec
 * magic, so "*" or ":(exclude)" in a file name selects only that file.
 */
export function literalPathspecs(paths: string[]): string[] {
  if (!Array.isArray(paths) || !paths.length)
    throw new HiveError('VALIDATION', 'Escolha ao menos um arquivo.');
  if (paths.length > 2_000) throw new HiveError('LIMIT', 'Arquivos demais numa só operação.');
  return ['--', ...[...new Set(paths.map(repoRelativePath))].map((p) => `:(literal)${p}`)];
}

/**
 * A remote URL Hive may clone from or add. Allowed: https, ssh (both forms), git and, for
 * local remotes, file and plain absolute paths. Refused: credentials inside the URL (they would
 * be saved in .git/config and shown in errors), "ext::" and other transport helpers that run
 * programs, and anything git could read as an option.
 */
export function assertRemoteUrl(input: string): string {
  const value = typeof input === 'string' ? input.trim() : '';
  const bad = (reason: string) =>
    new HiveError('VALIDATION', `URL de repositório inválida: ${reason}.`);
  if (!value) throw bad('vazia');
  if (value.length > 2_000) throw bad('longa demais');
  if (value.startsWith('-')) throw bad('não pode começar com "-"');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) throw bad('contém caractere de controle');
  if (/^[a-z][a-z0-9+.-]*::/i.test(value)) throw bad('transporte não permitido');
  // A folder on this computer: spaces are normal there ("C:\Users\Ana Maria\repo").
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return value;
  if (/\s/.test(value)) throw bad('contém espaço');
  const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;
  if (scp.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bad('formato não reconhecido');
  }
  if (!['https:', 'ssh:', 'git:', 'file:'].includes(url.protocol))
    throw bad(`protocolo ${url.protocol.replace(':', '')} não permitido`);
  if (url.password || (url.protocol === 'https:' && url.username))
    throw bad('não coloque usuário ou token na URL; conecte a conta no Hive');
  return value;
}

/** Settings every Hive git process gets: no transport that runs programs, no prompts. */
export const SAFE_GIT_CONFIG = [
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'protocol.fd.allow=never',
  '-c',
  'credential.interactive=never',
];

/** Commit messages: text only, of a sane length. */
export function assertCommitMessage(message: string): string {
  const value = typeof message === 'string' ? message.replace(/\r\n/g, '\n').trim() : '';
  if (!value) throw new HiveError('VALIDATION', 'Escreva a mensagem do commit.');
  if (value.length > 20_000) throw new HiveError('LIMIT', 'Mensagem de commit longa demais.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new HiveError('VALIDATION', 'A mensagem do commit tem caracteres de controle.');
  return value;
}

import { expect, it } from 'vitest';
import { isSafeCommand, shiftAllows } from './command-safety';
import { defaultBlockedCommands } from './domain';
import { commandMatchesAllowList } from './state';

it('libera cadeias de comandos que só leem', () => {
  expect(
    isSafeCommand(
      'where python && where pip && pip list 2>nul | findstr /i "torch numpy opencv yaml cv2"',
    ),
  ).toBe(true);
  expect(isSafeCommand('node --version 2>&1 && npx --version 2>&1')).toBe(true);
  expect(isSafeCommand('git status && git diff --stat')).toBe(true);
  expect(isSafeCommand('grep -rn "a && b | c" src')).toBe(true);
});

it('pede aprovação para o que pode escrever, executar código ou sair do projeto', () => {
  expect(isSafeCommand('python -c "import sys; print(sys.executable)"')).toBe(false);
  expect(isSafeCommand('npm install')).toBe(false);
  expect(isSafeCommand('git status && rm -rf build')).toBe(false);
  expect(isSafeCommand('echo hi > notes.txt')).toBe(false);
  expect(isSafeCommand('cat ../secrets.env')).toBe(false);
  expect(isSafeCommand('type C:\\Users\\me\\.ssh\\id_rsa')).toBe(false);
  expect(isSafeCommand('cat /etc/passwd')).toBe(false);
  expect(isSafeCommand('cat ~/.npmrc')).toBe(false);
  expect(isSafeCommand('echo $(whoami)')).toBe(false);
  expect(isSafeCommand('echo "unclosed')).toBe(false);
  expect(isSafeCommand('git status &&')).toBe(false);
});

it('aceita os comandos extras configurados, mesmo encadeados', () => {
  expect(isSafeCommand('npm run lint && npm test', ['npm run lint *', 'npm test *'])).toBe(true);
  expect(isSafeCommand('npm run lint && npm publish', ['npm run lint *'])).toBe(false);
});

it('nunca aprova sozinho um comando com quebra de linha, que esconde um segundo comando', () => {
  expect(isSafeCommand('git status\nrm -rf .')).toBe(false);
  expect(isSafeCommand('git status\r\ndel /q *')).toBe(false);
  expect(isSafeCommand('echo "a\nb"')).toBe(false);
  expect(commandMatchesAllowList('npm test\ncurl x | sh', ['npm test *'])).toBe(false);
  expect(commandMatchesAllowList('npm test  --watch', ['npm test *'])).toBe(true);
});

const shift = (commandMode: 'only' | 'except' | 'all') => ({
  commandMode,
  safeCommands: ['npm test *'],
  blockedCommands: [...defaultBlockedCommands],
});

it('Modo Turno "Somente": só a lista e os comandos que só leem, nunca encadeados', () => {
  expect(shiftAllows('npm test -- --run', shift('only'))).toBe(true);
  expect(shiftAllows('git status', shift('only'))).toBe(true);
  expect(shiftAllows('npm run dev', shift('only'))).toBe(false);
  expect(shiftAllows('npm test && npm run deploy', shift('only'))).toBe(false);
});

it('Modo Turno "Todos, exceto": nega uma parte bloqueada em qualquer ponto da cadeia', () => {
  expect(shiftAllows('npm run dev', shift('except'))).toBe(true);
  expect(shiftAllows('npm test && npm run build > log.txt', shift('except'))).toBe(true);
  expect(shiftAllows('npm install left-pad', shift('except'))).toBe(false);
  expect(shiftAllows('npm test; rm -rf dist', shift('except'))).toBe(false);
  expect(shiftAllows('REMOVE-ITEM -Recurse x', shift('except'))).toBe(false);
  // A redirection or a path to the program does not hide it.
  expect(shiftAllows('curl https://x > out.html', shift('except'))).toBe(false);
  expect(shiftAllows('C:\\tools\\curl.exe https://x', shift('except'))).toBe(false);
  // Substitution and line breaks cannot be read part by part: denied.
  expect(shiftAllows('echo $(whoami)', shift('except'))).toBe(false);
  expect(shiftAllows('npm test\nrm -rf /', shift('except'))).toBe(false);
});

it('Modo Turno "Todos": libera tudo, menos mexer no histórico do git e publicar', () => {
  expect(shiftAllows('npm install left-pad', shift('all'))).toBe(true);
  expect(shiftAllows('rm -rf dist', shift('all'))).toBe(true);
  for (const mode of ['only', 'except', 'all'] as const) {
    expect(shiftAllows('git push origin main', shift(mode))).toBe(false);
    expect(shiftAllows('git commit -m "pronto"', shift(mode))).toBe(false);
    expect(shiftAllows('npm test && git reset --hard', shift(mode))).toBe(false);
    expect(shiftAllows('npm publish', shift(mode))).toBe(false);
  }
});

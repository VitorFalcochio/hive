import { expect, it } from 'vitest';
import { isSafeCommand } from './command-safety';
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

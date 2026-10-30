import { expect, it } from 'vitest';
import { looksLikeTestCommand } from './state';

it('reconhece comandos reais de teste e verificação', () => {
  for (const command of [
    'npm test',
    'pnpm -r test',
    'pnpm --filter @hive/core run test:unit',
    'npx vitest run',
    'npm run typecheck',
    'npm run lint',
    'python -m pytest',
    'go test ./...',
    'cargo test',
    'dotnet test',
    './node_modules/.bin/tsc --noEmit',
    'cd app && npm test',
  ])
    expect(looksLikeTestCommand(command), command).toBe(true);
});

it('não confunde menções a testes, leituras de arquivos e ajuda com testes executados', () => {
  for (const command of [
    'echo "tests passed"',
    'echo "fake && npm test"',
    'rg test src',
    'cat tests/unit.ts',
    'git diff -- tests',
    'npm install vitest',
    'npm view tests',
    'npx vitest --help',
    'npm run build',
  ])
    expect(looksLikeTestCommand(command), command).toBe(false);
});

import { configDefaults, defineConfig } from 'vitest/config';

// `.local` holds Hive's own data, including the worktrees agents work in: other projects'
// tests live there and are not Hive's. The bench fixture and its reference solutions are a
// sample project with its own node:test suite, run by the bench itself.
const exclude = [
  ...configDefaults.exclude,
  '.local/**',
  'packages/bench/fixture/**',
  'packages/bench/solutions/**',
];

/**
 * End-to-end scenarios with real git worktrees and many node processes. They run after the
 * rest, not beside it: run together, they took the CPU from tests that wait on timers.
 */
const integration = [
  'packages/orchestrator/src/teams/teams.flow.test.ts',
  // Starts many node processes, local HTTP servers and taskkill for the Claude Code adapter.
  'packages/agents/src/claude-code.test.ts',
];

export default defineConfig({
  test: {
    exclude,
    projects: [
      {
        extends: true,
        test: {
          name: 'unidade',
          exclude: [...exclude, ...integration],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: { name: 'integração', include: integration, sequence: { groupOrder: 1 } },
      },
    ],
  },
});

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.local` holds Hive's own data, including the worktrees agents work in: other projects'
    // tests live there and are not Hive's. The bench fixture and its reference solutions are a sample project with its own node:test suite,
    // run by the bench itself.
    exclude: [
      ...configDefaults.exclude,
      '.local/**',
      'packages/bench/fixture/**',
      'packages/bench/solutions/**',
    ],
  },
});

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `.local` holds Hive's own data, including the worktrees agents work in: other projects'
    // tests live there and are not Hive's.
    exclude: [...configDefaults.exclude, '.local/**'],
  },
});

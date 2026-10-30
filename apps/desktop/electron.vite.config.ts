import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

const workspacePackages = [
  '@hive/agents',
  '@hive/core',
  '@hive/orchestrator',
  '@hive/persistence',
  '@hive/providers',
  '@hive/shared',
  '@hive/skills',
  '@hive/workspace',
];

export default defineConfig({
  main: { build: { externalizeDeps: { exclude: workspacePackages } } },
  preload: { build: { externalizeDeps: { exclude: workspacePackages } } },
  renderer: {
    plugins: [react()],
    // Two pages: the main window and the Nexus, each with its own window and bundle.
    build: {
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          canvas: resolve(import.meta.dirname, 'src/renderer/canvas.html'),
        },
      },
    },
  },
});

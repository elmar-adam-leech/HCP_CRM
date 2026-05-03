import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  // @ts-expect-error rolldown-vite uses oxc for transforms; the field
  // isn't in the public Vite type yet but is honored at runtime.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['server/**/*.test.ts', 'client/**/*.test.ts', 'client/**/*.test.tsx'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './shared'),
      '@': path.resolve(__dirname, './client/src'),
    },
  },
});

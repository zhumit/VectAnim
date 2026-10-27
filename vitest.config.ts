import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['editor/src/tests/**/*.test.ts'],
    reporters: ['default'],
    globals: false,
  },
});

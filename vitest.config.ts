import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'harness/openrouter/tests/**/*.test.ts'],
    environment: 'node',
  },
});

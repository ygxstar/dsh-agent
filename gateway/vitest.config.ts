import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    server: { deps: { inline: ['stub-dsh'] } },
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});

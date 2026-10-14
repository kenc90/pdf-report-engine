import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // PDF generation touches the filesystem, so keep tests in the node pool.
    environment: 'node',
    testTimeout: 60_000,
  },
});

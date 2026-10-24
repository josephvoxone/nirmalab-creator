import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'server', include: ['server/test/**/*.test.ts'], environment: 'node' } },
      { extends: './web/vite.config.ts', test: { name: 'web', include: ['web/src/**/*.test.{ts,tsx}'], environment: 'jsdom', testTimeout: 20000, setupFiles: ['web/src/test-setup.ts'] } }
    ]
  }
});

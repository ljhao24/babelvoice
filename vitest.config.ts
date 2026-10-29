import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@core': resolve('src/core'),
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'build', 'dist'],
    clearMocks: true,
    restoreMocks: true,
    globals: false
  }
});

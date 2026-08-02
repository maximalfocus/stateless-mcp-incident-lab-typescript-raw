import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 95,
        lines: 95,
      },
    },
  },
})

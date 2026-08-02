export default {
  mutate: [
    'src/application/incidents.ts',
    'src/application/mrtr.ts',
    'src/client/cache.ts',
    'src/domain/incident.ts',
    'src/properties.ts',
    'src/protocol/headers.ts',
    'src/protocol/request-state.ts',
    'src/protocol/validation.ts',
  ],
  testRunner: 'vitest',
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: { high: 80, low: 80, break: 80 },
  coverageAnalysis: 'off',
  concurrency: 4,
  vitest: { configFile: 'vitest.config.ts' },
}

/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  transform: { '^.+\\.ts$': 'ts-jest' },
  moduleFileExtensions: ['js', 'json', 'ts'],
  // unit: test/unit/*.spec.ts · e2e: test/e2e/*.e2e-spec.ts (docs/plan.md §9)
  testMatch: ['<rootDir>/test/**/*.spec.ts', '<rootDir>/test/**/*.e2e-spec.ts'],
  // Una vez por ejecución: recrea y migra la base exchange_test.
  globalSetup: '<rootDir>/test/global-setup.ts',
  // Antes de cada archivo de prueba: apunta DATABASE_URL a la base de pruebas.
  setupFiles: ['<rootDir>/test/env.ts'],
  testTimeout: 20000,
};

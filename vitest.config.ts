import { defineConfig } from 'vitest/config';

// Integration tests run against a real MySQL/MariaDB test database (see .env.test).
try {
  process.loadEnvFile('.env.test');
} catch {
  // CI provides the variables directly
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    setupFiles: ['tests/setup.ts'],
    // Test files share one database, so they run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: { NODE_ENV: 'test' },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // one shared test database
    testTimeout: 20000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://hub:hub@localhost:5432/hub_test',
      DEV_AUTH: 'true',
      RATE_LIMIT_PER_MIN: '100000',
    },
  },
});

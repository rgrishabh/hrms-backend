import { defineConfig } from 'vitest/config';

/** What the mutation run executes: the suites that exercise payroll calculation and leave rules. Other files add minutes and no kills. */
export default defineConfig({
  test: {
    include: ['test/payroll-calc.test.ts', 'test/payroll-calc-exact.test.ts', 'test/property-payroll.test.ts', 'test/property-leave.test.ts', 'test/leave.test.ts', 'test/leave-fixes.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});

import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The generated password list is data. Nothing else is left out.
      exclude: ['src/core/auth/breached-list.data.ts'],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
      thresholds: {
        lines: 85,
        // Business rules. These stay at 100: see TESTING.md for what is short of it, and why.
        ...Object.fromEntries(
          [
            'src/modules/payroll/calc.ts',
            'src/modules/payroll/sealed.ts',
            'src/modules/leave/service.ts',
            'src/modules/leave/jobs.ts',
            'src/modules/loans/service.ts',
            'src/modules/attendance/calc.ts',
            'src/core/policy/salary.ts',
            'src/core/policy/levels.ts',
            'src/core/features/registry.ts',
            'src/config/env.ts',
            'src/config/installation.ts',
          ].map((f) => [f, { branches: 100 }]),
        ),
      },
    },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});

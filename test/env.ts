export const TEST_OWNER_URL = process.env.TEST_DATABASE_MIGRATION_URL ?? 'postgres://hrms_owner:hrms_owner_dev@localhost:5432/hrms_test';
export const TEST_APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://hrms_app:hrms_app_dev@localhost:5432/hrms_test';
export const TEST_SINGLE_OWNER_URL = process.env.TEST_SINGLE_DATABASE_MIGRATION_URL ?? 'postgres://hrms_owner:hrms_owner_dev@localhost:5432/hrms_test_single';
export const TEST_SINGLE_APP_URL = process.env.TEST_SINGLE_DATABASE_URL ?? 'postgres://hrms_app:hrms_app_dev@localhost:5432/hrms_test_single';
export const TEST_SINGLE_B_OWNER_URL = process.env.TEST_SINGLE_B_DATABASE_MIGRATION_URL ?? 'postgres://hrms_owner:hrms_owner_dev@localhost:5432/hrms_test_single_b';
export const TEST_SINGLE_B_APP_URL = process.env.TEST_SINGLE_B_DATABASE_URL ?? 'postgres://hrms_app:hrms_app_dev@localhost:5432/hrms_test_single_b';

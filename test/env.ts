export const TEST_OWNER_URL = process.env.TEST_DATABASE_MIGRATION_URL ?? 'postgres://hrms_owner:hrms_owner_dev@localhost:5432/hrms_test';
export const TEST_APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://hrms_app:hrms_app_dev@localhost:5432/hrms_test';
export const TEST_SINGLE_OWNER_URL = process.env.TEST_SINGLE_DATABASE_MIGRATION_URL ?? 'postgres://hrms_owner:hrms_owner_dev@localhost:5432/hrms_test_single';
export const TEST_SINGLE_APP_URL = process.env.TEST_SINGLE_DATABASE_URL ?? 'postgres://hrms_app:hrms_app_dev@localhost:5432/hrms_test_single';
export const TEST_SINGLE_B_OWNER_URL = process.env.TEST_SINGLE_B_DATABASE_MIGRATION_URL ?? 'postgres://hrms_owner:hrms_owner_dev@localhost:5432/hrms_test_single_b';
export const TEST_SINGLE_B_APP_URL = process.env.TEST_SINGLE_B_DATABASE_URL ?? 'postgres://hrms_app:hrms_app_dev@localhost:5432/hrms_test_single_b';

/** Everything Layer 2 of the contract requires, for an installation in a test. */
export const TEST_BRAND = {
  BRAND_NAME: 'Test Labs', BRAND_PRODUCT_NAME: 'TestHRMS', BRAND_PRIMARY_COLOR: '#1f5f8b', BRAND_SUPPORT_EMAIL: 'support@test-labs.test', BRAND_EMAIL_FROM: 'hrms@test-labs.test',
  BRAND_DOMAIN: 'localhost', BRAND_LOCALE: 'en-IN', BRAND_TIMEZONE: 'Asia/Kolkata', BRAND_CURRENCY: 'INR', BRAND_DATE_FORMAT: 'DD/MM/YYYY', BRAND_FINANCIAL_YEAR_START: '04-01', BRAND_COUNTRY: 'IN',
};

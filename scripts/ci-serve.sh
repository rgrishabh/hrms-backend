#!/bin/sh
# Starts the built API for a DAST scan: a throwaway database, migrated, bootstrapped by SQL, on the given port. CI and local scans both use it.
# Needs DATABASE_URL (runtime role) and DATABASE_MIGRATION_URL (owner). Plain HTTP on loopback, so NODE_ENV stays test.
set -eu
PORT="${PORT:-4200}"
export NODE_ENV=test COOKIE_SECURE=false HOST=0.0.0.0 PORT LOG_LEVEL=warn PROCESS_ROLE=api TRUST_PROXY=false
export DATA_ENCRYPTION_KEY="${DATA_ENCRYPTION_KEY:-$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))")}"
export BRAND_NAME='Scan Labs' BRAND_PRODUCT_NAME=ScanHRMS BRAND_PRIMARY_COLOR='#1f5f8b' BRAND_SUPPORT_EMAIL=support@scan.test BRAND_EMAIL_FROM=hrms@scan.test BRAND_DOMAIN="${BRAND_DOMAIN:-host.docker.internal}"
export BRAND_LOCALE=en-IN BRAND_TIMEZONE=Asia/Kolkata BRAND_CURRENCY=INR BRAND_DATE_FORMAT=DD/MM/YYYY BRAND_FINANCIAL_YEAR_START=04-01 BRAND_COUNTRY=IN
export RATE_LIMIT_PER_MINUTE=100000 AUTH_RATE_LIMIT_PER_MINUTE=10000 AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE=10000 EXPORT_RATE_LIMIT_PER_MINUTE=100000
exec node dist/src/server.js

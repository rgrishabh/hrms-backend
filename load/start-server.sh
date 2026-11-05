#!/bin/sh
# Starts the built API against the load database, as production would run it, with the limits that a single test address would otherwise hit opened up.
# Usage: DATABASE_URL=... PORT=4100 load/start-server.sh
set -eu
export NODE_ENV=production COOKIE_SECURE=true DATABASE_SSL=disable TRUST_PROXY=false LOG_LEVEL=warn PROCESS_ROLE=api
export RATE_LIMIT_PER_MINUTE=100000 AUTH_RATE_LIMIT_PER_MINUTE=10000 AUTH_ACCOUNT_RATE_LIMIT_PER_MINUTE=10000 EXPORT_RATE_LIMIT_PER_MINUTE=100000
export HOST="${HOST:-127.0.0.1}" PORT="${PORT:-4100}"
export BRAND_NAME='Load Labs' BRAND_PRODUCT_NAME=LoadHRMS BRAND_PRIMARY_COLOR='#1f5f8b' BRAND_SUPPORT_EMAIL=support@load.test BRAND_EMAIL_FROM=hrms@load.test BRAND_DOMAIN=load.test
export BRAND_LOCALE=en-IN BRAND_TIMEZONE=Asia/Kolkata BRAND_CURRENCY=INR BRAND_DATE_FORMAT=DD/MM/YYYY BRAND_FINANCIAL_YEAR_START=04-01 BRAND_COUNTRY=IN
export FEATURE_DOCUMENTS=false MFA_AVAILABLE=false MFA_ENFORCED=false
exec node dist/src/server.js

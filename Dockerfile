# One image per release: API + built web app + DB tooling (provision/migrate/bootstrap).
# Build context: repository root.   docker build -f apps/api/Dockerfile -t hrms-api .
# The same image runs the service (default CMD) and the one-off ops tasks (command override):
#   node dist/src/db/provision.js | node dist/src/db/migrate.js [--status] | node dist/src/db/bootstrap.js
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w apps/api && npm run build -w apps/web \
 && npm prune --omit=dev

# Amazon RDS CA bundle, for DATABASE_SSL=verify-full.
FROM alpine:3.20 AS certs
RUN apk add --no-cache curl \
 && curl -fsSL -o /rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

FROM node:22-alpine
# Customer-specific configuration (branding, organization, modules, domains) is injected at
# deploy time (Compose .env / Terraform); the same image serves every customer.
ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=4000 \
    WEB_DIST_DIR=/app/web \
    DATABASE_SSL=verify-full \
    DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/migrations ./apps/api/migrations
COPY --from=build /app/apps/web/dist ./web
COPY --from=certs /rds-global-bundle.pem ./certs/rds-global-bundle.pem
# Document storage mount point (Compose volume); owned by the app user so a new named volume is writable.
RUN mkdir -p /app/storage && chown node:node /app/storage && chmod 700 /app/storage
USER node
WORKDIR /app/apps/api
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "dist/src/server.js"]

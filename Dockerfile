# syntax=docker/dockerfile:1.7
# HRMS backend: API + database tooling. One image for every environment and customer;
# configuration is injected at runtime (Compose .env / ECS task definition).
#   docker run IMAGE            -> API server (default)
#   docker run IMAGE migrate    -> apply pending migrations, then exit
#   docker run IMAGE migrate-status | provision | bootstrap [--reset-admin --admin-email ...]

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Amazon RDS CA bundle, for DATABASE_SSL=verify-full on AWS.
FROM alpine:3.24 AS certs
# hadolint ignore=DL3018
RUN apk add --no-cache curl \
 && curl -fsSL -o /rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

FROM node:22-alpine
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="hrms-backend" \
      org.opencontainers.image.source="https://github.com/rgrishabh/hrms-backend" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=4000 \
    DATABASE_SSL=verify-full \
    DATABASE_CA_FILE=/app/certs/rds-global-bundle.pem \
    APP_VERSION=${VERSION}
WORKDIR /app
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root migrations ./migrations
COPY --from=certs /rds-global-bundle.pem ./certs/rds-global-bundle.pem
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/hrms
# Security fixes published after the base image was built.
# hadolint ignore=DL3018
RUN apk upgrade --no-cache
# Local document storage mount point (Compose volume); S3 is used on AWS.
RUN mkdir -p /app/storage && chown 1000:1000 /app/storage && chmod 700 /app/storage
# uid 1000 = "node" in the base image
USER 1000:1000
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s CMD ["wget", "-qO", "/dev/null", "http://127.0.0.1:4000/health"]
ENTRYPOINT ["/usr/local/bin/hrms"]
CMD ["serve"]

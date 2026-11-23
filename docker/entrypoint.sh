#!/bin/sh
# Command dispatcher for the backend image. Unknown commands are executed as-is
# (so `node dist/src/db/migrate.js` keeps working for older task definitions).
set -eu
cmd=${1:-serve}
[ "$#" -gt 0 ] && shift
case "$cmd" in
  serve)          exec node dist/src/server.js "$@" ;;
  worker)         PROCESS_ROLE=worker; export PROCESS_ROLE; exec node dist/src/worker.js "$@" ;;
  worker-health)  exec node dist/src/worker-health.js "$@" ;;
  healthcheck)    # the image's HEALTHCHECK: one image, two roles
                  if [ "${PROCESS_ROLE:-api}" = worker ]; then exec node dist/src/worker-health.js; fi
                  exec wget -qO /dev/null "http://127.0.0.1:${PORT:-4000}/health" ;;
  migrate)        exec node dist/src/db/migrate.js "$@" ;;
  migrate-status) exec node dist/src/db/migrate.js --status "$@" ;;
  migrate-down)   exec node dist/src/db/migrate.js --rollback "$@" ;;   # says how far: --steps N, --to NAME or --all
  rotate-keys)    exec node dist/src/db/rotate-keys.js "$@" ;;
  provision)      exec node dist/src/db/provision.js "$@" ;;
  bootstrap)      exec node dist/src/db/bootstrap.js "$@" ;;
  demo)           exec node dist/src/db/demo.js "$@" ;;   # dev/demo only: needs DEMO_DATA_ALLOWED=true
  *)              exec "$cmd" "$@" ;;
esac

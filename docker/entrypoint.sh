#!/bin/sh
# Command dispatcher for the backend image. Unknown commands are executed as-is
# (so `node dist/src/db/migrate.js` keeps working for older task definitions).
set -eu
cmd=${1:-serve}
[ "$#" -gt 0 ] && shift
case "$cmd" in
  serve)          exec node dist/src/server.js "$@" ;;
  migrate)        exec node dist/src/db/migrate.js "$@" ;;
  migrate-status) exec node dist/src/db/migrate.js --status "$@" ;;
  provision)      exec node dist/src/db/provision.js "$@" ;;
  bootstrap)      exec node dist/src/db/bootstrap.js "$@" ;;
  demo)           exec node dist/src/db/demo.js "$@" ;;   # dev/demo only: needs DEMO_DATA_ALLOWED=true
  *)              exec "$cmd" "$@" ;;
esac

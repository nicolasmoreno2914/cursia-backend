#!/bin/bash
# Starts the disposable local Postgres cluster used by the Cursia local
# Moodle test environment (127.0.0.1:5570 only, no unix socket, no sudo).
set -euo pipefail
SCRATCH="${E2E_MOODLE_DIR:?define E2E_MOODLE_DIR}"
export LC_ALL=C
/opt/homebrew/bin/pg_ctl -D "$SCRATCH/pgdata" -l "$SCRATCH/pg.log" start
echo "Postgres up on 127.0.0.1:5570 (log: $SCRATCH/pg.log)"
echo "Moodle root: $SCRATCH/source"
echo "Run restores with: $SCRATCH/restore-and-inspect.sh <file.mbz>"

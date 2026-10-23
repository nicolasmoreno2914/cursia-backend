#!/bin/bash
# Stops the disposable local Postgres cluster and (optionally, with --purge)
# deletes all data for the Cursia local Moodle test environment.
#
# Usage:
#   ./teardown.sh          # stop Postgres only, keep all data on disk
#   ./teardown.sh --purge  # stop Postgres AND delete pgdata/moodledata/backups
set -euo pipefail
SCRATCH="${E2E_MOODLE_DIR:?define E2E_MOODLE_DIR}"
export LC_ALL=C

if /opt/homebrew/bin/pg_ctl -D "$SCRATCH/pgdata" status >/dev/null 2>&1; then
    /opt/homebrew/bin/pg_ctl -D "$SCRATCH/pgdata" stop -m fast
    echo "Postgres stopped."
else
    echo "Postgres was not running."
fi

if [ "${1:-}" = "--purge" ]; then
    echo "Purging data (pgdata, moodledata, backups)..."
    rm -rf "$SCRATCH/pgdata" "$SCRATCH/moodledata" "$SCRATCH/backups"
    echo "Purged. Moodle source code and scripts under $SCRATCH/source were left intact."
    echo "To reinstall the DB from scratch, re-run the initdb/psql/install.php steps in b4-report.md."
fi

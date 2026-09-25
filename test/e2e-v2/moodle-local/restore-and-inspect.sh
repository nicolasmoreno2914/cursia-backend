#!/bin/bash
# restore-and-inspect.sh <path-to.mbz>
#
# Restores an .mbz backup into a NEW course (category id 1) on the disposable
# local Cursia test Moodle, then prints a JSON description of the restored
# course structure (sections, activities per section in order, counts by
# modname, quiz question/slot counts).
#
# Requires the local Postgres cluster to be running (see start.sh).

set -euo pipefail

SCRATCH="${E2E_MOODLE_DIR:?define E2E_MOODLE_DIR}"
PHP="/opt/homebrew/opt/php@8.3/bin/php"
PHPINI="$SCRATCH/php.ini"
MOODLE="$SCRATCH/source"

if [ $# -lt 1 ]; then
    echo "Usage: $0 <path-to.mbz>" >&2
    exit 1
fi

MBZ="$1"
if [ ! -f "$MBZ" ]; then
    echo "File not found: $MBZ" >&2
    exit 1
fi
# Resolve to absolute path.
MBZ="$(cd "$(dirname "$MBZ")" && pwd)/$(basename "$MBZ")"

cd "$MOODLE"

echo "== Restoring $MBZ into a new course (category 1) ==" >&2
RESTORE_OUT="$("$PHP" -c "$PHPINI" admin/cli/restore_backup.php --file="$MBZ" --categoryid=1 2>&1)"
echo "$RESTORE_OUT" >&2

# The CLI script prints "Course ID: N" (or similar) on success; try a couple
# of known formats, then fall back to "most recently created course".
COURSEID="$(echo "$RESTORE_OUT" | grep -Eio 'course id:? *[0-9]+' | grep -Eo '[0-9]+' | tail -1 || true)"

if [ -z "$COURSEID" ]; then
    echo "== Could not parse course id from restore output, falling back to MAX(id) in mdl_course ==" >&2
    COURSEID="$("$PHP" -c "$PHPINI" -r '
        define("CLI_SCRIPT", 1);
        require(__DIR__ . "/config.php");
        global $DB;
        echo $DB->get_field_sql("SELECT MAX(id) FROM {course}");
    ')"
fi

echo "== Restored course id: $COURSEID ==" >&2

"$PHP" -c "$PHPINI" admin/cli/inspect_course.php --courseid="$COURSEID"

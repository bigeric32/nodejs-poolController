#!/bin/bash
# Trim the pool logs on this Pi: the data logs keep 15 months, the execution logs keep 60 days. Files last changed before that are removed.
#
#   data logs       njsPC logs/: packetLog(...), solarLog(...) and the replay capture folders
#   execution logs  njsPC logs/consoleLog(...), REM's logs/ folder, and the pm2 logs in ~/.pm2/logs (the running ones were changed recently, so they stay)
#
#   ~/pool-trim-logs.sh                 dry run: lists what would be removed and how much space it would free. Removes nothing.
#   ~/pool-trim-logs.sh --delete        removes them (and any folders left empty)
#   ~/pool-trim-logs.sh --months 12     keeps the data logs a different number of months    (default 15)
#   ~/pool-trim-logs.sh --days 30       keeps the execution logs a different number of days (default 60)
#
# Only those folders are touched, and only the files in them (not links). The data folders are never touched: the AutoSwg files in njsPC's data/
# keep themselves to their own limits (the PoolMath archive and the output log 18 months, the salt log 400 days).
#
# Weekly from cron, for example (Sunday 4:30 AM):  30 4 * * 0 /home/eric/pool-trim-logs.sh --delete >> /home/eric/pool-backups/trim.log 2>&1
set -u
MONTHS=15
DAYS=60
DELETE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --delete) DELETE=1 ;;
    --months) shift; MONTHS="${1:-}" ;;
    --days) shift; DAYS="${1:-}" ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
for v in "$MONTHS" "$DAYS"; do
  case "$v" in ''|*[!0-9]*) echo "--months and --days need whole numbers." >&2; exit 2 ;; esac
  [ "$v" -ge 1 ] || { echo "--months and --days need at least 1." >&2; exit 2; }
done

DATA_CUTOFF=$(date -d "$MONTHS months ago" '+%Y-%m-%d %H:%M:%S') || { echo "Could not work out the cutoff date." >&2; exit 1; }
EXEC_CUTOFF=$(date -d "$DAYS days ago" '+%Y-%m-%d %H:%M:%S') || { echo "Could not work out the cutoff date." >&2; exit 1; }
echo "$(date '+%Y-%m-%d %H:%M:%S') pool-trim-logs: data logs keep $MONTHS months (before $DATA_CUTOFF), execution logs keep $DAYS days (before $EXEC_CUTOFF)$([ "$DELETE" = 1 ] || echo '; dry run, nothing is removed')"

TOTAL_FILES=0
TOTAL_BYTES=0

# trim_set LABEL CUTOFF DIR [find tests...]: the files in DIR that match the tests and were last changed before CUTOFF
trim_set() {
  local label="$1" cutoff="$2" dir="$3"; shift 3
  [ -d "$dir" ] || { echo "  $label: $dir is not there, skipped"; return; }
  local old n bytes
  # one name per line (a name with a newline in it is not expected in these folders)
  old=$(find "$dir" -type f "$@" ! -newermt "$cutoff" 2>/dev/null)
  if [ -z "$old" ]; then echo "  $label ($dir): nothing to remove"; return; fi
  n=$(printf '%s\n' "$old" | wc -l)
  bytes=$(printf '%s\n' "$old" | while IFS= read -r f; do stat -c %s "$f" 2>/dev/null || echo 0; done | awk '{s+=$1} END {print s+0}')
  echo "  $label ($dir): $n file(s), $((bytes / 1048576)) MB"
  if [ "$DELETE" = 1 ]; then
    printf '%s\n' "$old" | while IFS= read -r f; do rm -f -- "$f"; done
    # folders left empty inside it (never the folder itself)
    find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null
  else
    printf '%s\n' "$old" | head -3 | sed 's/^/      /'
    [ "$n" -gt 3 ] && echo "      ... and $((n - 3)) more"
  fi
  TOTAL_FILES=$((TOTAL_FILES + n))
  TOTAL_BYTES=$((TOTAL_BYTES + bytes))
}

# data logs: everything in njsPC's logs/ except the console logs
trim_set "data" "$DATA_CUTOFF" "$HOME/nodejs-poolController/logs" ! -name 'consoleLog*'
# execution logs: njsPC's console logs, REM's logs and the pm2 logs
trim_set "execution" "$EXEC_CUTOFF" "$HOME/nodejs-poolController/logs" -name 'consoleLog*'
trim_set "execution" "$EXEC_CUTOFF" "$HOME/relayEquipmentManager/logs"
trim_set "execution" "$EXEC_CUTOFF" "$HOME/.pm2/logs"

if [ "$DELETE" = 1 ]; then
  echo "Removed $TOTAL_FILES file(s), freed about $((TOTAL_BYTES / 1048576)) MB."
else
  echo "Would remove $TOTAL_FILES file(s), freeing about $((TOTAL_BYTES / 1048576)) MB. Run with --delete to do it."
fi

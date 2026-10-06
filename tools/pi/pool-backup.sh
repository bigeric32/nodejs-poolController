#!/bin/bash
# Back up the pool configuration and data on this Pi into ~/pool-backups.
#
#   ~/pool-backup.sh           full backup: asks for a name, needs sudo for the system files.
#   ~/pool-backup.sh --daily   unattended data backup for cron: no prompt and no sudo (the data, configs and scripts you can read). Keeps the last 14,
#                              and copies the newest one off the Pi when ~/.pool-backup.conf sets REMOTE (see below).
#   --no-logs                  leaves the logs out of this one run (--logs puts them back)
#
# Both include the njsPC and REM logs folders (the solar logs, packet captures and so on) unless INCLUDE_LOGS=0.
#
# Restore a full backup in place with:  sudo tar -xpf FILE -C /
#
# ~/.pool-backup.conf (optional, plain shell lines):
#   REMOTE=user@host:/folder/        where --daily also copies the newest archive (scp, with a key and no password prompt)
#   INCLUDE_LOGS=0                   leaves the njsPC and REM logs folders out of every backup (the default, 1, includes them)
#   KEEP_DAILY=14                    how many --daily archives to keep on the Pi
set -u
MODE=full
REMOTE=""
INCLUDE_LOGS=1
KEEP_DAILY=14
[ -r "$HOME/.pool-backup.conf" ] && . "$HOME/.pool-backup.conf"
for arg in "$@"; do
  case "$arg" in
    --daily) MODE=daily ;;
    --no-logs) INCLUDE_LOGS=0 ;;
    --logs) INCLUDE_LOGS=1 ;;
  esac
done

DEST="$HOME/pool-backups"
mkdir -p "$DEST" && chmod 700 "$DEST"
STAMP=$(date +%Y-%m-%d_%H-%M-%S)
if [ "$MODE" = "daily" ]; then
  NAME=daily
else
  read -r -p "Backup name (the date and time are added after it): " NAME
  NAME=$(printf '%s' "$NAME" | sed 's/[^A-Za-z0-9._-]/_/g')
  [ -z "$NAME" ] && NAME="poolpi"
fi
OUT="$DEST/${NAME}_${STAMP}.tar.gz"

ITEMS=()
add() { [ -e "$1" ] && ITEMS+=("${1#/}"); }

# A manifest and the crontab go into a full archive as real files under ~/.pool-backup
INFO="$HOME/.pool-backup"
if [ "$MODE" = "full" ]; then
  mkdir -p "$INFO"
  {
    echo "Backup '$NAME' made $(date) on $(hostname)"
    for d in nodejs-poolController relayEquipmentManager nodejs-poolController-dashPanel; do
      echo "$d: $(git -C "$HOME/$d" rev-parse --abbrev-ref HEAD 2>/dev/null) | $(git -C "$HOME/$d" log --oneline -1 2>/dev/null)"
    done
    echo "node $(node -v 2>/dev/null)"
    pm2 list 2>/dev/null | grep -E "njsPC|REM|dashPanel"
  } > "$INFO/MANIFEST.txt"
  crontab -l > "$INFO/crontab.txt" 2>/dev/null
  add "$INFO"
fi

# The data and the settings: the whole njsPC data folder (poolConfig, poolState and every AutoSwg file: history, tune history, salt log, output log, PoolMath archive)
add "$HOME/nodejs-poolController/data"
add "$HOME/nodejs-poolController/web/bindings/custom"
for f in "$HOME"/nodejs-poolController/config.json*; do add "$f"; done
add "$HOME/relayEquipmentManager/data"
for f in "$HOME"/relayEquipmentManager/config.json*; do add "$f"; done
for f in "$HOME"/nodejs-poolController-dashPanel/config.json*; do add "$f"; done
for f in "$HOME"/pool-*.sh; do add "$f"; done
add "$HOME/.pool-backup.conf"
# The logs (the solar logs, packet captures and so on) can be large: INCLUDE_LOGS=0 in ~/.pool-backup.conf, or --no-logs for one run, leaves them out
if [ "$INCLUDE_LOGS" = "1" ]; then
  add "$HOME/nodejs-poolController/logs"
  add "$HOME/relayEquipmentManager/logs"
fi

if [ "$MODE" = "full" ]; then
  add "$HOME/.pm2/dump.pm2"
  add "$HOME/.pm2/module_conf.json"
  for p in /usr/local/bin/pool-watchdog.sh /etc/systemd/system/pool-watchdog.service /etc/systemd/system/pool-watchdog.timer \
           /etc/systemd/system.conf.d /etc/systemd/journald.conf.d /etc/NetworkManager/conf.d /etc/NetworkManager/system-connections \
           /etc/netplan /boot/firmware/config.txt /boot/firmware/cmdline.txt /etc/hostname; do add "$p"; done
  # Run as root so the root-only files can be read and their owners and permissions are kept; the file is still written as you.
  sudo tar --numeric-owner --warning=no-file-changed -czpf - -C / "${ITEMS[@]}" > "$OUT"
  RC=$?
else
  # Unattended: as you, so a file you cannot read is skipped instead of stopping the backup
  tar --numeric-owner --warning=no-file-changed --ignore-failed-read -czpf "$OUT" -C / "${ITEMS[@]}" 2>/dev/null
  RC=$?
fi
# tar exits 1 when a file changed while it was read (a log or the output log being appended to): the archive is still good
if [ "$RC" -gt 1 ]; then
  echo "Backup failed (tar exit $RC)." >&2
  rm -f "$OUT"
  exit "$RC"
fi
chmod 600 "$OUT"

if [ "$MODE" = "daily" ]; then
  # keep the newest KEEP_DAILY daily archives
  ls -1t "$DEST"/daily_*.tar.gz 2>/dev/null | tail -n +"$((KEEP_DAILY + 1))" | while read -r old; do rm -f "$old"; done
  if [ -n "$REMOTE" ]; then
    scp -q -o BatchMode=yes -o ConnectTimeout=10 "$OUT" "$REMOTE" || echo "Could not copy $OUT to $REMOTE (it is still on the Pi)." >&2
  fi
  exit 0
fi

echo "Saved $OUT ($(du -h "$OUT" | cut -f1), $(tar -tzf "$OUT" | grep -vc '/$') files)."
echo "It contains your Wi-Fi password (netplan) and your PoolMath share code (njsPC config): keep it private and do not share it."

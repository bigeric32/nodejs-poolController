#!/bin/bash
# Checks the pool Pi after it boots from a new SD card (or after any reboot). It only reads: it changes nothing, and needs no sudo.
#
#   ~/pool-postboot-check.sh          run the checks and print [ OK ], [WARN] or [FAIL] for each
#
# The exit status is the number of FAILs, so 0 means nothing is wrong that this script can see. A WARN needs a look but is not
# necessarily a problem (for example, the SWG not answering is normal while its relay is off outside its run window).
#
# What it checks: the root partition filled the card, the card and its health (undervoltage, I/O errors), the time, Wi-Fi on
# 2.4 GHz, pm2 and the three services, the ports njsPC and REM listen on, cloudflared, the pool watchdog, the cron jobs, the RS485
# adapter, the relay board, what njsPC sees of the chlorinator, and how fast the card writes.
set -u
FAILS=0
WARNS=0
ok()   { printf '[ OK ] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*"; WARNS=$((WARNS + 1)); }
fail() { printf '[FAIL] %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf '       %s\n' "$*"; }
head1() { printf '\n== %s ==\n' "$*"; }

NJSPC="$HOME/nodejs-poolController"
REM="$HOME/relayEquipmentManager"
PM2LOGS="$HOME/.pm2/logs"

echo "Pool Pi post-boot check, $(date '+%Y-%m-%d %H:%M:%S'), up $(uptime -p 2>/dev/null)"
[ -r /proc/device-tree/model ] && note "$(tr -d '\0' < /proc/device-tree/model)"

head1 "SD card and storage"
ROOTSRC=$(findmnt -no SOURCE / 2>/dev/null)
DEV=$(printf '%s' "$ROOTSRC" | sed 's/p\?[0-9]*$//')
if [ -n "$ROOTSRC" ] && [ -b "$ROOTSRC" ] && [ -b "$DEV" ]; then
  PSIZE=$(lsblk -bno SIZE "$ROOTSRC" 2>/dev/null | head -1)
  DSIZE=$(lsblk -bdno SIZE "$DEV" 2>/dev/null | head -1)
  if [ -n "$PSIZE" ] && [ -n "$DSIZE" ] && [ "$DSIZE" -gt 0 ]; then
    PCT=$((PSIZE * 100 / DSIZE))
    if [ "$PCT" -ge 90 ]; then ok "the root partition fills the card ($((PSIZE / 1073741824)) GB of $((DSIZE / 1073741824)) GB)"
    else fail "the root partition is only $((PSIZE / 1073741824)) GB of a $((DSIZE / 1073741824)) GB card; run: sudo raspi-config nonint do_expand_rootfs, then reboot"; fi
  fi
fi
df -h / | tail -1 | awk '{print "       root: " $2 " total, " $3 " used, " $5 " full"}'
CARD=/sys/block/mmcblk0/device
if [ -d "$CARD" ]; then
  note "card: name $(cat $CARD/name 2>/dev/null), made $(cat $CARD/date 2>/dev/null), manufacturer id $(cat $CARD/manfid 2>/dev/null)"
fi
findmnt -no OPTIONS / | grep -q noatime && ok "root is mounted noatime" || warn "root is not mounted noatime (more writes to the card)"
if command -v vcgencmd >/dev/null 2>&1; then
  T=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2)
  if [ "$T" = "0x0" ]; then ok "no undervoltage or throttling since boot ($(vcgencmd measure_temp 2>/dev/null))"
  else fail "power or thermal trouble flagged since boot (get_throttled=$T): check the power supply and cable"; fi
fi
if journalctl -k -b --no-pager >/dev/null 2>&1; then
  BAD=$(journalctl -k -b --no-pager 2>/dev/null | grep -ciE "under-voltage|i/o error|ext4.*error|mmc[0-9]:.*(error|timeout)|usb.*(reset|disconnect)")
  if [ "${BAD:-0}" -eq 0 ]; then ok "no card, storage or USB errors in the kernel log since boot"
  else warn "$BAD storage, power or USB lines in the kernel log since boot: journalctl -k -b | grep -iE 'under-voltage|i/o error|mmc|usb'"; fi
else
  note "the kernel log needs the systemd-journal group (skipped)"
fi
[ -d /var/log/journal ] && ok "the journal is persistent" || warn "the journal is not persistent (logs are lost at a reboot)"

head1 "Write speed of the card"
if command -v python3 >/dev/null 2>&1; then
  RES=$(python3 - <<'PY'
import os, time
p = os.path.expanduser('~/.postboot_fsync_test')
worst = 0.0
total = 0.0
n = 30
fd = os.open(p, os.O_CREAT | os.O_WRONLY | os.O_TRUNC)
for _ in range(n):
    t = time.time()
    os.write(fd, b'x' * 4096)
    os.fsync(fd)
    d = time.time() - t
    total += d
    worst = max(worst, d)
os.close(fd)
os.remove(p)
print("%.3f %.3f" % (worst, total / n))
PY
)
  WORST=${RES% *}; AVG=${RES#* }
  if awk "BEGIN{exit !($WORST < 0.5)}"; then ok "30 small writes with fsync: worst ${WORST}s, average ${AVG}s"
  else warn "a write took ${WORST}s (average ${AVG}s): the card may stall; run this again and compare with the old card"; fi
fi

head1 "Time and network"
if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ]; then ok "the clock is synchronized ($(date '+%Y-%m-%d %H:%M:%S %Z'))"
else warn "the clock is not synchronized yet ($(date '+%Y-%m-%d %H:%M:%S %Z')); give it a minute and run again"; fi
if command -v nmcli >/dev/null 2>&1; then
  LINE=$(nmcli -t -f IN-USE,FREQ dev wifi 2>/dev/null | grep '^\*' | head -1)
  FREQ=$(printf '%s' "$LINE" | cut -d: -f2 | tr -dc '0-9')
  if [ -z "$FREQ" ]; then warn "Wi-Fi is not connected (or nmcli cannot see it)"
  elif [ "$FREQ" -lt 3000 ]; then ok "Wi-Fi is on 2.4 GHz (${FREQ} MHz)"
  else warn "Wi-Fi is on 5 GHz (${FREQ} MHz); this pool Pi was locked to 2.4 GHz after the Oct 4 outage"; fi
fi
GW=$(ip route 2>/dev/null | awk '/default/ {print $3; exit}')
if [ -n "$GW" ] && ping -c 2 -W 2 "$GW" >/dev/null 2>&1; then ok "the gateway $GW answers"
else fail "the gateway does not answer: the Pi is not reaching the network"; fi

head1 "Services (pm2)"
if command -v pm2 >/dev/null 2>&1; then
  pm2 jlist 2>/dev/null | python3 -c '
import json, sys, time
try:
    items = json.load(sys.stdin)
except Exception:
    print("FAIL pm2 did not answer"); sys.exit()
want = ["njsPC", "REM", "dashPanel"]
seen = {i["name"]: i for i in items}
for n in want:
    i = seen.get(n)
    if not i:
        print("FAIL %s is not in pm2" % n); continue
    st = i["pm2_env"]["status"]; rs = i["pm2_env"].get("restart_time", 0)
    up = int((time.time() * 1000 - i["pm2_env"].get("pm_uptime", 0)) / 1000)
    print("%s %s is %s, up %ds, %d restarts" % ("OK" if st == "online" else "FAIL", n, st, up, rs))
' | while read -r KIND REST; do
    case "$KIND" in OK) ok "$REST";; FAIL) fail "$REST";; esac
  done
else
  fail "pm2 is not installed or not on the path"
fi
if ss -ltn 2>/dev/null | grep -q ':4200 '; then ok "njsPC is listening on 4200"; else fail "nothing is listening on 4200 (njsPC)"; fi
if ss -ltn 2>/dev/null | grep -q ':8090 '; then ok "REM is listening on 8090"; else fail "nothing is listening on 8090 (REM)"; fi
if [ -d "$NJSPC/.git" ]; then note "njsPC: $(git -C "$NJSPC" log --oneline -1 2>/dev/null | cut -c1-100)"; fi
if [ -d "$REM/.git" ]; then note "REM:   $(git -C "$REM" log --oneline -1 2>/dev/null | cut -c1-100)"; fi

head1 "Tunnel, watchdog and jobs"
if systemctl is-enabled cloudflared >/dev/null 2>&1 && systemctl is-active cloudflared >/dev/null 2>&1; then
  NR=$(systemctl show cloudflared -p NRestarts --value 2>/dev/null)
  if [ "${NR:-0}" -le 2 ]; then ok "cloudflared is enabled and running ($NR restarts); check the tunnel from your phone on mobile data"
  else warn "cloudflared has restarted $NR times since boot: systemctl status cloudflared"; fi
else
  warn "cloudflared is not enabled and running (ignore this if you do not use the tunnel)"
fi
if systemctl is-active pool-watchdog.timer >/dev/null 2>&1; then ok "the pool watchdog timer is active"; else fail "the pool watchdog timer is not active"; fi
JOBS=$(crontab -l 2>/dev/null | grep -c 'pool-')
if [ "${JOBS:-0}" -ge 1 ]; then ok "$JOBS pool cron job(s) in your crontab"; else warn "no pool cron jobs in your crontab (backup and trim)"; fi
if [ -d "$HOME/pool-backups" ]; then
  LAST=$(ls -1t "$HOME"/pool-backups/*.tar.gz 2>/dev/null | head -1)
  [ -n "$LAST" ] && note "newest backup: $(basename "$LAST")" || warn "no backups in ~/pool-backups"
fi

head1 "RS485, relays and the chlorinator"
[ -e /dev/ttyUSB0 ] && ok "the RS485 adapter is at /dev/ttyUSB0" || fail "no /dev/ttyUSB0: the RS485 adapter is not seen"
[ -e /dev/i2c-1 ] && ok "the I2C bus is present (/dev/i2c-1)" || fail "no /dev/i2c-1: the relay board bus is not seen (enable I2C?)"
if [ -r "$PM2LOGS/REM-out.log" ]; then
  FOUND=$(grep -a "Found I2C device" "$PM2LOGS/REM-out.log" 2>/dev/null | tail -1)
  [ -n "$FOUND" ] && ok "REM found the relay board: $(printf '%s' "$FOUND" | cut -c1-100)" || warn "REM has not logged finding the relay board yet"
fi
if command -v curl >/dev/null 2>&1; then
  curl -s --max-time 5 localhost:4200/state/autoSwg 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("WARN njsPC did not answer the AutoSwg state request"); sys.exit()
print("OK AutoSwg state: away=%s, last applied %s%% at %s" % (d.get("awayStatus"), d.get("lastAppliedPct"), d.get("lastAppliedAt")))
o = d.get("outages") or []
if o:
    x = o[-1]
    print("OK AutoSwg recorded the outage from %s to %s (%s minutes%s): this is the swap" % (x.get("from"), x.get("to"), x.get("minutes"), ", the computer restarted" if x.get("rebooted") else ""))
else:
    print("WARN no outage recorded yet: it is recorded when njsPC starts after being down 25 minutes or more")
' | while read -r KIND REST; do case "$KIND" in OK) ok "$REST";; WARN) warn "$REST";; esac; done
  CID=$(curl -s --max-time 5 localhost:4200/config/autoSwg 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("chlorinatorId",""))' 2>/dev/null)
  if [ -n "$CID" ] && [ "$CID" != "-1" ]; then
    curl -s --max-time 5 "localhost:4200/state/chlorinator/$CID" 2>/dev/null | python3 -c '
import json, sys, time
d = json.load(sys.stdin)
lc = d.get("lastComm")
age = int(time.time() - lc / 1000) if isinstance(lc, (int, float)) and lc > 0 else None
print("INFO chlorinator %s: status %s, set %s%%, output %s%%, last heard %s" % (d.get("name"), d.get("status", {}).get("desc") if isinstance(d.get("status"), dict) else d.get("status"), d.get("poolSetpoint"), d.get("currentOutput"), ("%ds ago" % age) if age is not None else "never"))
' 2>/dev/null | while read -r KIND REST; do note "$REST"; done
    note "if the SWG relay is off (outside its run window), the chlorinator not answering is normal"
  fi
fi
if [ -r "$PM2LOGS/njsPC-out.log" ]; then
  SEV=$(tail -n 2000 "$PM2LOGS/njsPC-out.log" 2>/dev/null | grep -ac "SEVERE\|communications stalled")
  [ "${SEV:-0}" -eq 0 ] && ok "no SEVERE or stalled-poll lines in the recent njsPC log" || warn "$SEV SEVERE or stalled-poll lines in the recent njsPC log: grep -a 'SEVERE' $PM2LOGS/njsPC-out.log | tail"
fi

echo
echo "Done: $FAILS FAIL, $WARNS WARN."
exit "$FAILS"

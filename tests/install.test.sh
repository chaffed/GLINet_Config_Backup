#!/bin/sh
# The package as people get it: the .ipk, installed with opkg on a clean
# OpenWrt 23.05 (a container), then upgraded to a newer release, removed and
# installed again. Settings and the passphrase must come through all of it.
# Needs Docker.
#
# Run: sh tests/install.test.sh
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/.test-out/install"   # inside the repo: Docker Desktop does not share the system temp folder
rm -rf "$OUT"
mkdir -p "$OUT"
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$ROOT/luci-app-autobackup/Makefile")
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$ROOT/luci-app-autobackup/Makefile")
sh "$ROOT/scripts/build-ipk.sh" "$OUT" >/dev/null
AUTOBACKUP_RELEASE=$((RELEASE + 1)) sh "$ROOT/scripts/build-ipk.sh" "$OUT" >/dev/null

docker run --rm --platform linux/amd64 -v "$OUT:/dist:ro" -e VERSION="$VERSION" -e RELEASE="$RELEASE" openwrt/rootfs:x86-64-23.05.6 sh -c '
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=$((fail + 1)); }
check() { if eval "$1" >/dev/null 2>&1; then ok "$2"; else bad "$2"; fi; }
this=/dist/luci-app-autobackup_${VERSION}-r${RELEASE}_all.ipk
newer=/dist/luci-app-autobackup_${VERSION}-r$((RELEASE + 1))_all.ipk
mode() { ls -l "$1" | cut -c1-10; }
mkdir -p /var/lock /var/run
opkg update >/dev/null 2>&1 || { echo "FAIL opkg update (no network?)"; exit 1; }

# ------------------------------------------------------------ clean install
opkg install "$this" >/tmp/install.log 2>&1 || { cat /tmp/install.log; echo "FAIL the package does not install"; exit 1; }
check "opkg list-installed | grep -q \"^luci-app-autobackup - ${VERSION}-r${RELEASE}\$\"" "clean install: ${VERSION}-r${RELEASE} installs with its dependencies"
check "[ \"\$(autobackup version)\" = \"$VERSION\" ]" "clean install: the program says it is $VERSION"
check "[ \"\$(mode /etc/config/autobackup_auth)\" = -rw------- ]" "clean install: the passphrase file is readable by root only"
check "[ \"\$(uci -q get autobackup.main.schedule)\" = off ] && [ \"\$(uci -q get autobackup.main.keep)\" = 10 ]" "clean install: default settings (no schedule, keep 10)"
check "[ ! -e /etc/uci-defaults/80_autobackup ] && [ -d /etc/autobackup ]" "clean install: the first-run script ran"
check "[ -x /etc/init.d/autobackup ] && ls /etc/rc.d/ | grep -q autobackup" "clean install: the schedule is applied at every start"
check "! grep -q autobackup /etc/crontabs/root 2>/dev/null" "clean install: no schedule until one is chosen"

# what the owner then does
mkdir -p /etc/crontabs
echo "0 1 * * * /bin/someone-elses-job" >> /etc/crontabs/root
autobackup set keep=7 hour=4 schedule=daily >/dev/null
uci set autobackup_auth.main.passphrase="it'"'"'s a secret"
uci commit autobackup_auth
kept() {
	[ "$(uci -q get autobackup.main.keep)" = 7 ] && [ "$(uci -q get autobackup.main.hour)" = 4 ] &&
	grep -q "^30 4 \* \* \* /usr/bin/autobackup backup --scheduled" /etc/crontabs/root &&
	[ "$(uci -q get autobackup_auth.main.passphrase)" = "it'"'"'s a secret" ] &&
	[ "$(mode /etc/config/autobackup_auth)" = -rw------- ]
}

# ------------------------------------------------------------------ upgrade
opkg install "$newer" >/tmp/upgrade.log 2>&1 || cat /tmp/upgrade.log
check "opkg list-installed | grep -q \"^luci-app-autobackup - ${VERSION}-r$((RELEASE + 1))\$\"" "upgrade: a newer release installs over it"
check kept "upgrade: settings and passphrase are kept, the passphrase file still root only"
check "! ls /etc/config/ | grep -q -- -opkg" "upgrade: no stray copies of the settings files are left behind"

# ------------------------------------------------------ remove, install again
opkg remove luci-app-autobackup >/tmp/remove.log 2>&1 || cat /tmp/remove.log
check "[ ! -e /usr/bin/autobackup ] && [ ! -e /etc/init.d/autobackup ] && ! ls /etc/rc.d/ | grep -q autobackup" "remove: the program and its start script are gone"
check "! grep -q autobackup /etc/crontabs/root && grep -q someone-elses-job /etc/crontabs/root" "remove: the schedule is taken out of cron, other jobs stay"
check "[ -s /etc/config/autobackup ] && [ -s /etc/config/autobackup_auth ]" "remove: settings and passphrase stay on the router"
opkg install "$this" >/tmp/again.log 2>&1 || cat /tmp/again.log
check kept "install again: picks up the kept settings and passphrase, and the schedule is back in cron"
check "! ls /etc/config/ | grep -q -- -opkg" "install again: no stray copies"

[ "$fail" = 0 ] && echo && echo "all checks passed"
[ "$fail" = 0 ] || { echo; echo "$fail check(s) failed"; exit 1; }
'

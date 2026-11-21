#!/bin/sh
# Build luci-app-autobackup_<version>-r<release>_all.ipk without the OpenWrt
# SDK. The package is architecture independent (shell, Lua and JavaScript),
# so this works on any Linux or macOS machine with tar and gzip.
#
# Usage: scripts/build-ipk.sh [output-dir]
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PKG=luci-app-autobackup
SRC="$ROOT/$PKG"
VERSION=$(sed -n 's/^PKG_VERSION:=//p' "$SRC/Makefile")
# AUTOBACKUP_RELEASE: another release number (tests/install.test.sh makes a
# newer package of the same files to upgrade to).
RELEASE=${AUTOBACKUP_RELEASE:-$(sed -n 's/^PKG_RELEASE:=//p' "$SRC/Makefile")}
OUT=${1:-"$ROOT/dist"}

export COPYFILE_DISABLE=1   # no macOS ._ files in the archives
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data/www" "$WORK/control" "$OUT"
OUT=$(cd "$OUT" && pwd)
IPK="$OUT/${PKG}_${VERSION}-r${RELEASE}_all.ipk"

cp -R "$SRC/root/." "$WORK/data/"
[ -d "$SRC/htdocs" ] && cp -R "$SRC/htdocs/." "$WORK/data/www/"
find "$WORK/data" -type f -exec chmod 644 {} +
find "$WORK/data" -type d -exec chmod 755 {} +
for f in usr/bin/autobackup etc/init.d/autobackup usr/libexec/rpcd/luci.autobackup etc/uci-defaults/*; do
	for g in "$WORK/data/"$f; do
		[ -f "$g" ] && chmod 755 "$g"
	done
done
# Root only: the passphrase file.
chmod 600 "$WORK/data/etc/config/autobackup_auth"
rmdir "$WORK/data/www" 2>/dev/null || true

SIZE=$(du -sk "$WORK/data" | cut -f1)
cat > "$WORK/control/control" <<CTRL
Package: $PKG
Version: ${VERSION}-r${RELEASE}
Depends: libc, luci-base, jsonfilter, openssl-util
Source: https://github.com/chaffed/GLINet_Config_Backup
SourceName: $PKG
License: MIT
Section: luci
Architecture: all
Installed-Size: $((SIZE * 1024))
Description: Auto Backup - scheduled config backups to USB, manual restore.
 Saves the router's configuration (sysupgrade -b) to a USB drive on a
 schedule, optionally encrypted, keeps the newest ones, and restores a
 chosen backup after checking it fits this router.
CTRL
printf '/etc/config/autobackup\n/etc/config/autobackup_auth\n' > "$WORK/control/conffiles"

cat > "$WORK/control/postinst" <<'POST'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
for f in /etc/uci-defaults/80_autobackup; do
	[ -f "$f" ] && ( . "$f" ) && rm -f "$f"
done
exit 0
POST
cat > "$WORK/control/prerm" <<'PRERM'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
# Take the schedule out of cron (the settings stay).
[ -x /usr/bin/autobackup ] && /usr/bin/autobackup cron-remove 2>/dev/null
/etc/init.d/autobackup disable 2>/dev/null
exit 0
PRERM
cat > "$WORK/control/postrm" <<'POSTRM'
#!/bin/sh
[ -n "$IPKG_INSTROOT" ] && exit 0
rm -f /tmp/luci-indexcache* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
/etc/init.d/rpcd reload 2>/dev/null
# GL.iNet admin panel: drop Auto Backup's panel module from memory.
if [ -d /usr/lib/oui-httpd/rpc ] && [ -s /var/run/nginx.pid ] && [ -x /usr/sbin/nginx ]; then
	/usr/sbin/nginx -s reload 2>/dev/null
fi
exit 0
POSTRM
chmod 755 "$WORK/control/postinst" "$WORK/control/prerm" "$WORK/control/postrm"

# GNU tar and bsdtar spell "owned by root" differently.
if tar --version 2>/dev/null | grep -q GNU; then
	TAROPTS="--owner=0 --group=0 --numeric-owner --format=gnu"
else
	TAROPTS="--uid 0 --gid 0 --numeric-owner --format=gnutar"
fi

# shellcheck disable=SC2086
( cd "$WORK/data" && tar $TAROPTS -czf ../data.tar.gz . )
# shellcheck disable=SC2086
( cd "$WORK/control" && tar $TAROPTS -czf ../control.tar.gz . )
echo "2.0" > "$WORK/debian-binary"
# shellcheck disable=SC2086
( cd "$WORK" && tar $TAROPTS -cf - ./debian-binary ./data.tar.gz ./control.tar.gz | gzip -n > "$IPK" )

echo "$IPK"

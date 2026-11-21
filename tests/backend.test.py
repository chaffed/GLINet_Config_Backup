#!/usr/bin/env python3
"""Backend test: the real `autobackup` in an OpenWrt 23.05 container.

Runs the backend inside a container (the same busybox sh, sysupgrade,
openssl and jsonfilter as on the router), with a folder of this machine
mounted where GL.iNet mounts a USB drive, and checks what it wrote.
Needs docker and python3.

Usage: python3 tests/backend.test.py
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = "autobackup-test-openwrt"
DRIVE = "/tmp/mountd/disk1_part1"
# Characters that break naive quoting in shell, JSON, UCI and openssl.
PASSPHRASE = "Pa ss,w\"o'r$d\\`1 %s"

failures = []

with open(os.path.join(ROOT, "luci-app-autobackup", "Makefile")) as _f:
    VERSION = re.search(r"^PKG_VERSION:=(\S+)", _f.read(), re.M).group(1)


def check(cond, what):
    print(("ok   " if cond else "FAIL ") + what)
    if not cond:
        failures.append(what)


# Each container starts like a GL-BE9300: GL's model and board files, the
# firmware version, and packages installed on top of the firmware (the
# firmware's own list in /rom lacks two of them).
SETUP = r"""
set -u
cp -R /pkg/. /
chmod 755 /usr/bin/autobackup /etc/init.d/autobackup 2>/dev/null
mkdir -p /var/run /var/lock /tmp/sysinfo /rom/usr/lib/opkg
echo 'qcom,ipq5332-ap-mi01.6' > /tmp/sysinfo/board_name
echo 'GL.iNet BE9300, Inc. IPQ5332/AP-MI01.6' > /tmp/sysinfo/model
echo '4.10.1' > /etc/glversion
awk 'BEGIN { RS = ""; ORS = "\n\n" } !/^Package: (openssl-util|jsonfilter)\n/' /usr/lib/opkg/status > /rom/usr/lib/opkg/status
# The container has no system settings; the router's name lives there.
printf "config system\n\toption hostname 'GL-BE9300'\n" > /etc/config/system
sh /etc/uci-defaults/80_autobackup
o() { "$@" > "/out/$step.json" 2>"/out/$step.err"; echo $? > "/out/$step.rc"; }
"""


# A restore writes the whole backup over /etc; Docker mounts its own
# /etc/hosts, /etc/hostname and /etc/resolv.conf there, which cannot be
# replaced (on a router nothing is mounted there). Restore tests run
# privileged and unmount them first; reboot is replaced by a marker.
RESTORE_SETUP = r"""
umount /etc/hosts /etc/hostname /etc/resolv.conf 2>/dev/null
rm -f /sbin/reboot
printf '#!/bin/sh\ndate +%s >> /out/rebooted.txt\n' > /sbin/reboot
chmod 755 /sbin/reboot
"""


def run(script, drive=None, name="run", restore=False):
    """Run SETUP + script in a container; /out is a fresh folder returned to
    the caller, and `drive` (a folder here) is mounted as the USB drive."""
    out = tempfile.mkdtemp(prefix=name + "-", dir=os.path.join(ROOT, ".test-out"))
    args = ["docker", "run", "--rm", "--platform", "linux/amd64"] + (["--privileged"] if restore else []) + [
            "-v", os.path.join(ROOT, "luci-app-autobackup", "root") + ":/pkg:ro",
            "-v", out + ":/out"]
    if drive:
        args += ["-v", drive + ":" + DRIVE]
    # The backend writes root-only files (umask 077); on Linux the test
    # (not root) could not read them back.
    tail = "\nchmod -R a+rwX /out %s 2>/dev/null; true\n" % (DRIVE if drive else "")
    subprocess.run(args + [IMAGE, "sh", "-c", SETUP + (RESTORE_SETUP if restore else "") + script + tail], check=True)
    return out


def read(out, step, kind="json"):
    path = os.path.join(out, step + "." + kind)
    if not os.path.exists(path):
        return None
    with open(path, errors="replace") as f:
        text = f.read()
    if kind == "json":
        try:
            return json.loads(text)
        except ValueError:
            return {"_unparsed": text}
    return text.strip()


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def host_dir(drive):
    return os.path.join(drive, "autobackup", "GL-BE9300")


def main():
    subprocess.run(["docker", "build", "-q", "--platform", "linux/amd64", "-t", IMAGE,
                    os.path.join(ROOT, "tests", "openwrt")], check=True, stdout=subprocess.DEVNULL)
    os.makedirs(os.path.join(ROOT, ".test-out"), exist_ok=True)
    work = tempfile.mkdtemp(prefix="backend-", dir=os.path.join(ROOT, ".test-out"))

    # ------------------------------------------------------ a normal backup
    drive = os.path.join(work, "drive")
    os.makedirs(drive)
    out = run(r"""
step=status0; o autobackup status
step=backup1; o autobackup backup
step=backup2; o autobackup backup
step=list; o autobackup list
step=status; o autobackup status
step=version; o autobackup version
ls -la /tmp/autobackup > /out/tmp.txt 2>&1
logread > /out/log.txt 2>/dev/null || true
""", drive, "normal")
    st0 = read(out, "status0")
    check(st0.get("drive") == DRIVE and st0.get("drives") == [DRIVE], "status: finds the drive GL.iNet mounted")
    check(st0.get("last") is None and st0.get("last_ok") == 0, "status: no backup yet")
    check(st0.get("router", {}).get("model") == "be9300" or st0.get("router", {}).get("board") == "qcom,ipq5332-ap-mi01.6",
          "status: names this router's model and board")
    check(st0.get("router", {}).get("firmware") == "4.10.1", "status: GL firmware version from /etc/glversion")
    check(isinstance(st0.get("free_kb"), int) and st0["free_kb"] > 0, "status: free space on the drive")
    check(read(out, "version", "json") is not None and read(out, "version", "err") == "" and
          open(os.path.join(out, "version.json")).read().strip() == VERSION, "version: matches the Makefile (%s)" % VERSION)

    b1, b2 = read(out, "backup1"), read(out, "backup2")
    check(b1.get("ok") is True and b2.get("ok") is True, "backup: two backups succeed")
    check(b1.get("id") != b2.get("id"), "backup: two backups in the same second get different names")
    hd = host_dir(drive)
    names = sorted(os.listdir(hd)) if os.path.isdir(hd) else []
    archives = [n for n in names if n.endswith(".tar.gz")]
    records = [n for n in names if n.endswith(".json")]
    check(len(archives) == 2 and len(records) == 2 and len(names) == 4,
          "backup: an archive and a record each, in autobackup/<hostname>/ (%s)" % names)
    check(all(re.match(r"^(be9300|qcom_ipq5332-ap-mi01\.6)_4\.10\.1_\d{8}-\d{6}(-\d+)?\.tar\.gz$", a) for a in archives),
          "backup: named <model>_<firmware>_<date-time>")
    rec = {}
    if records:
        with open(os.path.join(hd, records[0])) as f:
            rec = json.load(f)
        arch = os.path.join(hd, rec.get("file", "?"))
        check(os.path.isfile(arch), "record: names its archive")
        check(rec.get("size") == os.path.getsize(arch) and rec.get("sha256") == sha256(arch), "record: size and sha256 match the archive")
        check(rec.get("board") == "qcom,ipq5332-ap-mi01.6" and rec.get("firmware") == "4.10.1" and rec.get("hostname") == "GL-BE9300",
              "record: board, firmware and hostname of the router")
        check(rec.get("encrypted") is False, "record: not encrypted by default")
        check(rec.get("packages_known") is True and sorted(rec.get("packages", [])) == ["jsonfilter", "openssl-util"],
              "record: lists exactly the packages installed on top of the firmware (%s)" % rec.get("packages"))
        with tarfile.open(arch) as t:
            members = t.getnames()
        check("etc/config/system" in members and "etc/config/autobackup" in members,
              "archive: a sysupgrade backup with the router's settings and Auto Backup's own")
    lst = read(out, "list")
    ids = [b.get("id") for b in lst.get("backups", [])]
    check(lst.get("drive") == DRIVE and len(ids) == 2 and ids[0] == b2.get("id"), "list: both backups, newest first")
    check(all(b.get("missing") is False for b in lst.get("backups", [])), "list: archives are there")
    st = read(out, "status")
    check(st.get("last", {}).get("result") == "ok" and st.get("last", {}).get("id") == b2.get("id") and st.get("last_ok", 0) > 0,
          "status: the last backup succeeded")
    check(read(out, "tmp", "txt").count("\n") <= 3, "backup: leaves nothing behind in /tmp/autobackup")

    # -------------------------------------------------------------- keep
    drive = os.path.join(work, "keep")
    os.makedirs(drive)
    # A backup of another router on the same drive is never pruned.
    other = os.path.join(drive, "autobackup", "Other-Router")
    os.makedirs(other)
    with open(os.path.join(other, "x_4.10.1_20200101-000000.json"), "w") as f:
        json.dump({"format": 1, "file": "x_4.10.1_20200101-000000.tar.gz", "time": 1}, f)
    with open(os.path.join(other, "x_4.10.1_20200101-000000.tar.gz"), "wb") as f:
        f.write(b"x")
    # A record edited by hand (a trailing comma, which jsonfilter lets pass
    # but strict parsers such as the GL panel's do not) and one that is not
    # JSON at all.
    with open(os.path.join(other, "y_4.10.1_20200102-000000.json"), "w") as f:
        f.write('{"format":1,"file":"y_4.10.1_20200102-000000.tar.gz","time":2,"packages":["a",],}')
    with open(os.path.join(other, "y_4.10.1_20200102-000000.tar.gz"), "wb") as f:
        f.write(b"y")
    with open(os.path.join(other, "z.json"), "w") as f:
        f.write('{"time":3, broken')
    out = run(r"""
uci set autobackup.main.keep=3; uci commit autobackup
for i in 1 2 3 4 5; do step=b$i; o autobackup backup; sleep 1; done
step=list; o autobackup list
""", drive, "keep")
    made = [read(out, "b%d" % i).get("id") for i in range(1, 6)]
    left = sorted(n for n in os.listdir(host_dir(drive)))
    check(len(left) == 6, "keep 3: three backups (archive + record) are left of five (%d files)" % len(left))
    check(all(any(n.startswith(i.split("/")[1] + ".") for n in left) for i in made[2:]), "keep 3: the three newest")
    check(os.path.exists(os.path.join(other, "x_4.10.1_20200101-000000.tar.gz")), "keep: another router's backups are not touched")
    lst = read(out, "list")
    check(len(lst.get("backups", [])) == 5, "list: shows other routers' backups on the drive too")
    check("_unparsed" not in lst and any(b.get("packages") == ["a"] for b in lst.get("backups", [])),
          "list: strict JSON even with a hand-edited record (rewritten); a record that is not JSON is left out")

    # ------------------------------------------------------- missing drive
    out = run(r"""
mkdir -p /tmp/mountd/disk1_part1   # what an unplugged drive leaves behind
step=nodrive; o autobackup backup
step=status; o autobackup status
step=list; o autobackup list
find /tmp/mountd > /out/left.txt
uci set autobackup.main.drive=/mnt/sda1; uci commit autobackup
step=missing; o autobackup backup --scheduled
step=status2; o autobackup status
logread > /out/log.txt 2>/dev/null || true
""", None, "nodrive")
    r = read(out, "nodrive")
    check(r.get("ok") is False and r.get("reason") == "no_drive" and read(out, "nodrive", "rc") == "1",
          "no drive: the backup fails with reason no_drive")
    check(read(out, "left", "txt").split() == ["/tmp/mountd", DRIVE], "no drive: nothing is written to the empty mount point")
    st = read(out, "status")
    check(st.get("drive") == "" and st.get("drive_reason") == "no_drive" and st.get("last", {}).get("result") == "failed"
          and st.get("last", {}).get("reason") == "no_drive", "no drive: status says why the last backup failed")
    check(read(out, "list").get("backups") == [] and read(out, "list").get("reason") == "no_drive", "no drive: an empty list, with the reason")
    r = read(out, "missing")
    check(r.get("reason") == "drive_missing" and read(out, "status2").get("drive_reason") == "drive_missing",
          "chosen drive not plugged in: reason drive_missing")

    # ------------------------------------------------------------ schedule
    out = run(r"""
mkdir -p /etc/crontabs
echo '0 1 * * * /bin/someone-elses-job' > /etc/crontabs/root
step=daily; o autobackup set schedule=daily hour=4 minute=5
cp /etc/crontabs/root /out/cron_daily.txt
step=st_daily; o autobackup status
date +%s > /out/now.txt
step=weekly; o autobackup set schedule=weekly weekday=2 hour=23 minute=59
cp /etc/crontabs/root /out/cron_weekly.txt
step=st_weekly; o autobackup status
step=config; o autobackup config
for bad in hour=24 minute=60 minute=5x schedule=hourly keep=0 keep=101 weekday=7 drive=/etc drive=/mnt/../etc 'drive=/mnt/a b' color=red encrypt=2; do
	autobackup set "$bad" >> /out/bad.txt 2>&1
done
autobackup set keep=5 hour=99 >> /out/bad.txt 2>&1
step=config2; o autobackup config
step=enc; o autobackup set encrypt=1
step=off; o autobackup set schedule=off
cp /etc/crontabs/root /out/cron_off.txt
step=st_off; o autobackup status
autobackup set schedule=daily >/dev/null
autobackup cron-remove
cp /etc/crontabs/root /out/cron_removed.txt
""", None, "schedule")
    check(read(out, "daily").get("ok") is True, "set: a daily schedule is stored")
    cron = read(out, "cron_daily", "txt").splitlines()
    check(cron == ["0 1 * * * /bin/someone-elses-job",
                   "5 4 * * * /usr/bin/autobackup backup --scheduled >/dev/null 2>&1 # autobackup"],
          "cron: daily at 04:05, other jobs kept (%s)" % cron)
    now = int(read(out, "now", "txt"))
    nr = read(out, "st_daily").get("next_run", 0)
    import time as _t
    tm = _t.gmtime(nr)
    sd = read(out, "st_daily")
    check((sd.get("schedule"), sd.get("hour"), sd.get("minute")) == ("daily", 4, 5), "status: the schedule's time (for the pages)")
    check(now < nr <= now + 86400 and (tm.tm_hour, tm.tm_min, tm.tm_sec) == (4, 5, 0),
          "status: next daily run is the next 04:05 (container time is UTC)")
    cron = read(out, "cron_weekly", "txt").splitlines()
    check(cron[-1].startswith("59 23 * * 2 /usr/bin/autobackup backup --scheduled") and len(cron) == 2,
          "cron: weekly on Tuesday at 23:59 replaces the daily line")
    nr = read(out, "st_weekly").get("next_run", 0)
    tm = _t.gmtime(nr)
    check(now < nr <= now + 7 * 86400 and (tm.tm_hour, tm.tm_min) == (23, 59) and (tm.tm_wday + 1) % 7 == 2,
          "status: next weekly run is the next Tuesday 23:59")
    cfgj = read(out, "config")
    check(cfgj.get("schedule") == "weekly" and cfgj.get("weekday") == "2" and cfgj.get("keep") == "10"
          and cfgj.get("passphrase_set") is False and "passphrase" not in cfgj, "config: the settings, never a passphrase")
    bad = read(out, "bad", "txt").splitlines()
    check(len(bad) == 13 and all('"ok":false' in b for b in bad), "set: refuses every invalid value and unknown setting")
    check(read(out, "config2") == cfgj, "set: nothing is stored when one value is invalid")
    enc = read(out, "enc")
    check(enc.get("reason") == "no_passphrase", "set: encryption cannot be switched on before a passphrase is set")
    check(read(out, "cron_off", "txt").splitlines() == ["0 1 * * * /bin/someone-elses-job"]
          and read(out, "st_off").get("next_run") == 0, "schedule off: our line is gone, the other job stays")
    check(read(out, "cron_removed", "txt").splitlines() == ["0 1 * * * /bin/someone-elses-job"],
          "cron-remove (package removal): our line is gone, the other job stays")

    # ---------------------------------------------------------- encryption
    drive = os.path.join(work, "enc")
    os.makedirs(drive)
    with open(os.path.join(work, "pass.txt"), "w") as f:
        f.write(PASSPHRASE + "\n")
    shutil.copy(os.path.join(work, "pass.txt"), os.path.join(drive, "..pass"))
    out = run(r"""
pass=$(cat /tmp/mountd/disk1_part1/..pass); rm /tmp/mountd/disk1_part1/..pass
# Every command line on the router while this runs, to look for the passphrase.
( while :; do for c in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$c" 2>/dev/null; echo; done; done >> /out/cmdlines.txt ) &
watch=$!
step=short; f=$(autobackup passphrase-input); printf '%s\n' 'short' > "$f"; o autobackup set-passphrase "$f"
step=outside; echo "$pass" > /tmp/elsewhere; o autobackup set-passphrase /tmp/elsewhere; rm -f /tmp/elsewhere
step=input; o autobackup passphrase-input
f=$(cat /out/input.json); ls -l "$f" | cut -c1-10 > /out/input_mode.txt
printf '%s\n' "$pass" > "$f"
step=setpass; o autobackup set-passphrase "$f"
[ -e "$f" ] && echo left > /out/input_left.txt
ls -l /etc/config/autobackup_auth | cut -c1-10 > /out/auth_mode.txt
step=config; o autobackup config
step=b1; o autobackup backup
kill $watch 2>/dev/null; wait $watch 2>/dev/null
uci -q get autobackup_auth.main.passphrase > /out/stored.txt
a=$(jsonfilter -i /out/b1.json -e @.file)
uci -q get autobackup_auth.main.passphrase > /tmp/p
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$a" -out /tmp/plain.tar.gz -pass file:/tmp/p 2>/out/dec.err
tar tzf /tmp/plain.tar.gz > /out/plain_list.txt 2>&1
tar xzf /tmp/plain.tar.gz -O etc/config/autobackup_auth > /out/auth_in_backup.txt 2>&1
rm -f /tmp/p /tmp/plain.tar.gz
step=status; o autobackup status
# Missing passphrase (settings edited by hand): fail, never a plain backup.
printf "\nconfig auth 'main'\n" > /etc/config/autobackup_auth
step=nopass; o autobackup backup
ls /tmp/mountd/disk1_part1/autobackup/GL-BE9300/ > /out/files_nopass.txt
# Encryption off forgets the passphrase; the next backup has none in it.
f=$(autobackup passphrase-input); printf '%s\n' "$pass" > "$f"; autobackup set-passphrase "$f" >/dev/null
step=off; o autobackup set encrypt=0
step=config_off; o autobackup config
step=b2; o autobackup backup
tar xzf "$(jsonfilter -i /out/b2.json -e @.file)" -O etc/config/autobackup_auth > /out/auth_in_plain.txt 2>&1
logread > /out/log.txt 2>/dev/null || true
cat /var/log/messages >> /out/log.txt 2>/dev/null || true
grep -rlF -- "$pass" /tmp /var/run /etc/autobackup /out/*.json /out/*.err 2>/dev/null | grep -v '^/tmp/mountd' > /out/leaks.txt
true
""", drive, "enc")
    check(read(out, "short").get("reason") == "invalid_passphrase", "passphrase: shorter than 8 characters is refused")
    check(read(out, "outside").get("reason") == "no_input", "passphrase: only files made by passphrase-input are read")
    check(read(out, "input_mode", "txt") == "-rw-------", "passphrase-input: the file is root only")
    check(read(out, "setpass").get("ok") is True and read(out, "input_left", "txt") is None,
          "set-passphrase: stored, and the input file is deleted")
    check(read(out, "stored", "txt") == PASSPHRASE, "set-passphrase: quoting characters survive (stored exactly)")
    check(read(out, "auth_mode", "txt") == "-rw-------", "set-passphrase: the passphrase file stays root only")
    cfgj = read(out, "config")
    check(cfgj.get("encrypt") == "1" and cfgj.get("passphrase_set") is True and PASSPHRASE not in json.dumps(cfgj),
          "set-passphrase: encryption is on; config says a passphrase is set, never what it is")
    b1 = read(out, "b1")
    hd = host_dir(drive)
    rec = {}
    if b1.get("ok"):
        with open(os.path.join(hd, b1["id"].split("/")[1] + ".json")) as f:
            rec = json.load(f)
    arch = os.path.join(hd, rec.get("file", "?"))
    check(rec.get("encrypted") is True and rec.get("file", "").endswith(".tar.gz.enc"), "encrypted backup: .tar.gz.enc, record says encrypted")
    check(os.path.isfile(arch) and open(arch, "rb").read(8) == b"Salted__" and rec.get("sha256") == sha256(arch),
          "encrypted backup: an openssl file; the record's sha256 is of the encrypted file")
    check("etc/config/system" in read(out, "plain_list", "txt") and read(out, "dec", "err") == "",
          "encrypted backup: decrypts with the passphrase to the router's settings")
    uci_form = "option passphrase '" + PASSPHRASE.replace("'", "'\\''") + "'"
    check(uci_form in read(out, "auth_in_backup", "txt"), "encrypted backup: holds the passphrase (inside the encryption only)")
    check(read(out, "status").get("encrypt") is True and read(out, "status").get("passphrase_set") is True, "status: encryption on")
    check(read(out, "nopass").get("reason") == "no_passphrase" and not any(n.endswith(".tar.gz") for n in read(out, "files_nopass", "txt").split()),
          "no passphrase: the backup fails, never falls back to an unencrypted file")
    check(read(out, "off").get("ok") is True and read(out, "config_off").get("passphrase_set") is False
          and read(out, "config_off").get("encrypt") == "0", "encryption off: the passphrase is forgotten")
    check(read(out, "b2").get("ok") is True and PASSPHRASE not in read(out, "auth_in_plain", "txt")
          and "config auth" in read(out, "auth_in_plain", "txt"), "unencrypted backup: holds no passphrase")
    cmdlines = read(out, "cmdlines", "txt")
    check("openssl" in cmdlines and PASSPHRASE not in cmdlines, "passphrase: never in a command line (openssl was seen running)")
    check(PASSPHRASE not in (read(out, "log", "txt") or ""), "passphrase: never in the log")
    check(read(out, "leaks", "txt") == "", "passphrase: in no file in /tmp, /var/run, /etc/autobackup or the output (%s)" % read(out, "leaks", "txt"))
    leaked_drive = []
    for dp, _, fs in os.walk(drive):
        for n in fs:
            if not n.endswith(".enc") and PASSPHRASE.encode() in open(os.path.join(dp, n), "rb").read():
                leaked_drive.append(n)
    check(leaked_drive == [], "passphrase: on the drive only inside encrypted files (%s)" % leaked_drive)

    # ------------------------------------------------------------- restore
    drive = os.path.join(work, "restore")
    os.makedirs(drive)
    out = run(r"""
H=/tmp/mountd/disk1_part1/autobackup/GL-BE9300
domain() { uci -q get dhcp.@dnsmasq[0].domain; }
uci set dhcp.@dnsmasq[0].domain=before; uci commit dhcp
step=b; o autobackup backup
id=$(jsonfilter -i /out/b.json -e @.id); n=${id#*/}
uci set dhcp.@dnsmasq[0].domain=after; uci commit dhcp

# Copies of the backup with records edited to other routers and firmware.
copy() { # copy NEW 'sed expression for the record'
	cp "$H/$n.tar.gz" "$H/$1.tar.gz"
	sed -e "s/\"file\":\"$n.tar.gz\"/\"file\":\"$1.tar.gz\"/" -e "$2" "$H/$n.json" > "$H/$1.json"
}
copy othermodel 's/"model":"[^"]*"/"model":"mt6000"/'
copy otherboard 's/"board":"[^"]*"/"board":"glinet,gl-mt6000"/'
copy otherfw 's/"firmware":"4.10.1"/"firmware":"4.9.0"/'
copy extrapkg 's/"packages":\[/"packages":["luci-app-not-here",/'
copy damaged 's/x/x/'; echo x >> "$H/damaged.tar.gz"
copy gone 's/x/x/'; rm "$H/gone.tar.gz"

step=check; o autobackup restore-check "$id"
step=check_model; o autobackup restore-check GL-BE9300/othermodel
step=check_board; o autobackup restore-check GL-BE9300/otherboard
step=check_fw; o autobackup restore-check GL-BE9300/otherfw
step=check_pkg; o autobackup restore-check GL-BE9300/extrapkg
step=check_damaged; o autobackup restore-check GL-BE9300/damaged
step=check_gone; o autobackup restore-check GL-BE9300/gone
step=check_none; o autobackup restore-check GL-BE9300/nothing
step=check_bad; o autobackup restore-check ../../etc/passwd

step=noyes; o autobackup restore "$id"
step=model; o autobackup restore GL-BE9300/othermodel --yes --force-firmware --force-unverified
step=damaged; o autobackup restore GL-BE9300/damaged --yes
step=fw; o autobackup restore GL-BE9300/otherfw --yes
echo "$(domain)" > /out/domain_refused.txt
[ -e /out/rebooted.txt ] && echo yes > /out/rebooted_early.txt

step=restore; o autobackup restore "$id" --yes
sleep 5
echo "$(domain)" > /out/domain_restored.txt
cat /etc/autobackup/restored > /out/restored_state.txt

uci set dhcp.@dnsmasq[0].domain=after2; uci commit dhcp
step=fw_forced; o autobackup restore GL-BE9300/otherfw --yes --force-firmware
sleep 5
echo "$(domain)" > /out/domain_forced.txt

# A file uploaded from a computer: no record, so the model cannot be checked.
uci set dhcp.@dnsmasq[0].domain=after3; uci commit dhcp
cp "$H/$n.tar.gz" /tmp/autobackup-upload
step=check_upload; o autobackup restore-check upload
step=upload_refused; o autobackup restore upload --yes
step=upload; o autobackup restore upload --yes --force-unverified
sleep 5
echo "$(domain)" > /out/domain_upload.txt
[ -e /tmp/autobackup-upload ] && echo left > /out/upload_left.txt
echo 'not a backup at all' > /tmp/autobackup-upload
step=check_junk; o autobackup restore-check upload
printf 'x' | gzip > /tmp/autobackup-upload
step=check_gzjunk; o autobackup restore-check upload
rm -f /tmp/autobackup-upload
step=check_noupload; o autobackup restore-check upload
step=empty; o autobackup restore
wc -l < /out/rebooted.txt > /out/reboots.txt
ls -A /tmp/autobackup > /out/tmp_left.txt 2>&1
""", drive, "restore", restore=True)
    c = read(out, "check")
    check(c.get("restorable") is True and c.get("blocked") == "" and c.get("warnings") == [] and c.get("encrypted") is False,
          "restore-check: this router's own backup can be restored")
    check(c.get("record", {}).get("sha256") and c.get("router", {}).get("firmware") == "4.10.1", "restore-check: shows the record and this router")
    check(c.get("missing_packages") == [], "restore-check: no add-ons missing when all are installed")
    check(read(out, "check_pkg").get("missing_packages") == ["luci-app-not-here"], "restore-check: lists add-ons the backup had that are not installed")
    check(read(out, "check_model").get("blocked") == "other_model" and read(out, "check_model").get("restorable") is False,
          "restore-check: another model is blocked")
    check(read(out, "check_board").get("blocked") == "other_model", "restore-check: another board is blocked")
    f = read(out, "check_fw")
    check(f.get("restorable") is True and f.get("warnings") == ["other_firmware"], "restore-check: other firmware is a warning")
    check(read(out, "check_damaged").get("blocked") == "checksum_mismatch", "restore-check: a damaged archive is blocked (sha256)")
    check(read(out, "check_gone").get("blocked") == "archive_missing", "restore-check: a record without its archive is blocked")
    check(read(out, "check_none").get("blocked") == "not_found" and read(out, "check_bad").get("blocked") == "not_found",
          "restore-check: unknown and unsafe names are not found")
    check(read(out, "noyes").get("reason") == "not_confirmed", "restore: refused without --yes")
    check(read(out, "model").get("reason") == "other_model", "restore: another model is refused, whatever the options")
    check(read(out, "damaged").get("reason") == "checksum_mismatch", "restore: a damaged archive is refused")
    check(read(out, "fw").get("reason") == "other_firmware", "restore: other firmware is refused without --force-firmware")
    check(read(out, "domain_refused", "txt") == "after" and read(out, "rebooted_early", "txt") is None,
          "restore: refusals change nothing and do not restart the router")
    check(read(out, "restore") == {"ok": True, "rebooting": True}, "restore: succeeds and says the router restarts")
    check(read(out, "domain_restored", "txt") == "before", "restore: the settings are those of the backup")
    check("source=" + read(out, "b").get("id", "?") in (read(out, "restored_state", "txt") or ""), "restore: noted in /etc/autobackup/restored")
    check(read(out, "domain_forced", "txt") == "before", "restore: other firmware with --force-firmware")
    u = read(out, "check_upload")
    check(u.get("restorable") is True and u.get("warnings") == ["unverified"] and u.get("record") is None,
          "upload: can be restored, with the warning that its model cannot be checked")
    check(read(out, "upload_refused").get("reason") == "unverified", "upload: refused without --force-unverified")
    check(read(out, "domain_upload", "txt") == "before" and read(out, "upload_left", "txt") is None,
          "upload: restored with --force-unverified, and the uploaded file is removed")
    check(read(out, "check_junk").get("blocked") == "not_a_backup" and read(out, "check_gzjunk").get("blocked") == "not_a_backup",
          "upload: a file that is not a backup is blocked")
    check(read(out, "check_noupload").get("blocked") == "not_found", "upload: nothing uploaded, not found")
    check(read(out, "empty").get("reason") == "not_confirmed" and read(out, "empty", "rc") == "1", "restore: no arguments is refused cleanly")
    check(read(out, "reboots", "txt") == "3", "restore: the router restarts once per restore (3)")
    check(read(out, "tmp_left", "txt") == "", "restore: no decrypted or scratch files are left behind")

    # --------------------------------------------------- encrypted restore
    drive = os.path.join(work, "restore_enc")
    os.makedirs(drive)
    with open(os.path.join(drive, "..pass"), "w") as f:
        f.write(PASSPHRASE + "\n")
    out = run(r"""
pass=$(cat /tmp/mountd/disk1_part1/..pass); rm /tmp/mountd/disk1_part1/..pass
H=/tmp/mountd/disk1_part1/autobackup/GL-BE9300
domain() { uci -q get dhcp.@dnsmasq[0].domain; }
setpass() { f=$(autobackup passphrase-input); printf '%s\n' "$1" > "$f"; autobackup set-passphrase "$f" >/dev/null; }
uci set dhcp.@dnsmasq[0].domain=encrypted; uci commit dhcp
setpass "$pass"
step=b; o autobackup backup
id=$(jsonfilter -i /out/b.json -e @.id)
uci set dhcp.@dnsmasq[0].domain=later; uci commit dhcp
step=check_stored; o autobackup restore-check "$id"
# A new passphrase: the old backup needs the old one typed in.
setpass 'a different passphrase'
step=check_new; o autobackup restore-check "$id"
step=nopass; o autobackup restore "$id" --yes
f=$(autobackup passphrase-input); printf '%s\n' 'wrong wrong wrong' > "$f"
step=wrong; o autobackup restore "$id" --yes --passphrase-file "$f"
[ -e "$f" ] && echo left > /out/wrong_left.txt
echo "$(domain)" > /out/domain_wrong.txt
( while :; do for c in /proc/[0-9]*/cmdline; do tr '\0' ' ' < "$c" 2>/dev/null; echo; done; done >> /out/cmdlines.txt ) &
watch=$!
f=$(autobackup passphrase-input); printf '%s\n' "$pass" > "$f"
step=right; o autobackup restore "$id" --yes --passphrase-file "$f"
kill $watch 2>/dev/null; wait $watch 2>/dev/null
sleep 5
[ -e "$f" ] && echo left > /out/right_left.txt
echo "$(domain)" > /out/domain_right.txt
uci -q get autobackup_auth.main.passphrase > /out/pass_after.txt
cp "$(ls $H/*.enc | head -n 1)" /tmp/autobackup-upload
step=check_upload; o autobackup restore-check upload
ls -A /tmp/autobackup > /out/tmp_left.txt 2>&1
grep -rlF -- "$pass" /tmp /var/run /out/*.json 2>/dev/null | grep -v '^/tmp/mountd' > /out/leaks.txt
true
""", drive, "restore_enc", restore=True)
    c = read(out, "check_stored")
    check(c.get("restorable") is True and c.get("encrypted") is True and c.get("needs_passphrase") is False,
          "encrypted restore-check: opens with the stored passphrase")
    c = read(out, "check_new")
    check(c.get("restorable") is False and c.get("needs_passphrase") is True and c.get("blocked") == "",
          "encrypted restore-check: after a passphrase change, asks for the old one")
    check(read(out, "nopass").get("reason") == "needs_passphrase", "encrypted restore: refused without a passphrase that opens it")
    check(read(out, "wrong").get("reason") == "wrong_passphrase" and read(out, "wrong_left", "txt") is None
          and read(out, "domain_wrong", "txt") == "later", "encrypted restore: a wrong passphrase changes nothing; its file is deleted")
    check(read(out, "right") == {"ok": True, "rebooting": True} and read(out, "domain_right", "txt") == "encrypted"
          and read(out, "right_left", "txt") is None, "encrypted restore: the typed passphrase restores the settings")
    check(read(out, "pass_after", "txt") == PASSPHRASE, "encrypted restore: brings back the passphrase of that time")
    cu = read(out, "check_upload")
    check(cu.get("encrypted") is True and cu.get("restorable") is True, "encrypted upload: recognised, opens with the stored passphrase")
    check(PASSPHRASE not in read(out, "cmdlines", "txt") and "openssl" in read(out, "cmdlines", "txt"),
          "encrypted restore: the passphrase is never in a command line")
    check(read(out, "tmp_left", "txt") == "" and read(out, "leaks", "txt") == "",
          "encrypted restore: no decrypted archive or passphrase left behind (%s)" % read(out, "leaks", "txt"))

    # ------------------------------------------------- delete, busy, names
    drive = os.path.join(work, "delete")
    os.makedirs(drive)
    with open(os.path.join(drive, "precious.txt"), "w") as f:
        f.write("keep me")
    out = run(r"""
step=b1; o autobackup backup
step=b2; o autobackup backup
id=$(jsonfilter -i /out/b1.json -e @.id)
for bad in '../precious' 'GL-BE9300/../../precious' '/etc/passwd' 'GL-BE9300/' 'GL-BE9300/.hidden' "$id/x" '' 'a b/c'; do
	autobackup delete "$bad" >> /out/bad.txt 2>&1
done
step=del; o autobackup delete "$id"
step=list; o autobackup list
# Another run holds the lock.
( exec 9>/var/lock/autobackup.lock; flock 9; sleep 4 ) &
sleep 1
step=busy; o autobackup backup
step=busystatus; o autobackup status
step=busydel; o autobackup delete "$(jsonfilter -i /out/b2.json -e @.id)"
wait
step=after; o autobackup status
""", drive, "delete")
    bad = read(out, "bad", "txt").splitlines()
    check(len(bad) == 8 and all('"reason":"not_found"' in line for line in bad), "delete: refuses names outside the backup folder")
    check(os.path.exists(os.path.join(drive, "precious.txt")), "delete: nothing outside the backup folder is removed")
    lst = read(out, "list")
    b1 = read(out, "b1").get("id")
    check(read(out, "del").get("ok") is True and [b["id"] for b in lst.get("backups", [])] == [read(out, "b2").get("id")],
          "delete: removes the backup and its record")
    check(len(os.listdir(host_dir(drive))) == 2 and not any(n.startswith(b1.split("/")[1] + ".") for n in os.listdir(host_dir(drive))),
          "delete: both files are gone from the drive")
    busy = read(out, "busy")
    check(busy.get("ok") is False and busy.get("reason") == "busy", "two at once: the second backup answers busy")
    check(read(out, "busystatus").get("busy") is True, "two at once: status says a backup is running")
    check(read(out, "busydel").get("reason") == "busy", "two at once: delete waits its turn too")
    after = read(out, "after")
    check(after.get("last", {}).get("result") == "ok" and after.get("busy") is False,
          "two at once: a busy answer does not count as a failed backup")

    shutil.rmtree(work, ignore_errors=True)
    if failures:
        print("\n%d check(s) failed" % len(failures))
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()

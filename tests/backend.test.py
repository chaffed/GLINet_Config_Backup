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


def run(script, drive=None, name="run"):
    """Run SETUP + script in a container; /out is a fresh folder returned to
    the caller, and `drive` (a folder here) is mounted as the USB drive."""
    out = tempfile.mkdtemp(prefix=name + "-", dir=os.path.join(ROOT, ".test-out"))
    args = ["docker", "run", "--rm", "--platform", "linux/amd64",
            "-v", os.path.join(ROOT, "luci-app-autobackup", "root") + ":/pkg:ro",
            "-v", out + ":/out"]
    if drive:
        args += ["-v", drive + ":" + DRIVE]
    subprocess.run(args + [IMAGE, "sh", "-c", SETUP + script], check=True)
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
    check(len(read(out, "list").get("backups", [])) == 4, "list: shows other routers' backups on the drive too")

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

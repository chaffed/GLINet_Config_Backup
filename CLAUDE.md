# GLINet_Config_Backup

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for chaffed/GLINet_Config_Backup, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: one root `GLOSSARY.md` and ADRs in `docs/adr/`, both created when first needed. See `docs/agents/domain.md`.

## Working on this repo

- **Auto Backup** (`luci-app-autobackup`): saves the router's configuration (`sysupgrade -b`) to a USB drive on a schedule and restores a chosen backup by hand. The spec is issue #1.
- Sibling projects: ISPy (`chaffed/luci-app-ispy`, in `~/GLI_SpeedTest`) and Modem Health (`chaffed/luci-app-modemhealth`, in `~/GLI_CableModem_Health`). This app copies their package layout, build and tests. Their `CLAUDE.md` files describe the GL.iNet admin panel's undocumented interface: read them before working on the web UI or the panel.
- The real test router is a GL-BE9300 (GL firmware 4.10.1, OpenWrt 23.05), reached as `ssh root@192.168.8.1`, with a USB drive at `/tmp/mountd/disk1_part1`. A restore replaces its settings and reboots it, so never restore on it without the owner.
- The package's version is `PKG_VERSION` in the Makefile and `VERSION` in `/usr/bin/autobackup`; the tests read it from the Makefile and hold the two together.
- `sh tests/install.test.sh` installs the `.ipk` with opkg on a clean OpenWrt 23.05 container, upgrades it, removes it and installs it again (settings and the passphrase must come through). Run it after touching `scripts/build-ipk.sh`, `root/etc/uci-defaults/` or the list of packaged files. Test output goes to `.test-out/` because Docker Desktop on macOS doesn't share the system temp folder.
- Tagging `vX.Y.Z` on main makes CI publish the release with the `.ipk`.
- Run `python3 tests/backend.test.py` after touching the backend (`luci-app-autobackup/root/usr/bin/autobackup`). It runs the real backend in an OpenWrt 23.05 container with a folder of this machine mounted at `/tmp/mountd/disk1_part1` as the USB drive, made to look like a GL-BE9300 (board name, `/etc/glversion`, and a `/rom` package list so the record's add-on list can be checked).
- Backend shell rules learned the hard way: a helper that sets variables or a trap (`resolve_drive`, `work_file`) must be called directly, never in `$(...)` (a subshell loses them; a lost scratch name once made the clean-up `rm -f .*`). Busybox `df` wraps a long file-system name onto two lines, so use `df -kP`.
- A drive is a mount point listed in `/proc/mounts` under `/tmp/mountd/` or `/mnt/`. Nothing is written to a path that is not one (an unplugged drive leaves an empty folder in RAM); such a run is stored as failed with the reason (`no_drive`, `drive_missing`). A "busy" answer is not stored as a result.
- Settings are checked in one place, the backend's `check_setting` (`autobackup set KEY=VALUE...`, all or nothing); the LuCI and GL pages go through it. `autobackup config` never prints the passphrase, only `passphrase_set`. The schedule is one line in `/etc/crontabs/root` ending in `# autobackup`; only that line is ever touched (`cron-sync` on every start and settings change, `cron-remove` when the package is removed). Busybox `sort` ignores per-key flags such as `-k1,1nr`: sort on one number.
- Encryption: `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt`, passphrase given only as `-pass file:` (a root-only scratch file). The passphrase never travels as an argument: pages ask `autobackup passphrase-input` for a root-only file, write it there and pass the file's name (`set-passphrase FILE`, later `restore … --passphrase-file FILE`); the backend reads and deletes it, and accepts no other path. `write_auth` writes `/etc/config/autobackup_auth` by hand because `uci set` would take the passphrase as an argument. Setting a passphrase turns encryption on and `set encrypt=0` forgets it (also enforced by the first-run script), because a backup includes Auto Backup's own settings: an unencrypted backup must never hold the passphrase. The backend test watches every process's command line during an encrypted backup and searches logs and scratch folders for the passphrase.
- Restore (`autobackup restore SRC --yes …`, SRC = a backup's id or `upload` for `/tmp/autobackup-upload`) runs the same checks as `restore-check` first: sha256 against the record, same model *and* board or refused (no override), other firmware only with `--force-firmware`, an upload (no record, model unknown) only with `--force-unverified`, encrypted backups opened with the stored passphrase or `--passphrase-file`. It runs `sysupgrade -r` on the decrypted copy in RAM, notes it in `/etc/autobackup/restored` and reboots 3 s later in the background (the router has no `setsid`). The restore tests run the container `--privileged` to unmount Docker's `/etc/hosts`, `/etc/hostname` and `/etc/resolv.conf` (which `sysupgrade -r` cannot replace) and replace `/sbin/reboot` with a marker.
- The pages are one module, `htdocs/luci-static/resources/autobackup/app.js` (`mount(env, page)` draws Status, Backups or Settings). LuCI's views are three-line shells around it with `autobackup/luci.js` as `env` (rpcd object `luci.autobackup`, `fs.read_direct` for downloads, `cgi-upload` to `/tmp/autobackup-upload`); the GL panel's `autobackup/gl.js` is the other `env`. So a page change is made once, and every setting is checked by the backend alone. In LuCI, `E(tag, attrs, 'string')` sets innerHTML: text from the drive or the router always goes in as an array child.
- `node tests/luci.test.js` (needs Docker, Chrome and `npm install --no-save playwright-core`) drives the pages in LuCI on OpenWrt 23.05 in a container: back up, schedule, encrypt, download, restore (reboot replaced by a marker), upload and restore, delete, with a record full of markup on the drive. The drive is mounted at `/mnt/sda1` (procd mounts a fresh `/tmp` at boot, hiding `/tmp/mountd`). The container gets `SYS_ADMIN` to unmount Docker's `/etc/hosts` for restores; `--privileged` would let netifd take over its network. Screenshots land in `.test-out/luci/`: look at them. `AB_KEEP=1` leaves the container up (http://127.0.0.1:18580, root / luci-test).

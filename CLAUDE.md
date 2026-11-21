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

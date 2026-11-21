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

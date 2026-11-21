# Auto Backup

**Auto Backup** is an app for GL.iNet and OpenWrt routers. It saves the
router's settings to a USB drive on a schedule and keeps the newest ones. It
can encrypt them with a passphrase. If something goes wrong (a bad change, a
reset, a firmware update that lost your settings), you pick a backup and
restore it in a couple of clicks.

GL.iNet's firmware has no automatic backup. Its only backup is a manual one in
LuCI (**System → Backup / Flash Firmware**). Auto Backup makes the same kind
of backup (`sysupgrade -b`), on a schedule, and keeps them on a drive you
can take away.

It appears in GL's own admin panel (**System → Auto Backup**) and, where
LuCI is installed, in LuCI (**System → Auto Backup**).

> [!WARNING]
> **Tested so far only on a GL.iNet GL-BE9300 (Flint 3) with firmware
> 4.10.1**, both as the main router and as a mesh node. It should work on any
> GL.iNet router on firmware 4.x, and on OpenWrt 21.02 to 24.10, but that
> has not been tried yet. The app says so on any other router.
>
> On another model, make a backup and **try restoring it** before you rely
> on it. Please [open an issue](https://github.com/chaffed/GLINet_Config_Backup/issues)
> with your model and firmware, whether it worked or not, so it can be added
> to the tested list.

## What it does

- **Backs up on a schedule**: every day or every week at a time you choose,
  or only when you press **Back up now**.
- **Keeps the newest backups** (10 by default) and deletes older ones.
- **Encrypts backups** if you want (AES-256, with a passphrase you choose).
- **Records what each backup came from**: the router's model, firmware
  version, a checksum, and the add-ons that were installed.
- **Restores safely.** Before restoring, it checks that:
  - the backup file isn't damaged (the checksum matches);
  - it was made on **the same router model**. A backup from another model
    is refused, because it could leave the router unusable;
  - it was made on the same firmware. If not, it asks you to confirm.

  It also lists add-ons the backup's router had that aren't installed now.
- **Download and upload**: download any backup to your computer, or upload one
  (for example one you saved with LuCI) and restore it.
- **Fails loudly, never quietly.** If the drive isn't plugged in, the backup
  fails and the Status page says why. Nothing is written to the router's own
  memory instead.

## What a backup contains, and what it doesn't

A backup is the router's **settings**: Wi-Fi networks and passwords, the
network setup, firewall and port forwards, VPN configurations and keys, the
admin password, and the settings of installed apps. It's the same file
LuCI's "Generate archive" makes.

It does **not** contain:

- **Add-ons (packages)** installed on top of the firmware. Their settings are
  in the backup, but the add-ons themselves aren't. Each backup lists them,
  and the restore dialog shows which are missing so you can reinstall them.
- **The firmware.** A backup is meant to go back onto the same model. Use the
  same firmware version where you can.

Because a backup holds passwords and keys, treat the USB drive like a key
to your network, or turn on encryption.

## Install

### From the package source (recommended)

Add chaffed's package source once. It also carries
[ISPy](https://github.com/chaffed/luci-app-ispy) and
[Modem Health](https://github.com/chaffed/luci-app-modemhealth). Log in to
the router over SSH and run:

```sh
wget -O /tmp/chaffed.pub https://chaffed.github.io/openwrt-packages/chaffed.pub
opkg-key add /tmp/chaffed.pub
echo 'src/gz chaffed https://chaffed.github.io/openwrt-packages' >> /etc/opkg/customfeeds.conf
opkg update
opkg install luci-app-autobackup
```

Later versions arrive like any other package: `opkg update && opkg upgrade luci-app-autobackup`.

### From a release

Download `luci-app-autobackup_*_all.ipk` from
[Releases](https://github.com/chaffed/GLINet_Config_Backup/releases), then:

```sh
scp -O luci-app-autobackup_*_all.ipk root@192.168.8.1:/tmp/
ssh root@192.168.8.1 'opkg update && opkg install /tmp/luci-app-autobackup_*_all.ipk'
```

Either way, `opkg` also installs what Auto Backup needs that the router
lacks: `luci-base`, `jsonfilter` and `openssl-util`. The router needs an
internet connection for that. The package works on any router, whatever its
processor.

Then open the GL admin panel, sign in again, and go to **System → Auto Backup**.

### The USB drive

Plug a USB drive into the router. GL.iNet firmware mounts it by itself.
On plain OpenWrt, `block-mount` mounts it under `/mnt/`. Any drive the router
can mount works. **ext4** is the most reliable. FAT32 and exFAT work if the
router supports them.

Backups go into `autobackup/<router name>/` on the drive. Several routers,
for example a main router and its mesh nodes, can share one drive. Each uses
its own folder.

## Using it

### Status

Shows:

- the drive and its free space;
- the last backup, and whether it worked;
- the last successful backup;
- the schedule and the next run;
- encryption on or off.

**Back up now** makes a backup straight away.

### Backups

Lists the backups on the drive, newest first. Each one can be
**downloaded**, **restored** or **deleted**. Backups of other routers on
the same drive are shown too, and marked as such.
**Upload a backup and restore it…** restores a file from your computer.

### Settings

| Setting | |
|---|---|
| **Back up** | Every day, every week (pick the day), or only when you press Back up now. |
| **Time** | In the router's time zone (System → Time Zone). |
| **Keep** | How many of this router's backups to keep (1–100, default 10). Older ones are deleted after each backup. |
| **Save to** | The first USB drive found, or a particular one. |
| **Encrypt backups** | See below. |

## Encryption

Tick **Encrypt backups** and choose a passphrase of 8 characters or more.
Backups made from then on are encrypted with AES-256 (`openssl`, PBKDF2 with
200,000 rounds) and end in `.tar.gz.enc`.

- **Write the passphrase down.** Without it, an encrypted backup can't be
  restored, not even on the same router after a reset.
- The passphrase is stored on the router, readable only by root, so that
  scheduled backups can run unattended. Encryption protects your settings
  if the **USB drive** is lost or stolen. It doesn't protect them from
  someone who can already sign in to the router.
- If you **change the passphrase**, older backups still need the old one.
  When you restore one, the app asks for it.
- If you **turn encryption off**, the passphrase is forgotten, so an
  unencrypted backup never contains it.
- The pages never show the passphrase. It never appears in the router's
  process list or logs, and you can't read it back.

To open an encrypted backup on a computer:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in backup.tar.gz.enc -out backup.tar.gz
```

## Restoring

1. On **Backups**, choose **Restore…** next to a backup, or upload one.
2. Read what the dialog says:
   - **a different router model**: the restore is refused;
   - **other firmware**, or an **uploaded file** whose model can't be
     checked: tick the box to go on;
   - **an encrypted backup** the current passphrase doesn't open: enter the
     passphrase it was made with;
   - **add-ons** the backup had that aren't installed: reinstall them,
     before or after.
3. Choose **Restore and restart**. The router's settings are replaced and it
   restarts. Everything connected loses its connection for a minute or two.
   If the backup has another router address or Wi-Fi network, reconnect to
   that.

A restore brings back **all** the settings of that time, including Auto
Backup's own: its schedule and, for an encrypted backup, the passphrase of
that time.

> [!TIP]
> Have mesh nodes? Try your first restore on a node rather than the main
> router. If something goes wrong, the rest of the network stays up.

## Troubleshooting

| What you see | What it means |
|---|---|
| "No USB drive is plugged in" | Plug one in. If it is plugged in, the router couldn't mount it. Try formatting it as ext4. |
| "The chosen USB drive is not plugged in" | **Save to** names a drive that isn't there. Plug it in, or choose **The first USB drive found**. |
| "The backup could not be written to the USB drive" | The drive is full or read-only. Free some space, or lower **Keep**. |
| "Encryption is on, but no passphrase is set" | Set one in Settings. (This only happens if the settings were edited by hand.) |
| "This backup was made on a different router model" | It can't be restored here. Restore it on the router it came from. |
| "The backup file is damaged" | The file no longer matches the checksum recorded when it was made. Use another backup. |
| "That passphrase does not open this backup" | Enter the passphrase that was set when the backup was made. |
| No **Auto Backup** under System in the GL panel | Sign out of the panel and in again. If it's still missing: `ssh root@192.168.8.1 /usr/sbin/nginx -s reload`. |
| GL panel won't open on a mesh node from a Mac (`ERR_ADDRESS_UNREACHABLE`) | macOS blocks the browser from local devices. Allow it in System Settings → Privacy & Security → Local Network, then restart the browser. |

Messages go to the system log: `logread -e autobackup`.

## Command line

Everything the pages do is also a command (`autobackup` with no arguments
lists them). Each one answers in JSON:

```sh
autobackup backup                 # back up now
autobackup list                   # the backups on the drive
autobackup status                 # drive, last result, schedule
autobackup set schedule=daily hour=3 minute=30 keep=10
autobackup restore-check GL-BE9300/be9300_4.10.1_20261121-033000
```

## Remove

```sh
opkg remove luci-app-autobackup
```

This removes the app and its schedule. The settings (`/etc/config/autobackup*`)
stay on the router, and the backups stay on the drive.

## Development

The package is architecture independent (shell, Lua and JavaScript).
`scripts/build-ipk.sh` builds the `.ipk` without the OpenWrt SDK. The tests
run the real backend and pages in OpenWrt 23.05 containers. See `CLAUDE.md`
for how they work and which one to run after what. Tagging `vX.Y.Z` on main
makes CI publish a release.

## License

MIT

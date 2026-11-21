-- Auto Backup for the GL.iNet admin panel (luci-app-autobackup).
-- set_config, set_passphrase and restore check every value themselves
-- (/usr/lib/oui-httpd/rpc/autobackup, then /usr/bin/autobackup). The
-- panel's default check only allows letters, digits and " .-_:#/", which
-- would refuse an ordinary passphrase. The other methods keep it.
-- SPDX-License-Identifier: MIT
return { set_config = true, set_passphrase = true, restore = true }

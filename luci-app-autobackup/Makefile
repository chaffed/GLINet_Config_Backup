# Auto Backup - scheduled configuration backups to a USB drive, for LuCI and
# the GL.iNet admin panel.
# Drop this directory into an OpenWrt/LuCI feed (feeds/luci/applications/)
# or build a standalone .ipk with scripts/build-ipk.sh.
#
# SPDX-License-Identifier: MIT

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-autobackup
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT

LUCI_TITLE:=Auto Backup - scheduled config backups to USB, manual restore
LUCI_DESCRIPTION:=Saves the router's configuration (sysupgrade -b) to a USB \
	drive on a schedule, optionally encrypted, keeps the newest ones, and \
	restores a chosen backup after checking it fits this router.
LUCI_DEPENDS:=+luci-base +jsonfilter +openssl-util
LUCI_PKGARCH:=all

define Package/luci-app-autobackup/conffiles
/etc/config/autobackup
/etc/config/autobackup_auth
endef

include ../../luci.mk

# call BuildPackage - OpenWrt buildroot signature

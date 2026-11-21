# OpenWrt 23.05 with LuCI (the same release and theme as on GL.iNet firmware
# 4.x once LuCI is installed there), for the browser tests. Lua 5.1 with
# cjson and UCI runs the GL.iNet panel's module behind tests/gl/rpc.lua.
FROM openwrt/rootfs:x86-64-23.05.6
RUN mkdir -p /var/lock /var/run && opkg update && opkg install openssl-util luci-light lua lua-cjson libuci-lua && rm -rf /tmp/opkg-lists

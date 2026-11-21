--[[
    The GL.iNet panel's module (/usr/lib/oui-httpd/rpc/autobackup) on its
    own, with a stand-in for the panel's ngx.pipe that notes every command
    and answers as the backend would. Checks what the module refuses before
    running anything, and that a passphrase only ever travels in a file.

    Run (Lua 5.1 with cjson): lua tests/gl_rpc.test.lua
    Without one: docker run --rm -v "$PWD":/src:ro autobackup-test-luci lua /src/tests/gl_rpc.test.lua
--]]

local dir = (arg[0]:match("^(.*)/tests/") or ".")
local cjson = require "cjson"

local spawned, answer = {}, {}
local input_dir = os.tmpname() .. ".d"
os.execute("mkdir -p " .. input_dir)

ngx = {
    pipe = {
        spawn = function(args)
            spawned[#spawned + 1] = table.concat(args, " ")
            local out
            if args[2] == "passphrase-input" then
                out = "/var/run/autobackup/input.Ab12Cd\n"
            else
                out = answer[args[2]] or '{"ok":true}'
            end
            return { stdout_read_all = function() return out end, wait = function() end }
        end,
    },
}

-- The module writes the passphrase into the file the backend named; here
-- that file is redirected into a temporary folder.
local real_open = io.open
io.open = function(path, mode)
    if path:match("^/var/run/autobackup/") then
        return real_open(input_dir .. "/" .. path:match("[^/]+$"), mode)
    end
    return real_open(path, mode)
end

local M = dofile(dir .. "/luci-app-autobackup/root/usr/lib/oui-httpd/rpc/autobackup")

local fail = 0
local function check(cond, what)
    print((cond and "ok   " or "FAIL ") .. what)
    if not cond then fail = fail + 1 end
end
local function last() return spawned[#spawned] end
local function count() return #spawned end

-- Ids
local n = count()
for _, bad in ipairs({ "../x", "a/../../b", "/etc/passwd", "a/b/c", "", "a b/c", "a/.hidden" }) do
    check(M.delete({ id = bad }).reason == "not_found", "delete refuses " .. string.format("%q", bad))
    check(M.check_restore({ src = bad }).blocked == "not_found", "check_restore refuses " .. string.format("%q", bad))
    check(M.restore({ src = bad }).reason == "not_found", "restore refuses " .. string.format("%q", bad))
end
check(M.delete({ id = "upload" }).reason == "not_found", "delete refuses the uploaded file's name")
check(count() == n, "nothing is run for a refused id")
M.check_restore({ src = "GL-BE9300/be9300_4.10.1_20261121-031500" })
check(last() == "/usr/bin/autobackup restore-check GL-BE9300/be9300_4.10.1_20261121-031500", "check_restore runs restore-check with the id")

-- Settings
check(M.set_config({ values = { color = "red" } }).reason == "unknown_setting", "set_config refuses an unknown setting")
check(M.set_config({ values = { hour = "1\n" } }).reason == "invalid_value", "set_config refuses control characters")
check(M.set_config({}).reason == "nothing_to_set", "set_config without values")
M.set_config({ values = { encrypt = false } })
check(last() == "/usr/bin/autobackup set encrypt=0", "set_config turns a boolean into 0/1")
M.set_config({ values = { keep = 7 } })
check(last() == "/usr/bin/autobackup set keep=7", "set_config passes a number as a whole number")

-- Passphrases
local secret = "Pa ss,w\"o'r$d\\`1<b>"
n = count()
check(M.set_passphrase({ passphrase = "a\nb" }).reason == "invalid_passphrase", "set_passphrase refuses a line break")
check(M.set_passphrase({ passphrase = 5 }).reason == "invalid_passphrase", "set_passphrase refuses a non-string")
check(count() == n, "nothing is run for a refused passphrase")
check(M.set_passphrase({ passphrase = secret }).ok == true, "set_passphrase passes the backend's answer on")
check(last() == "/usr/bin/autobackup set-passphrase /var/run/autobackup/input.Ab12Cd", "set_passphrase hands over the file's name")
local f = real_open(input_dir .. "/input.Ab12Cd")
check(f and f:read("*l") == secret, "set_passphrase writes the passphrase, exactly, into the backend's file")
if f then f:close() end
M.restore({ src = "upload", passphrase = secret, force_unverified = true })
check(last() == "/usr/bin/autobackup restore upload --yes --force-unverified --passphrase-file /var/run/autobackup/input.Ab12Cd",
    "restore: options and the passphrase's file, in that order")
M.restore({ src = "upload", force_firmware = "yes" })
check(last() == "/usr/bin/autobackup restore upload --yes", "restore: only a real true forces anything")
local all = table.concat(spawned, "\n")
check(not all:find(secret, 1, true), "a passphrase is never an argument")

-- Answers
answer["status"] = "not json"
local st = M.get_status()
check(st.err_code == -1 and st.err_msg ~= nil, "no answer from the backend becomes the panel's error")
answer["backup"] = '{"ok":false,"reason":"no_drive","detail":""}'
local b = M.backup()
check(b.ok == false and b.reason == "no_drive" and b.err_code == nil, "a failed backup is an answer the page shows, not a panel error")

os.execute("rm -rf " .. input_dir)
if fail > 0 then
    print("\n" .. fail .. " check(s) failed")
    os.exit(1)
end
print("\nall checks passed")

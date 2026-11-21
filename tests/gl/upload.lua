#!/usr/bin/lua
--[[
    A stand-in for the GL.iNet admin panel's /upload, for tests/gl.test.js
    (the browser does not show a file's bytes to the test, so the test
    passes the request on to this). Installed in the test container as
    /www/cgi-bin/gl-upload, it does what the panel's oui-upload.lua does
    (firmware 4.10.1):

    - the fields are read in order; "path" must be allowed by a line of
      /usr/share/gl-upload.d/* (matched as '^' .. line, no ".." or "~"),
      and "sid", "size" and "path" must come before "file";
    - the session must be the panel's (here: "stand-in-session").

    What it saw is written to /tmp/gl-upload.log (one JSON line).
--]]

local cjson = require "cjson"

local function allowed(to)
    if to:match("%.%.") or to:match("~") then return false end
    for conf in io.popen("ls /usr/share/gl-upload.d"):lines() do
        for line in io.lines("/usr/share/gl-upload.d/" .. conf) do
            if #line > 0 and to:match("^" .. line) then return true end
        end
    end
    return false
end

local function finish(status, seen)
    local log = io.open("/tmp/gl-upload.log", "a")
    log:write(cjson.encode(seen), "\n")
    log:close()
    io.write("Status: ", status, "\r\nContent-Type: text/plain\r\n\r\n")
    os.exit(0)
end

local body = io.read(tonumber(os.getenv("CONTENT_LENGTH") or "0") or 0) or ""
local boundary = (os.getenv("CONTENT_TYPE") or ""):match("boundary=(.+)$")
local seen = { order = {}, fields = {} }
if not boundary then finish("400 Bad Request", seen) end
boundary = boundary:gsub('^"', ""):gsub('"$', "")

local sep = "--" .. boundary
local pos = body:find(sep, 1, true)
local fields, file = {}, nil
while pos do
    local start = pos + #sep
    if body:sub(start, start + 1) == "--" then break end
    local head_end = body:find("\r\n\r\n", start, true)
    if not head_end then break end
    local nxt = body:find(sep, head_end, true)
    if not nxt then break end
    local head = body:sub(start + 2, head_end - 1)
    local data = body:sub(head_end + 4, nxt - 3)
    local name = head:match('name="(%w+)"')
    if not name then finish("500 Internal Server Error", seen) end
    seen.order[#seen.order + 1] = name
    if name == "file" then
        file = data
        -- The panel opens the file when the first of it arrives: by then
        -- it must know the session, the size and the path.
        if fields.sid ~= "stand-in-session" or not fields.size or not fields.path then
            seen.refused = "file before sid, size and path, or a wrong session"
            finish("403 Forbidden", seen)
        end
    else
        fields[name] = data
        if name == "path" and not allowed(data) then
            seen.refused = "path not allowed"
            seen.fields = fields
            finish("403 Forbidden", seen)
        end
    end
    pos = nxt
end
seen.fields = fields
if not file then finish("403 Forbidden", seen) end
seen.bytes = #file
local f = io.open(fields.path, "w+")
f:write(file)
f:close()
finish("200 OK", seen)

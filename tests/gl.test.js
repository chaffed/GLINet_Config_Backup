/*
 * The pages inside the GL.iNet admin panel, driven by a real browser.
 *
 * The router is OpenWrt 23.05 in a container (tests/webrig.js) with the
 * package's files. A stand-in for the panel (tests/gl/panel.html) loads the
 * view file the way the panel does and answers $request through
 * tests/gl/rpc.lua, which runs the real module (and so the real backend)
 * the way the panel's web server does. The panel's /upload and /download
 * are not in the container: the test takes those requests itself and holds
 * them to what the panel's own handlers (firmware 4.10.1) require: the
 * session, the fields in their order, and a path allowed by
 * /usr/share/gl-upload.d or gl-download.d, matched the way the panel does.
 * Screenshots are left in .test-out/gl/.
 *
 * Run: node tests/gl.test.js (what it needs: see tests/webrig.js).
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var ok = rig.ok, eq = rig.eq, sleep = rig.sleep, router = rig.router, q = rig.q;

var WEB = rig.WEB, PASS = rig.PASSPHRASE, HOSTILE = rig.HOSTILE, SID = 'stand-in-session';
var SHOTS = path.join(rig.ROOT, '.test-out', 'gl');

/* The panel's check (oui-upload.lua / oui-download.lua: path_is_allowed). */
function allowed(dir, file) {
	return router('P=' + q(file) + ' lua -e ' + q([
		'local to = os.getenv("P")',
		'if to:match("%.%.") or to:match("~") then print("no") return end',
		'for conf in io.popen("ls ' + dir + '"):lines() do',
		'  for line in io.lines("' + dir + '/" .. conf) do',
		'    if #line > 0 and to:match("^" .. line) then print("yes") return end',
		'  end',
		'end',
		'print("no")'
	].join('\n'))).trim() === 'yes';
}

/* multipart/form-data -> [ { name, filename, data (Buffer) } ] in order */
function multipart(buf, type) {
	var m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type || ''), parts = [];
	if (!m)
		return parts;
	var sep = Buffer.from('--' + (m[1] || m[2])), at = buf.indexOf(sep);
	while (at >= 0) {
		var start = at + sep.length;
		if (buf.slice(start, start + 2).toString() === '--')
			break;
		var headEnd = buf.indexOf('\r\n\r\n', start), next = buf.indexOf(sep, headEnd);
		var head = buf.slice(start + 2, headEnd).toString(), data = buf.slice(headEnd + 4, next - 2);
		var name = /name="([^"]*)"/.exec(head), fname = /filename="([^"]*)"/.exec(head);
		parts.push({ name: name && name[1], filename: fname && fname[1], data: data });
		at = next;
	}
	return parts;
}

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var r = await rig.start({ setup: [
		'mkdir -p /www/gl /www/cgi-bin',
		'cp /tests/gl/panel.html /www/gl/panel.html',
		'cp /tests/gl/rpc.lua /www/cgi-bin/gl-rpc && chmod 755 /www/cgi-bin/gl-rpc',
		'cp /tests/gl/upload.lua /www/cgi-bin/gl-upload && chmod 755 /www/cgi-bin/gl-upload',
		/* The panel runs its modules as root; uhttpd runs CGI as root too. */
		'rm -f /tmp/gl-rpc-spawn.log'
	] });
	try {
		var page = r.page, downloads = [];
		var shot = function(name) { return page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
		var domain = function() { return router('uci -q get dhcp.@dnsmasq[0].domain; true').trim(); };
		var setDomain = function(v) { router('uci set dhcp.@dnsmasq[0].domain=' + v + '; uci commit dhcp'); };
		var reboots = function() { return router('cat /out/rebooted.txt 2>/dev/null | wc -l').trim(); };

		/* The panel's /upload: the browser does not show the file's bytes to
		 * the test, so the request goes on to tests/gl/upload.lua, which does
		 * what the panel's handler does and notes what it saw. */
		await page.route('**/upload', function(route) {
			return route.continue({ url: WEB + '/cgi-bin/gl-upload' });
		});
		var uploads = function() {
			return router('cat /tmp/gl-upload.log 2>/dev/null; true').trim().split('\n').filter(Boolean).map(JSON.parse);
		};
		/* The panel's /download: a form with sid, path and filename. */
		await page.route('**/download', async function(route) {
			var req = route.request(), f = new URLSearchParams(req.postData() || '');
			var got = { method: req.method(), type: req.headers()['content-type'], sid: f.get('sid'), path: f.get('path'), filename: f.get('filename') };
			got.allowed = !!got.path && allowed('/usr/share/gl-download.d', got.path);
			downloads.push(got);
			if (got.method !== 'POST' || got.sid !== SID || !got.allowed)
				return route.fulfill({ status: 403, body: '' });
			return route.fulfill({ status: 200, body: rig.routerRead(got.path),
				headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename=' + got.filename } });
		});

		await page.goto(WEB + '/gl/panel.html');
		r.watch();
		await page.waitForFunction(function() { return document.getElementById('menu-label').textContent !== ''; });
		eq(await page.textContent('#menu-label'), 'Auto Backup', 'panel: the menu entry reads "Auto Backup" (i18n file)');
		var fh = await page.waitForSelector('iframe');
		var f = await fh.contentFrame();
		await f.waitForSelector('.autobackup-page h2');
		var body = function() { return f.innerText('body'); };
		/* After a restore the router restarts; the owner opens the panel again. */
		var reopen = async function(query) {
			await page.goto(WEB + '/gl/panel.html' + (query || ''));
			f = await (await page.waitForSelector('iframe')).contentFrame();
			await f.waitForSelector('.autobackup-page h2');
		};
		var waitText = function(re, ms) {
			return f.waitForFunction(function(src) { return new RegExp(src).test(document.body.innerText); }, re.source, { timeout: ms || 30000 }).catch(async function(e) {
				console.log('--- waiting for ' + re + ', the page says:\n' + await f.innerText('body').catch(function() { return '(gone)'; }) + '\n--- uploads: ' + JSON.stringify(uploads()));
				throw e;
			});
		};

		/* ------------------------------------------------------------- Status */
		ok(/Auto Backup/.test(await body()) && /No backup yet/.test(await body()), 'status: opens in the panel, no backup yet');
		ok(/Not tested on this router yet/.test(await body()), 'status: the untested-router notice');
		setDomain('before');
		await f.click('button:has-text("Back up now")');
		await waitText(/Backup saved/);
		await waitText(/Succeeded/);
		ok(true, 'back up now: saved, and Status shows it');
		await shot('status');

		/* ----------------------------------------------------------- Settings */
		await f.click('.abgl-nav button[data-page=settings]');
		await f.waitForSelector('#autobackup-schedule');
		await f.selectOption('#autobackup-schedule', 'daily');
		await f.selectOption('#autobackup-hour', '2');
		await f.selectOption('#autobackup-minute', '30');
		await f.check('#autobackup-encrypt');
		await f.fill('#autobackup-pass', PASS);
		await f.fill('#autobackup-pass2', PASS);
		await f.click('button:has-text("Save")');
		await waitText(/A passphrase is set/, 20000);
		eq(router('uci get autobackup.main.schedule; uci get autobackup.main.hour; uci get autobackup.main.minute; uci get autobackup.main.encrypt; uci get autobackup_auth.main.passphrase').trim().split('\n'),
			[ 'daily', '2', '30', '1', PASS ], 'settings: schedule and encryption stored; the passphrase exactly, through the panel\'s argument check');
		ok(/^30 2 \* \* \* \/usr\/bin\/autobackup backup --scheduled/m.test(router('cat /etc/crontabs/root')), 'settings: cron runs it every day at 02:30');
		await shot('settings');

		setDomain('encrypted');
		await f.click('.abgl-nav button[data-page=status]');
		await f.click('button:has-text("Back up now")');
		await waitText(/Backup saved/);
		setDomain('later');

		/* ------------------------------------------------------------ Backups */
		router([
			'd=/mnt/sda1/autobackup/Other_Router; mkdir -p $d; printf x > $d/evil.tar.gz',
			'cat > $d/evil.json <<\'J\'',
			JSON.stringify({ format: 1, file: 'evil.tar.gz', time: 1700000000, hostname: HOSTILE, model: HOSTILE, board: 'x', firmware: HOSTILE, size: 1, sha256: rig.sha256('x'), encrypted: false, packages: [] }),
			'J'
		].join('\n'));
		await f.click('.abgl-nav button[data-page=backups]');
		await f.waitForSelector('table.autobackup-list');
		var rows = await f.$$eval('table.autobackup-list tr.tr:not(.table-titles)', function(t) { return t.map(function(x) { return x.innerText; }); });
		ok(rows.length === 3 && /Encrypted/.test(rows[0]) && rows[2].indexOf(HOSTILE) >= 0, 'backups: three rows, the encrypted one marked, markup shown as text');
		await shot('backups');

		var dl = await Promise.all([ page.waitForEvent('download'), f.click('table.autobackup-list tr.tr:nth-child(3) button:has-text("Download")') ]);
		var plainFile = path.join(r.out, 'plain.tar.gz');
		fs.copyFileSync(await dl[0].path(), plainFile);
		var d = downloads[0] || {};
		eq([ d.method, d.sid, d.allowed, /^\/mnt\/sda1\/autobackup\/GL-BE9300\/[^/]+\.tar\.gz$/.test(d.path || '') ], [ 'POST', SID, true, true ],
			'download: posted to the panel\'s /download with its session and an allowed path');
		var rec = router('cat ' + q(d.path.replace(/\.tar\.gz$/, '.json')));
		ok(rig.sha256(fs.readFileSync(plainFile)) === JSON.parse(rec).sha256, 'download: the archive, byte for byte');
		ok(!allowed('/usr/share/gl-download.d', '/etc/config/autobackup_auth') && !allowed('/usr/share/gl-download.d', '/mnt/sda1/autobackup/../../etc/shadow')
			&& !allowed('/usr/share/gl-download.d', '/mnt/sda1/autobackup/GL-BE9300/x.json'), 'download: the allow-list lets out backups only');

		/* Upload and restore. */
		setDomain('later');
		await f.setInputFiles('.autobackup-page input[type=file]', plainFile);
		await waitText(/Restore this backup\?/);
		var u = uploads()[0] || { fields: {} };
		eq([ u.order, u.fields.sid, +u.fields.size, u.bytes, u.fields.path, u.refused ], [ [ 'sid', 'size', 'path', 'file' ], SID, fs.statSync(plainFile).size, fs.statSync(plainFile).size, '/tmp/autobackup-upload', undefined ],
			'upload: the panel\'s /upload gets sid, size and path before the file, at an allowed path');
		ok(/no record of the router it came from/.test(await body()), 'upload: warns that the model cannot be checked');
		await f.check('#autobackup-ok-unverified');
		await shot('restore-upload');
		await f.click('button:has-text("Restore and restart")');
		await waitText(/router is restarting/);
		await sleep(5000);
		eq([ domain(), reboots() ], [ 'before', '1' ], 'upload: restored, and the router restarts');
		await reopen();

		/* Encrypted restore with a passphrase typed in the panel. */
		router('f=$(autobackup passphrase-input); echo "something else entirely" > "$f"; autobackup set-passphrase "$f" >/dev/null');
		setDomain('later');
		await f.click('.abgl-nav button[data-page=backups]');
		await f.waitForSelector('table.autobackup-list');
		await f.click('table.autobackup-list tr.tr:nth-child(2) button:has-text("Restore")');
		await f.waitForSelector('#autobackup-restore-pass');
		await f.fill('#autobackup-restore-pass', 'wrong, very wrong');
		await f.click('button:has-text("Restore and restart")');
		await waitText(/does not open this backup/);
		await f.fill('#autobackup-restore-pass', PASS);
		await f.click('button:has-text("Restore and restart")');
		await waitText(/router is restarting/);
		await sleep(5000);
		eq([ domain(), reboots() ], [ 'encrypted', '2' ], 'encrypted restore: the typed passphrase restores it');
		await reopen();

		/* Delete. */
		await f.click('.abgl-nav button[data-page=backups]');
		await f.waitForSelector('table.autobackup-list');
		await f.click('table.autobackup-list tr.tr:nth-child(4) button:has-text("Delete")');
		await f.click('.abgl-modal button.cbi-button-negative');
		await f.waitForFunction(function() { return document.querySelectorAll('table.autobackup-list tr.tr:not(.table-titles)').length === 2; }, null, { timeout: 15000 });
		ok(!fs.existsSync(path.join(r.drive, 'autobackup', 'Other_Router', 'evil.json')), 'delete: removed from the drive');

		/* Dark theme. */
		await reopen('?theme=dark');
		eq(await f.evaluate(function() { return document.documentElement.getAttribute('data-theme'); }), 'dark', 'theme: follows the panel\'s dark colours');
		await shot('dark');

		/* What went over the panel's RPC. */
		var log = await page.evaluate(function() { return window.$requestLog; }).catch(function() { return []; });
		var spawned = router('cat /tmp/gl-rpc-spawn.log');
		ok(spawned.indexOf(PASS) < 0 && spawned.indexOf('wrong, very wrong') < 0 && /--passphrase-file \/var\/run\/autobackup\/input\./.test(spawned),
			'module: a passphrase never is an argument (it travels in a root-only file)');
		ok(/autobackup restore-check GL-BE9300\//.test(spawned) && /autobackup set schedule=daily/.test(spawned), 'module: runs the backend with the expected commands');
		eq(router('ls -A /var/run/autobackup/ 2>/dev/null | grep -c input; true').trim(), '0', 'module: no passphrase file is left behind');
		ok(log.length > 0 && log.every(function(x) { return x.method === 'call' && x.params[0] === 'sid' && x.params[1] === 'autobackup'; }),
			'panel: every call goes to the "autobackup" object');
		ok(await f.evaluate(function() { return window.__xss === undefined && window.parent.__xss === undefined; }), 'no markup from the drive was run');
		eq(r.problems, [], 'no script errors');
	} finally {
		await r.stop();
	}
	if (rig.failed()) {
		console.log('\n' + rig.failed() + ' check(s) failed');
		process.exit(1);
	}
	console.log('\nall checks passed');
}

main().catch(function(e) { console.error(e); process.exit(1); });

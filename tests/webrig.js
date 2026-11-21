/*
 * What the browser tests share (tests/luci.test.js, tests/gl.test.js):
 * OpenWrt 23.05 with LuCI in a container, the package's files, a folder of
 * this machine as the USB drive (at /mnt/sda1: procd mounts a fresh /tmp
 * at boot, which would hide a drive at /tmp/mountd), and Chrome.
 *
 * Needs docker, Google Chrome and playwright-core:
 *   npm install --no-save playwright-core
 * AB_CHROME=/path/to/chrome picks another Chromium-based browser;
 * AB_KEEP=1 leaves the container running (http://127.0.0.1:18580, root /
 * luci-test) to look at the pages by hand.
 */
var fs = require('fs'), path = require('path'), cp = require('child_process'), http = require('http'), crypto = require('crypto');

var ROOT = path.join(__dirname, '..');
var IMAGE = 'autobackup-test-luci', NAME = 'autobackup-test-luci';
var WEB_PORT = 18580;

exports.ROOT = ROOT;
exports.WEB = 'http://127.0.0.1:' + WEB_PORT;
exports.ROOT_PW = 'luci-test';
exports.DRIVE = '/mnt/sda1';
/* Characters that break naive quoting in shell, JSON, UCI and HTML. */
exports.PASSPHRASE = 'Pa ss,w"o\'r$d\\`1<b>%s';
/* Markup where text belongs: a page that runs it sets window.__xss. */
exports.HOSTILE = '<img src=x onerror="window.__xss=1">';

var playwright;
try { playwright = require(process.env.PLAYWRIGHT_CORE || 'playwright-core'); }
catch (e) {
	console.error('playwright-core is not installed. Run: npm install --no-save playwright-core');
	process.exit(2);
}

var fail = 0;
exports.ok = function(cond, name) { if (!cond) fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name); return cond; };
exports.eq = function(got, want, name) {
	var g = JSON.stringify(got), w = JSON.stringify(want);
	return exports.ok(g === w, name + (g === w ? '' : ' (got ' + g + ', expected ' + w + ')'));
};
exports.failed = function() { return fail; };
exports.sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
exports.sha256 = function(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); };

function docker(args, input) {
	return cp.execFileSync('docker', args, { input: input, encoding: 'utf8', stdio: [ 'pipe', 'pipe', 'pipe' ] });
}
/* Run a shell script on the test router. */
exports.router = function(script) { return docker([ 'exec', '-i', NAME, 'sh', '-s' ], script); };
/* A file on the test router, as bytes; and writing one. */
exports.routerRead = function(file) { return cp.execFileSync('docker', [ 'exec', NAME, 'cat', file ], { stdio: [ 'ignore', 'pipe', 'pipe' ] }); };
exports.routerWrite = function(file, buf) { cp.execFileSync('docker', [ 'exec', '-i', NAME, 'sh', '-c', 'cat > "$0"', file ], { input: buf }); };
/* A value for a shell script, in single quotes. */
exports.q = function(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; };
function get(url) {
	return new Promise(function(resolve, reject) {
		http.get(url, function(res) { res.resume(); resolve(res.statusCode); }).on('error', reject);
	});
}

/* start({ setup: [ extra shell lines ] }) -> { out (shared with the router
 * as /out), drive (this machine's folder that is the USB drive), browser,
 * page, problems (script errors once watch() was called), watch(), stop() } */
exports.start = async function(opts) {
	opts = opts || {};
	fs.mkdirSync(path.join(ROOT, '.test-out'), { recursive: true });
	var rig = { out: fs.mkdtempSync(path.join(ROOT, '.test-out', 'web-run-')), problems: [] };
	rig.drive = path.join(rig.out, 'drive');
	fs.mkdirSync(rig.drive);
	rig.stop = async function() {
		if (rig.browser) await rig.browser.close();
		/* What the router wrote to the shared folder is root's there (on
		 * Linux): let it remove that itself. */
		try { exports.router('rm -rf /out/* /mnt/sda1/* 2>/dev/null; true'); } catch (e) { /* not running */ }
		if (process.env.AB_KEEP) console.log('container left running: ' + exports.WEB + ' (LuCI: root / ' + exports.ROOT_PW + '); remove with: docker rm -f ' + NAME);
		else { try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* gone */ } }
		try { fs.rmSync(rig.out, { recursive: true, force: true }); } catch (e) { console.log('left behind: ' + rig.out + ' (' + e.code + ')'); }
	};
	try {
		docker([ 'build', '-q', '--platform', 'linux/amd64', '-t', IMAGE, path.join(ROOT, 'tests', 'openwrt-luci') ]);
		try { docker([ 'rm', '-f', NAME ]); } catch (e) { /* not running */ }
		/* SYS_ADMIN (not --privileged, with which netifd takes over the
		 * container's network): a restore must replace /etc/hosts and
		 * friends, which Docker mounts; they are unmounted below. */
		docker([ 'run', '-d', '--cap-add', 'SYS_ADMIN', '--security-opt', 'apparmor=unconfined', '--security-opt', 'seccomp=unconfined', '--platform', 'linux/amd64', '--name', NAME, '--hostname', 'OpenWrt', '-p', '127.0.0.1:' + WEB_PORT + ':80',
			'-v', path.join(ROOT, 'luci-app-autobackup') + ':/pkg:ro', '-v', path.join(ROOT, 'tests') + ':/tests:ro',
			'-v', rig.out + ':/out', '-v', rig.drive + ':' + exports.DRIVE, IMAGE, '/sbin/init' ]);

		for (var i = 0; i < 100; i++) {
			try { if (await get(exports.WEB + '/cgi-bin/luci/')) break; } catch (e) { /* not up yet */ }
			await exports.sleep(300);
		}
		exports.router([
			'set -e',
			'cp -R /pkg/root/. /',
			'cp -R /pkg/htdocs/. /www/',
			'chmod 755 /usr/bin/autobackup /usr/libexec/rpcd/luci.autobackup /etc/init.d/autobackup /etc/uci-defaults/80_autobackup',
			'chmod 600 /etc/config/autobackup_auth',
			'umount /etc/hosts /etc/hostname /etc/resolv.conf 2>/dev/null || true',
			/* A restart is only noted (the container would stop). */
			'rm -f /sbin/reboot && printf "#!/bin/sh\\ndate +%s >> /out/rebooted.txt\\n" > /sbin/reboot && chmod 755 /sbin/reboot',
			'mkdir -p /tmp/sysinfo && echo "qcom,ipq5332-ap-mi01.6" > /tmp/sysinfo/board_name && echo "GL.iNet BE9300, Inc." > /tmp/sysinfo/model',
			'echo 4.10.1 > /etc/glversion',
			'printf "config system\\n\\toption hostname \'GL-BE9300\'\\n\\toption zonename UTC\\n" > /etc/config/system',
			'sh /etc/uci-defaults/80_autobackup',
			'printf "%s\\n%s\\n" ' + exports.ROOT_PW + ' ' + exports.ROOT_PW + ' | passwd root >/dev/null 2>&1'
		].concat(opts.setup || []).join('\n'));
		/* The new settings may have restarted the web server. */
		await exports.sleep(1500);
		for (i = 0; i < 100; i++) {
			try { if (await get(exports.WEB + '/cgi-bin/luci/') === 403) break; } catch (e) { /* not up yet */ }
			await exports.sleep(300);
		}

		rig.browser = await playwright.chromium.launch(process.env.AB_CHROME ? { executablePath: process.env.AB_CHROME } : { channel: 'chrome' });
		var ctx = await rig.browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true, timezoneId: opts.timezone, locale: opts.locale });
		rig.page = await ctx.newPage();
		/* Script errors count from here on (LuCI's login page answers 403). */
		rig.watch = function() {
			rig.page.on('pageerror', function(e) { rig.problems.push('page error: ' + e.message); });
			rig.page.on('console', function(m) { if (m.type() === 'error') rig.problems.push('console: ' + m.text()); });
		};
		return rig;
	} catch (e) {
		await rig.stop();
		throw e;
	}
};

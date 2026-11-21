/*
 * The README's pictures, made from demo data in the test container
 * (tests/webrig.js), never from a real router: Auto Backup in the stand-in
 * GL.iNet panel (tests/gl/panel.html, the real module and backend).
 * The router calls itself a GL-BE9300 on 4.10.1 here, so the pages show
 * no "not tested" notice.
 *
 * Run: node tests/screenshots.js   -> docs/status.png, backups.png,
 *      settings.png, restore.png, backups-dark.png
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var router = rig.router, sleep = rig.sleep;

var DOCS = path.join(rig.ROOT, 'docs');

async function main() {
	fs.mkdirSync(DOCS, { recursive: true });
	/* The browser in the router's time zone (the container's is UTC), so
	 * a backup at 03:30 reads 3:30. */
	var r = await rig.start({ timezone: 'UTC', locale: 'en-US', setup: [
		'mkdir -p /www/gl /www/cgi-bin',
		'cp /tests/gl/panel.html /www/gl/panel.html',
		'cp /tests/gl/rpc.lua /www/cgi-bin/gl-rpc && chmod 755 /www/cgi-bin/gl-rpc',
		/* GL's model file (/proc/gl-hw-info/model) cannot exist in a
		 * container; the board name stands in for it. */
		'echo be9300 > /tmp/sysinfo/board_name',
		'echo "GL.iNet GL-BE9300" > /tmp/sysinfo/model'
	] });
	try {
		var now = Math.floor(Date.now() / 1000), day = 86400;
		/* Six backups over a week: the older two plain, the rest encrypted. */
		router([
			'set -e',
			'H=/mnt/sda1/autobackup/GL-BE9300',
			'autobackup backup >/dev/null; autobackup backup >/dev/null',
			'f=$(autobackup passphrase-input); echo "correct horse battery" > "$f"; autobackup set-passphrase "$f" >/dev/null',
			'for i in 1 2 3 4; do autobackup backup >/dev/null; done',
			'autobackup set schedule=daily hour=3 minute=30 keep=10 >/dev/null',
			/* Spread them over the past week, one a day at 03:30. */
			'n=0; for r in $(ls -r $H/*.json); do',
			'  t=$(( ' + now + ' - n * ' + day + ' - (' + now + ' % ' + day + ') + 3 * 3600 + 30 * 60 ))',
			'  [ $n = 0 ] && t=$(( ' + now + ' - 2 * 3600 ))',
			'  sed -i "s/\\"time\\":[0-9]*/\\"time\\":$t/" $r; n=$((n + 1))',
			'done',
			/* The oldest was made on older firmware, with ISPy installed. */
			'old=$(ls $H/*.json | head -n 1)',
			'sed -i -e "s/\\"firmware\\":\\"4.10.1\\"/\\"firmware\\":\\"4.9.0\\"/" -e "s/\\"packages\\":\\[\\]/\\"packages\\":[\\"luci-app-ispy\\"]/" $old'
		].join('\n'));

		var page = r.page;
		await page.setViewportSize({ width: 1240, height: 900 });
		var open = async function(theme, tab) {
			await page.goto(rig.WEB + '/gl/panel.html' + (theme ? '?theme=' + theme : ''));
			var fh = await page.waitForSelector('iframe');
			var f = await fh.contentFrame();
			await f.waitForSelector('.autobackup-page h2');
			if (tab) {
				await f.click('.abgl-nav button[data-page=' + tab + ']');
				await f.waitForSelector(tab === 'backups' ? 'table.autobackup-list' : '#autobackup-schedule', { timeout: 15000 }).catch(async function(e) {
					console.log(await f.innerText('body'));
					console.log(router('ls -la /mnt/sda1/autobackup/*/ 2>&1; autobackup list | head -c 600'));
					throw e;
				});
			}
			await sleep(400);
			return { fh: fh, f: f };
		};
		var shot = async function(fh, name) {
			await fh.screenshot({ path: path.join(DOCS, name + '.png') });
			console.log('docs/' + name + '.png');
		};

		var p = await open('', null);
		await shot(p.fh, 'status');
		p = await open('', 'backups');
		await shot(p.fh, 'backups');
		await p.f.click('table.autobackup-list tr.tr:last-child button:has-text("Restore")');
		await p.f.waitForSelector('#autobackup-ok-other_firmware');
		await p.f.check('#autobackup-ok-other_firmware');
		await sleep(400);
		await shot(p.fh, 'restore');
		p = await open('', 'settings');
		await shot(p.fh, 'settings');
		p = await open('dark', 'backups');
		await shot(p.fh, 'backups-dark');
	} finally {
		await r.stop();
	}
}

main().catch(function(e) { console.error(e); process.exit(1); });

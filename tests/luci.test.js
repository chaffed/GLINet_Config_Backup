/*
 * The pages in a real LuCI, driven by a real browser.
 *
 * Starts OpenWrt 23.05 with LuCI in a container (tests/webrig.js), installs
 * the package's files, logs in as root and uses Status, Settings and
 * Backups the way their owner would: back up, schedule, encrypt, download,
 * restore (the router's restart is only noted), upload and restore, delete.
 * Screenshots are left in .test-out/luci/.
 *
 * Run: node tests/luci.test.js (what it needs: see tests/webrig.js).
 */
var fs = require('fs'), path = require('path');
var rig = require('./webrig.js');
var ok = rig.ok, eq = rig.eq, sleep = rig.sleep, router = rig.router;

var LUCI = rig.WEB, PASS = rig.PASSPHRASE, HOSTILE = rig.HOSTILE;
var SHOTS = path.join(rig.ROOT, '.test-out', 'luci');
var BASE = LUCI + '/cgi-bin/luci/admin/system/autobackup/';

async function main() {
	fs.mkdirSync(SHOTS, { recursive: true });
	var r = await rig.start();
	try {
		var page = r.page;
		var shot = function(name) { return page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true }); };
		var open = async function(p) {
			await page.goto(BASE + p);
			await page.waitForSelector('.autobackup-page h2');
		};
		var domain = function() { return router('uci -q get dhcp.@dnsmasq[0].domain; true').trim(); };
		var setDomain = function(v) { router('uci set dhcp.@dnsmasq[0].domain=' + v + '; uci commit dhcp'); };
		var reboots = function() { return router('cat /out/rebooted.txt 2>/dev/null | wc -l').trim(); };
		var modal = '#modal_overlay .modal';
		var modalText = function() { return page.innerText(modal); };
		var waitModal = async function(re) {
			await page.waitForFunction(function(src) {
				var m = document.querySelector('#modal_overlay .modal');
				return m && document.body.classList.contains('modal-overlay-active') && new RegExp(src).test(m.innerText);
			}, re.source, { timeout: 30000 });
		};
		var closeModal = function() { return page.evaluate(function() { L.ui.hideModal(); }); };

		/* ------------------------------------------------------------- log in */
		await page.goto(BASE + 'status');
		await page.fill('input[name=luci_username]', 'root');
		await page.fill('input[name=luci_password]', rig.ROOT_PW);
		await Promise.all([ page.waitForNavigation(), page.press('input[name=luci_password]', 'Enter') ]);
		r.watch();
		await page.waitForSelector('.autobackup-page h2');

		/* ------------------------------------------------------------- Status */
		var text = await page.innerText('#view');
		ok(/Auto Backup/.test(text) && /No backup yet/.test(text), 'status: opens under System, no backup yet');
		ok(text.indexOf(rig.DRIVE) >= 0 && /free\)/.test(text), 'status: names the USB drive and its free space');
		ok(/Not tested on this router yet/.test(text), 'status: warns that this router (not a GL-BE9300 by GL\'s model file) is untested');
		ok(/Off: backups are made only when you press Back up now/.test(text), 'status: no schedule at first');
		await shot('status-empty');

		setDomain('before');
		await page.click('button:has-text("Back up now")');
		await page.waitForSelector('.alert-message.success, .alert-message.error', { timeout: 30000 });
		ok(/Backup saved/.test(await page.innerText('body')), 'back up now: a notification says it was saved');
		await page.waitForFunction(function() { return /Succeeded/.test(document.querySelector('#view').innerText); });
		ok(/Succeeded/.test(await page.innerText('#view')), 'back up now: Status shows the last backup succeeded');
		eq(router('ls /mnt/sda1/autobackup/GL-BE9300/ | wc -l').trim(), '2', 'back up now: an archive and its record on the drive');
		await shot('status');

		/* ----------------------------------------------------------- Settings */
		await open('settings');
		await page.selectOption('#autobackup-schedule', 'weekly');
		ok(await page.isVisible('#autobackup-weekday'), 'settings: the day appears for a weekly schedule');
		await page.selectOption('#autobackup-weekday', '2');
		await page.selectOption('#autobackup-hour', '4');
		await page.selectOption('#autobackup-minute', '15');
		await page.fill('#autobackup-keep', '0');
		await page.click('button:has-text("Save")');
		ok(/whole number from 1 to 100/.test(await page.innerText('[data-field=keep]')), 'settings: keep 0 is refused on the page');
		await page.fill('#autobackup-keep', '5');
		await page.click('button:has-text("Save")');
		await page.waitForFunction(function() { var s = document.querySelector('.autobackup-saved'); return !document.querySelector('button.spinning') && document.querySelector('#autobackup-schedule'); });
		await sleep(800);
		eq(router('uci get autobackup.main.schedule; uci get autobackup.main.weekday; uci get autobackup.main.hour; uci get autobackup.main.minute; uci get autobackup.main.keep').trim().split('\n'),
			[ 'weekly', '2', '4', '15', '5' ], 'settings: the schedule and keep count are stored');
		ok(/^15 4 \* \* 2 \/usr\/bin\/autobackup backup --scheduled/m.test(router('cat /etc/crontabs/root')), 'settings: cron runs it on Tuesdays at 04:15');
		await open('status');
		ok(/Every Tuesday at 04:15/.test(await page.innerText('#view')), 'status: shows the schedule with its day and time');
		await open('settings');

		await page.check('#autobackup-encrypt');
		ok(await page.isVisible('#autobackup-pass'), 'settings: ticking encryption asks for a passphrase');
		await page.click('button:has-text("Save")');
		ok(/Enter a passphrase/.test(await page.innerText('[data-field=pass]')), 'settings: encryption without a passphrase is refused');
		await page.fill('#autobackup-pass', PASS);
		await page.fill('#autobackup-pass2', PASS + 'x');
		await page.click('button:has-text("Save")');
		ok(/not the same/.test(await page.innerText('[data-field=pass]')), 'settings: two different passphrases are refused');
		await page.fill('#autobackup-pass2', PASS);
		await page.click('button:has-text("Save")');
		await page.waitForFunction(function() { return /A passphrase is set/.test(document.querySelector('#view').innerText); }, null, { timeout: 15000 });
		eq(router('uci get autobackup.main.encrypt; uci get autobackup_auth.main.passphrase; ls -l /etc/config/autobackup_auth | cut -c1-10').trim().split('\n'),
			[ '1', PASS, '-rw-------' ], 'settings: encryption on, passphrase stored exactly, root only');
		eq(await page.inputValue('#autobackup-pass'), '', 'settings: the passphrase is never shown again');
		await shot('settings');

		/* An encrypted backup, and a backup of another router on the drive
		 * whose record is full of markup. */
		setDomain('encrypted');
		await open('status');
		ok(/On \(passphrase set\)/.test(await page.innerText('#view')), 'status: encryption on');
		await page.click('button:has-text("Back up now")');
		await page.waitForSelector('.alert-message.success', { timeout: 30000 });
		router([
			'd=/mnt/sda1/autobackup/Other_Router; mkdir -p $d',
			'printf x > $d/evil.tar.gz',
			'cat > $d/evil.json <<\'J\'',
			JSON.stringify({ format: 1, file: 'evil.tar.gz', time: 1700000000, hostname: HOSTILE, model: HOSTILE, board: 'x', firmware: HOSTILE, size: 1, sha256: rig.sha256('x'), encrypted: false, packages: [ HOSTILE ] }),
			'J'
		].join('\n'));
		setDomain('later');

		/* ------------------------------------------------------------ Backups */
		await open('backups');
		var rows = await page.$$eval('table.autobackup-list tr.tr:not(.table-titles)', function(t) { return t.map(function(x) { return x.innerText; }); });
		eq(rows.length, 3, 'backups: three rows (two of this router, one of another)');
		ok(/Encrypted/.test(rows[0]) && /No/.test(rows[1]), 'backups: newest first; the encrypted one says so');
		ok(rows[2].indexOf(HOSTILE) >= 0 && /another router/.test(rows[2]), 'backups: another router\'s record is shown as text, marked as another router');
		await shot('backups');

		/* Download the plain backup. */
		var dl = await Promise.all([ page.waitForEvent('download'), page.click('table.autobackup-list tr.tr:nth-child(3) button:has-text("Download")') ]);
		var file = await dl[0].path(), bytes = fs.readFileSync(file);
		var plainName = dl[0].suggestedFilename();
		var plainSum = router('cat /mnt/sda1/autobackup/GL-BE9300/' + plainName.replace(/\.tar\.gz$/, '.json')).match(/"sha256":"([0-9a-f]+)"/);
		ok(plainSum && rig.sha256(bytes) === plainSum[1] && /\.tar\.gz$/.test(plainName), 'download: the archive, byte for byte (sha256 as recorded)');
		fs.copyFileSync(file, path.join(r.out, 'plain.tar.gz'));

		/* Another model's backup cannot be restored. */
		await page.click('table.autobackup-list tr.tr:nth-child(4) button:has-text("Restore")');
		await waitModal(/cannot be restored/);
		ok(/different router model/.test(await modalText()) && !(await page.isVisible('button:has-text("Restore and restart")')),
			'restore: another router\'s backup is refused, with no way to go on');
		await closeModal();

		/* Restore the plain backup. */
		await page.click('table.autobackup-list tr.tr:nth-child(3) button:has-text("Restore")');
		await waitModal(/Restore this backup\?/);
		ok(/replaces this router's settings/.test(await modalText()), 'restore: the dialog says what restoring does');
		await shot('restore-dialog');
		await page.click('button:has-text("Restore and restart")');
		await waitModal(/router is restarting/);
		await sleep(5000);
		eq([ domain(), reboots() ], [ 'before', '1' ], 'restore: the backup\'s settings are back and the router restarts');
		await shot('restoring');

		/* The encrypted backup, after the passphrase was changed. (The restore
		 * brought back that backup's settings: encryption off.) */
		await open('settings');
		eq(await page.isChecked('#autobackup-encrypt'), false, 'restore: brought back the backup\'s own settings (encryption was off then)');
		await page.check('#autobackup-encrypt');
		await page.fill('#autobackup-pass', 'a brand new passphrase');
		await page.fill('#autobackup-pass2', 'a brand new passphrase');
		await page.click('button:has-text("Save")');
		await page.waitForFunction(function() { return !document.querySelector('button.spinning') && /Saved/.test(document.querySelector('.autobackup-saved').innerText); }, null, { timeout: 15000 }).catch(function() {});
		eq(router('uci get autobackup_auth.main.passphrase').trim(), 'a brand new passphrase', 'settings: a new passphrase replaces the old');
		setDomain('later');
		await open('backups');
		await page.click('table.autobackup-list tr.tr:nth-child(2) button:has-text("Restore")');
		await waitModal(/Passphrase of this backup/);
		ok(await page.isDisabled('button:has-text("Restore and restart")'), 'encrypted restore: needs the old passphrase before it can go on');
		await page.fill('#autobackup-restore-pass', 'not it at all');
		await page.click('button:has-text("Restore and restart")');
		await page.waitForFunction(function() { return /does not open this backup/.test(document.querySelector('#modal_overlay .modal').innerText); }, null, { timeout: 15000 });
		eq([ domain(), reboots() ], [ 'later', '1' ], 'encrypted restore: a wrong passphrase is reported and changes nothing');
		await page.fill('#autobackup-restore-pass', PASS);
		await page.click('button:has-text("Restore and restart")');
		await waitModal(/router is restarting/);
		await sleep(5000);
		eq([ domain(), reboots() ], [ 'encrypted', '2' ], 'encrypted restore: the old passphrase restores it');
		eq(router('ls -A /var/run/autobackup/ /tmp/autobackup/ 2>/dev/null | grep -c input; true').trim(), '0', 'encrypted restore: no passphrase file is left behind');

		/* Encryption off forgets the passphrase. */
		await open('settings');
		await page.uncheck('#autobackup-encrypt');
		ok(/forgets the passphrase/.test(await page.innerText('#view')), 'settings: turning encryption off warns that the passphrase is forgotten');
		await page.click('button:has-text("Save")');
		await page.waitForFunction(function() { return document.querySelector('#autobackup-encrypt') && !document.querySelector('button.spinning'); });
		await sleep(800);
		eq(router('uci get autobackup.main.encrypt; uci -q get autobackup_auth.main.passphrase; true').trim(), '0', 'settings: encryption off, passphrase gone');

		/* Upload a backup from this computer and restore it. */
		setDomain('later');
		await open('backups');
		await page.setInputFiles('.autobackup-page input[type=file]', path.join(r.out, 'plain.tar.gz'));
		await waitModal(/Restore this backup\?/);
		var mt = await modalText();
		ok(/no record of the router it came from/.test(mt) && /plain\.tar\.gz/.test(mt), 'upload: the dialog warns that the model cannot be checked');
		ok(await page.isDisabled('button:has-text("Restore and restart")'), 'upload: Restore stays off until the warning is ticked');
		await page.check('#autobackup-ok-unverified');
		await page.click('button:has-text("Restore and restart")');
		await waitModal(/router is restarting/);
		await sleep(5000);
		eq([ domain(), reboots() ], [ 'before', '3' ], 'upload: restored from the uploaded file');

		/* Delete. */
		await open('backups');
		await page.click('table.autobackup-list tr.tr:nth-child(4) button:has-text("Delete")');
		await waitModal(/Delete this backup\?/);
		await page.click(modal + ' button.cbi-button-negative');
		await page.waitForFunction(function() { return document.querySelectorAll('table.autobackup-list tr.tr:not(.table-titles)').length === 2; }, null, { timeout: 15000 });
		ok(!fs.existsSync(path.join(r.drive, 'autobackup', 'Other_Router', 'evil.json')), 'delete: the backup is removed from the drive');

		/* No drive. */
		router('uci set autobackup.main.drive=/mnt/sdb1; uci commit autobackup');
		await open('status');
		ok(/chosen USB drive is not plugged in/.test(await page.innerText('#view')) && await page.isDisabled('button:has-text("Back up now")'),
			'status: a chosen drive that is not plugged in is reported; Back up now is off');
		router('uci set autobackup.main.drive=""; uci commit autobackup');

		ok(await page.evaluate(function() { return window.__xss === undefined; }), 'no markup from the drive was run');
		eq(r.problems, [], 'no script errors on any page');
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

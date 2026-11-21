'use strict';
'require baseclass';

/*
 * Auto Backup's pages (Status, Backups, Settings), shared by LuCI
 * (view/autobackup/*.js) and the GL.iNet admin panel (autobackup/gl.js).
 *
 * mount(env, page) returns a node that loads its own data and draws the
 * page; env holds what differs between the two:
 *   env.api  status(), list(), backup(), remove(id), check(src),
 *            restore(src, { passphrase, force_firmware, force_unverified }),
 *            config(), set(values), setPassphrase(p), download(path, name),
 *            upload(file)                        (all return promises)
 *   env.ui   showModal(title, children), hideModal(),
 *            addNotification(title, children, type)
 *   env.go(page)  open another page (links between the pages)
 *
 * The backend answers in JSON with a reason code on failure; reasonText()
 * turns a code into a sentence. Anything that comes from the drive (file
 * names, records) or the router is passed to E() as an array child, which
 * both LuCI's E() and the panel's stand-in add as text, never as markup.
 *
 * The passphrase is write-only: the pages send a typed passphrase and are
 * never given one back (config says only whether one is set).
 * SPDX-License-Identifier: MIT
 */

var DAYS = [ _('Sunday'), _('Monday'), _('Tuesday'), _('Wednesday'), _('Thursday'), _('Friday'), _('Saturday') ];

function reasonText(code, ctx) {
	ctx = ctx || {};
	switch (code) {
	case 'no_drive': return _('No USB drive is plugged in.');
	case 'drive_missing': return _('The chosen USB drive is not plugged in.');
	case 'backup_failed': return _('The router could not make the backup.');
	case 'encrypt_failed': return _('The backup could not be encrypted.');
	case 'no_passphrase': return _('Encryption is on, but no passphrase is set. Set one in Settings.');
	case 'write_failed': return _('The backup could not be written to the USB drive. Is it full or read-only?');
	case 'busy': return _('Another backup or restore is running. Try again in a moment.');
	case 'not_found': return _('That backup is no longer on the drive.');
	case 'archive_missing': return _('The backup file is missing from the drive; only its description is left.');
	case 'checksum_mismatch': return _('The backup file is damaged: it no longer matches the checksum recorded when it was made.');
	case 'other_model': return _('This backup was made on a different router model. Restoring it could leave this router unusable, so it cannot be restored here.');
	case 'not_a_backup': return _('This file is not a router configuration backup.');
	case 'needs_passphrase': return _('This backup is encrypted with a different passphrase. Enter the passphrase that was set when it was made.');
	case 'wrong_passphrase': return _('That passphrase does not open this backup.');
	case 'restore_failed': return _('The router could not restore the settings. Some may have been changed; check them, or restore again.');
	case 'other_firmware': return _('This backup was made on other firmware.');
	case 'unverified': return _('This file has no record of the router it came from.');
	case 'not_confirmed': return _('The restore was not confirmed.');
	case 'invalid_passphrase': return _('The passphrase must be 8 to 256 characters on one line.');
	case 'invalid_value': return _('This value is not allowed.');
	case 'unknown_setting': return _('Unknown setting.');
	case 'no_input': return _('The router could not take the passphrase. Try again.');
	default: return code ? _('The router answered: %s').format(code) : _('The router did not answer.');
	}
}

function two(n) { return (n < 10 ? '0' : '') + n; }

function when(t) {
	if (!t)
		return _('never');
	var ago = Math.round((Date.now() / 1000 - t) / 60), rel;
	if (ago < 0)
		rel = null;
	else if (ago < 2)
		rel = _('just now');
	else if (ago < 120)
		rel = _('%d minutes ago').format(ago);
	else if (ago < 48 * 60)
		rel = _('%d hours ago').format(Math.round(ago / 60));
	else
		rel = _('%d days ago').format(Math.round(ago / 1440));
	return stamp(t) + (rel ? ' (' + rel + ')' : '');
}

/* A date and time, short ("Nov 21, 2026, 3:30 AM" in English). */
function stamp(t) {
	var d = new Date(t * 1000);
	try {
		return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	} catch (e) {
		return d.toLocaleString();
	}
}

function size(bytes) {
	if (bytes == null)
		return '?';
	if (bytes < 1024 * 1024)
		return _('%d KB').format(Math.max(1, Math.round(bytes / 1024)));
	return _('%s MB').format((bytes / 1048576).toFixed(1));
}

function scheduleText(s) {
	var t = two(+s.hour || 0) + ':' + two(+s.minute || 0);
	if (s.schedule === 'daily')
		return _('Every day at %s').format(t);
	if (s.schedule === 'weekly')
		return _('Every %s at %s').format(DAYS[+s.weekday || 0], t);
	return _('Off: backups are made only when you press Back up now');
}

function notice(type, children) {
	return E('div', { 'class': 'alert-message ' + type, 'role': type === 'error' ? 'alert' : 'status' }, children);
}

function untested(st) {
	if (!st || st.tested)
		return '';
	var r = st.router || {};
	return notice('warning', [
		E('strong', {}, [ _('Not tested on this router yet.') ]), ' ',
		_('Auto Backup has only been tested on a GL.iNet GL-BE9300 with firmware 4.10.1. This router is %s with firmware %s. Make a backup and try restoring it before you rely on it, and please report how it went.')
			.format(r.model_name || r.model || r.board || _('another model'), r.firmware || '?')
	]);
}

function busyButton(btn, on) {
	btn.disabled = !!on;
	if (on)
		btn.classList.add('spinning');
	else
		btn.classList.remove('spinning');
}

function row(label, value) {
	return E('tr', { 'class': 'tr' }, [
		E('td', { 'class': 'td left', 'style': 'width:33%' }, [ E('strong', {}, [ label ]) ]),
		E('td', { 'class': 'td left' }, Array.isArray(value) ? value : [ value ])
	]);
}

function errorOf(e) {
	return (e && (e.message || e.reason)) || String(e);
}

/* Call the backend; a reply with ok:false becomes a rejection carrying the
 * reply (its reason and field). */
function must(p) {
	return Promise.resolve(p).then(function(r) {
		if (r && r.ok === false) {
			var err = new Error(reasonText(r.reason));
			err.reason = r.reason;
			err.field = r.field;
			throw err;
		}
		return r;
	});
}

/* Layout only; colours come from the theme (LuCI's, or the panel's via
 * gl.js). Added once per document. */
var CSS = [
	'.autobackup-row{display:grid;grid-template-columns:minmax(140px,220px) minmax(0,1fr);gap:4px 20px;padding:8px 0}',
	'.autobackup-row>label{font-weight:600;padding-top:6px}',
	'.autobackup-help{opacity:.8;font-size:.92em;margin:4px 0 0;max-width:60em}',
	'.autobackup-field-error{color:var(--error,#c62828);font-weight:600;margin:4px 0 0}',
	'.autobackup-field-error:empty{display:none}',
	'.autobackup-sub{margin:0 8px}',
	'.autobackup-good{color:var(--success,#2e7d32);font-weight:600}',
	'.autobackup-bad{color:var(--error,#c62828);font-weight:600}',
	'.autobackup-actions{margin:16px 0 0;display:flex;flex-wrap:wrap;gap:8px;align-items:center}',
	'.autobackup-row-actions,.autobackup-nowrap{white-space:nowrap}',
	'.autobackup-row-actions .cbi-button{margin:2px}',
	'.autobackup-field{margin:10px 0}',
	'.autobackup-field label{display:block;font-weight:600;margin:0 0 4px}',
	'.autobackup-page .alert-message label{display:inline-flex;gap:6px;align-items:center;font-weight:600}',
	'.autobackup-page .alert-message ul{margin:.3em 0 .3em 1.4em;padding:0}',
	'@media (max-width:720px){.autobackup-row{grid-template-columns:1fr}.autobackup-row>label{padding-top:0}.autobackup-row-actions{white-space:normal}}'
].join('\n');

function addStyle() {
	if (document.getElementById('autobackup-css'))
		return;
	var st = document.createElement('style');
	st.id = 'autobackup-css';
	st.textContent = CSS;
	document.head.appendChild(st);
}

return baseclass.extend({
	reasonText: reasonText,
	scheduleText: scheduleText,
	when: when,
	size: size,

	/* A node that loads and draws `page` ('status', 'backups', 'settings'). */
	mount: function(env, page) {
		var self = this, root = E('div', { 'class': 'autobackup-page' }, [ E('p', { 'class': 'spinning' }, [ _('Loading…') ]) ]);
		addStyle();
		var draw = function() {
			var load = page === 'backups' ? Promise.all([ env.api.status(), env.api.list() ])
				: page === 'settings' ? Promise.all([ env.api.status(), env.api.config() ])
				: Promise.all([ env.api.status() ]);
			return load.then(function(d) {
				var node = page === 'backups' ? self.backups(env, d[0], d[1], draw)
					: page === 'settings' ? self.settings(env, d[0], d[1], draw)
					: self.status(env, d[0], draw);
				while (root.firstChild)
					root.removeChild(root.firstChild);
				root.appendChild(node);
			}).catch(function(e) {
				while (root.firstChild)
					root.removeChild(root.firstChild);
				root.appendChild(notice('error', [ _('Auto Backup could not load this page: %s').format(errorOf(e)) ]));
			});
		};
		draw();
		return root;
	},

	/* ------------------------------------------------------------ Status -- */

	status: function(env, st, redraw) {
		var last = st.last, drive, lastText, btn;

		if (st.drive)
			drive = [ E('code', {}, [ st.drive ]), ' ', st.free_kb != null ? _('(%s free)').format(size(st.free_kb * 1024)) : '' ];
		else
			drive = [ E('span', { 'class': 'autobackup-bad' }, [ reasonText(st.drive_reason) ]) ];

		if (!last)
			lastText = [ _('No backup yet.') ];
		else if (last.result === 'ok')
			lastText = [ E('span', { 'class': 'autobackup-good' }, [ _('Succeeded') ]), ' · ', when(last.time) ];
		else
			lastText = [ E('span', { 'class': 'autobackup-bad' }, [ _('Failed') ]), ' · ', when(last.time), E('br'), reasonText(last.reason) ];

		btn = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'click': function() {
			busyButton(btn, true);
			must(env.api.backup()).then(function(r) {
				env.ui.addNotification(null, [ E('p', {}, [ _('Backup saved: %s').format(r.id || '') ]) ], 'success');
			}).catch(function(e) {
				env.ui.addNotification(null, [ E('p', {}, [ _('The backup failed: %s').format(errorOf(e)) ]) ], 'error');
			}).then(function() {
				busyButton(btn, false);
				return redraw();
			});
		} }, [ _('Back up now') ]);
		if (st.busy || !st.drive)
			btn.disabled = true;

		return E('div', {}, [
			E('h2', {}, [ _('Auto Backup') ]),
			E('p', { 'class': 'cbi-map-descr' }, [ _('Saves this router\'s settings to a USB drive on a schedule. A backup holds the settings, not the add-ons installed on top of the firmware: those are listed with each backup so they can be installed again before a restore.') ]),
			untested(st),
			(last && last.result === 'failed') ? notice('error', [ E('strong', {}, [ _('The last backup failed.') ]), ' ', reasonText(last.reason) ]) : '',
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table autobackup-status' }, [
					row(_('USB drive'), drive),
					row(_('Last backup'), lastText),
					row(_('Last successful backup'), st.last_ok ? when(st.last_ok) : _('never')),
					row(_('Schedule'), [ scheduleText(st) ].concat(st.next_run ? [ E('br'), _('Next: %s').format(stamp(st.next_run)) ] : [])),
					row(_('Keep'), _('The newest %d backups of this router').format(st.keep)),
					row(_('Encryption'), st.encrypt ? _('On (passphrase set)') : _('Off')),
					row(_('This router'), [ (st.router.model_name || st.router.model || '?') + ' · ' + _('firmware %s').format(st.router.firmware || '?') ])
				])
			]),
			E('div', { 'class': 'autobackup-actions' }, [
				btn, ' ',
				E('a', { 'href': '#', 'class': 'cbi-button', 'click': function(ev) { ev.preventDefault(); env.go('backups'); } }, [ _('Backups') ]), ' ',
				E('a', { 'href': '#', 'class': 'cbi-button', 'click': function(ev) { ev.preventDefault(); env.go('settings'); } }, [ _('Settings') ])
			]),
			st.busy ? E('p', { 'class': 'spinning' }, [ _('A backup or restore is running…') ]) : ''
		]);
	},

	/* ----------------------------------------------------------- Backups -- */

	backups: function(env, st, list, redraw) {
		var self = this, rows, file;

		rows = (list.backups || []).map(function(b) {
			var path = list.drive + '/autobackup/' + b.id.split('/')[0] + '/' + b.file, mine = b.hostname === st.router.hostname;
			var actions = [
				E('button', { 'class': 'cbi-button', 'type': 'button', 'disabled': b.missing ? 'disabled' : null, 'click': function() {
					Promise.resolve(env.api.download(path, b.file)).catch(function(e) {
						env.ui.addNotification(null, [ E('p', {}, [ _('Download failed: %s').format(errorOf(e)) ]) ], 'error');
					});
				} }, [ _('Download') ]), ' ',
				E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'disabled': b.missing ? 'disabled' : null, 'click': function() {
					self.restoreFlow(env, b.id, b);
				} }, [ _('Restore…') ]), ' ',
				E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'click': function() {
					self.confirmDelete(env, b, redraw);
				} }, [ _('Delete…') ])
			];
			return E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td autobackup-nowrap' }, [ stamp(b.time) ].concat(b.missing ? [ E('br'), E('em', { 'class': 'autobackup-bad' }, [ _('File missing') ]) ] : [])),
				E('td', { 'class': 'td autobackup-nowrap' }, [ size(b.size) ]),
				E('td', { 'class': 'td' }, [ String(b.hostname || '?') ].concat(mine ? [] : [ E('br'), E('em', {}, [ _('another router') ]) ])),
				E('td', { 'class': 'td' }, [ String(b.model || '?') + ' · ' + String(b.firmware || '?') ]),
				E('td', { 'class': 'td' }, [ b.encrypted ? _('Encrypted') : _('No') ]),
				E('td', { 'class': 'td right autobackup-row-actions' }, actions)
			]);
		});

		file = E('input', { 'type': 'file', 'accept': '.gz,.tgz,.enc', 'style': 'display:none', 'change': function() {
			var f = file.files && file.files[0];
			file.value = '';
			if (!f)
				return;
			env.ui.showModal(_('Uploading…'), [ E('p', { 'class': 'spinning' }, [ _('Sending %s to the router…').format(f.name) ]) ]);
			Promise.resolve(env.api.upload(f)).then(function() {
				self.restoreFlow(env, 'upload', null, f.name);
			}).catch(function(e) {
				env.ui.hideModal();
				env.ui.addNotification(null, [ E('p', {}, [ _('Upload failed: %s').format(errorOf(e)) ]) ], 'error');
			});
		} });

		return E('div', {}, [
			E('h2', {}, [ _('Backups') ]),
			E('p', { 'class': 'cbi-map-descr' }, [ list.drive
				? _('Backups on the USB drive (%s), newest first. A backup can only be restored on the same router model.').format(list.drive)
				: reasonText(list.reason) ]),
			untested(st),
			E('div', { 'class': 'cbi-section' }, [
				rows.length ? E('table', { 'class': 'table autobackup-list' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, [ _('Made') ]),
						E('th', { 'class': 'th' }, [ _('Size') ]),
						E('th', { 'class': 'th' }, [ _('Router') ]),
						E('th', { 'class': 'th' }, [ _('Model · firmware') ]),
						E('th', { 'class': 'th' }, [ _('Encrypted') ]),
						E('th', { 'class': 'th right' }, [ _('Actions') ])
					])
				].concat(rows)) : E('p', { 'class': 'autobackup-empty' }, [ list.drive ? _('No backups on this drive yet.') : '' ])
			]),
			E('div', { 'class': 'autobackup-actions' }, [
				file,
				E('button', { 'class': 'cbi-button', 'type': 'button', 'click': function() { file.click(); } }, [ _('Upload a backup and restore it…') ])
			])
		]);
	},

	confirmDelete: function(env, b, redraw) {
		var btn = E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'click': function() {
			busyButton(btn, true);
			must(env.api.remove(b.id)).then(function() {
				env.ui.hideModal();
				return redraw();
			}).catch(function(e) {
				env.ui.hideModal();
				env.ui.addNotification(null, [ E('p', {}, [ _('Could not delete the backup: %s').format(errorOf(e)) ]) ], 'error');
			});
		} }, [ _('Delete') ]);
		env.ui.showModal(_('Delete this backup?'), [
			E('p', {}, [ _('The backup made %s will be removed from the USB drive. This cannot be undone.').format(stamp(b.time)) ]),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'cbi-button', 'type': 'button', 'click': function() { env.ui.hideModal(); } }, [ _('Cancel') ]), ' ',
				btn
			])
		]);
	},

	/* Look the backup over (restore-check), show what restoring means and
	 * ask for what it needs: a passphrase, and a tick for each warning. */
	restoreFlow: function(env, src, b, fileName) {
		var self = this;
		env.ui.showModal(_('Restore'), [ E('p', { 'class': 'spinning' }, [ _('Checking the backup…') ]) ]);
		return Promise.resolve(env.api.check(src)).then(function(c) {
			self.restoreDialog(env, src, c, fileName);
		}).catch(function(e) {
			env.ui.showModal(_('Restore'), [
				notice('error', [ _('Could not check the backup: %s').format(errorOf(e)) ]),
				E('div', { 'class': 'right' }, [ E('button', { 'class': 'cbi-button', 'type': 'button', 'click': function() { env.ui.hideModal(); } }, [ _('Close') ]) ])
			]);
		});
	},

	restoreDialog: function(env, src, c, fileName) {
		var rec = c.record, close, go, pass = null, ticks = [], body = [], err, router = c.router || {};

		close = E('button', { 'class': 'cbi-button', 'type': 'button', 'click': function() { env.ui.hideModal(); } }, [ _('Cancel') ]);

		if (rec)
			body.push(E('p', {}, [ _('Backup of %s made %s (%s, firmware %s).').format(String(rec.hostname || '?'), stamp(rec.time), String(rec.model || '?'), String(rec.firmware || '?')) ]));
		else
			body.push(E('p', {}, [ _('Uploaded file: %s').format(String(fileName || '')) ]));

		if (c.blocked) {
			body.push(notice('error', [ reasonText(c.blocked) ]));
			if (c.blocked === 'other_model' && rec)
				body.push(E('p', {}, [ _('The backup is from %s (%s); this router is %s (%s).').format(String(rec.model || '?'), String(rec.board || '?'), String(router.model || '?'), String(router.board || '?')) ]));
			env.ui.showModal(_('This backup cannot be restored'), body.concat([ E('div', { 'class': 'right' }, [ close ]) ]));
			return;
		}

		(c.warnings || []).forEach(function(w) {
			var box = E('input', { 'type': 'checkbox', 'id': 'autobackup-ok-' + w, 'change': function() { update(); } });
			ticks.push(box);
			var text = w === 'other_firmware'
				? _('It was made on firmware %s; this router runs %s. Settings usually carry over between nearby versions, but some may not fit.').format(String(rec && rec.firmware || '?'), String(router.firmware || '?'))
				: _('Its router model cannot be checked. Only restore a backup you know was made on this model (%s).').format(String(router.model || '?'));
			body.push(notice('warning', [
				E('p', {}, [ reasonText(w) + ' ' + text ]),
				E('label', { 'for': 'autobackup-ok-' + w }, [ box, ' ', _('I understand, restore it anyway') ])
			]));
		});

		if (c.needs_passphrase) {
			pass = E('input', { 'type': 'password', 'id': 'autobackup-restore-pass', 'autocomplete': 'off', 'style': 'width:100%', 'input': function() { update(); } });
			body.push(E('div', { 'class': 'autobackup-field' }, [
				E('label', { 'for': 'autobackup-restore-pass' }, [ _('Passphrase of this backup') ]),
				pass,
				E('p', { 'class': 'autobackup-help' }, [ _('The backup is encrypted, and the passphrase set now does not open it. Enter the one that was set when it was made.') ])
			]));
		}

		if ((c.missing_packages || []).length)
			body.push(notice('notice', [
				E('p', {}, [ _('These add-ons were installed when the backup was made and are not installed now. Their settings are restored, but the add-ons themselves are not: install them again (before or after restoring) for those settings to do anything.') ]),
				E('ul', {}, c.missing_packages.map(function(p) { return E('li', {}, [ E('code', {}, [ String(p) ]) ]); }))
			]));

		body.push(E('p', {}, [ E('strong', {}, [ _('Restoring replaces this router\'s settings with the backup\'s and restarts the router.') ]), ' ',
			_('Everything connected will lose its connection for a minute or two. If the backup has another router address or Wi-Fi network, reconnect to that.') ]));

		err = E('div');
		body.push(err);

		var update = function() {
			go.disabled = ticks.some(function(t) { return !t.checked; }) || (pass && pass.value === '');
		};

		go = E('button', { 'class': 'cbi-button cbi-button-negative', 'type': 'button', 'click': function() {
			busyButton(go, true);
			close.disabled = true;
			while (err.firstChild)
				err.removeChild(err.firstChild);
			var opts = {
				passphrase: pass ? pass.value : '',
				force_firmware: (c.warnings || []).indexOf('other_firmware') >= 0,
				force_unverified: (c.warnings || []).indexOf('unverified') >= 0
			};
			must(env.api.restore(src, opts)).then(function() {
				env.ui.showModal(_('Restoring…'), [
					E('p', { 'class': 'spinning' }, [ _('The settings are restored and the router is restarting.') ]),
					E('p', {}, [ _('Reconnect in a minute or two, then reload this page. If the backup had another router address, open that address instead.') ])
				]);
			}).catch(function(e) {
				busyButton(go, false);
				close.disabled = false;
				update();
				err.appendChild(notice('error', [ errorOf(e) ]));
			});
		} }, [ _('Restore and restart') ]);
		update();

		env.ui.showModal(_('Restore this backup?'), body.concat([ E('div', { 'class': 'right' }, [ close, ' ', go ]) ]));
	},

	/* ---------------------------------------------------------- Settings -- */

	settings: function(env, st, cfg, redraw) {
		var f = {}, err = {}, save, saved, encOff;

		var field = function(name, label, input, help) {
			err[name] = E('p', { 'class': 'autobackup-field-error', 'role': 'alert' });
			return E('div', { 'class': 'autobackup-row', 'data-field': name }, [
				E('label', { 'for': 'autobackup-' + name }, [ label ]),
				E('div', {}, [ input ].concat(help ? [ E('p', { 'class': 'autobackup-help' }, [ help ]) ] : []).concat([ err[name] ]))
			]);
		};
		var select = function(name, options, value) {
			f[name] = E('select', { 'id': 'autobackup-' + name, 'change': function() { show(); } }, options.map(function(o) {
				return E('option', { 'value': o[0], 'selected': String(o[0]) === String(value) ? 'selected' : null }, [ o[1] ]);
			}));
			return f[name];
		};

		var hours = [], minutes = [], drives = [ [ '', _('The first USB drive found') ] ], i;
		for (i = 0; i < 24; i++) hours.push([ String(i), two(i) ]);
		for (i = 0; i < 60; i++) minutes.push([ String(i), two(i) ]);
		(st.drives || []).forEach(function(d) { drives.push([ d, d ]); });
		if (cfg.drive && (st.drives || []).indexOf(cfg.drive) < 0)
			drives.push([ cfg.drive, _('%s (not plugged in)').format(cfg.drive) ]);

		f.keep = E('input', { 'type': 'number', 'id': 'autobackup-keep', 'min': '1', 'max': '100', 'value': cfg.keep || '10', 'style': 'width:6em' });
		f.encrypt = E('input', { 'type': 'checkbox', 'id': 'autobackup-encrypt', 'checked': cfg.encrypt === '1' ? 'checked' : null, 'change': function() { show(); } });
		f.pass = E('input', { 'type': 'password', 'id': 'autobackup-pass', 'autocomplete': 'new-password' });
		f.pass2 = E('input', { 'type': 'password', 'id': 'autobackup-pass2', 'autocomplete': 'new-password' });

		var weekdayRow = field('weekday', _('Day'), select('weekday', DAYS.map(function(d, n) { return [ String(n), d ]; }), cfg.weekday || '0'));
		var timeRow = field('hour', _('Time'), E('span', {}, [
			select('hour', hours, cfg.hour || '3'), ' : ', select('minute', minutes, cfg.minute || '30')
		]), _('The router\'s own time (System → Time zone).'));
		var passRow = field('pass', cfg.passphrase_set ? _('New passphrase') : _('Passphrase'), E('div', {}, [
			f.pass, E('label', { 'for': 'autobackup-pass2', 'class': 'autobackup-sub' }, [ _('Again') ]), f.pass2
		]), cfg.passphrase_set
			? _('A passphrase is set. Leave these empty to keep it. A new one applies to backups made from now on; older backups still need the passphrase they were made with.')
			: _('8 characters or more. Write it down somewhere safe: without it an encrypted backup cannot be restored, not even on this router after a reset.'));
		encOff = notice('warning', [ _('Turning encryption off forgets the passphrase. Backups already made with it still need it to be restored, so keep it somewhere safe.') ]);

		var show = function() {
			weekdayRow.style.display = f.schedule.value === 'weekly' ? '' : 'none';
			timeRow.style.display = f.schedule.value === 'off' ? 'none' : '';
			passRow.style.display = f.encrypt.checked ? '' : 'none';
			encOff.style.display = (!f.encrypt.checked && cfg.encrypt === '1') ? '' : 'none';
		};

		saved = E('span', { 'class': 'autobackup-saved', 'role': 'status' });
		save = E('button', { 'class': 'cbi-button cbi-button-action', 'type': 'button', 'click': function() {
			Object.keys(err).forEach(function(k) { while (err[k].firstChild) err[k].removeChild(err[k].firstChild); });
			saved.textContent = '';
			var p = f.pass.value, enc = f.encrypt.checked, values = {
				schedule: f.schedule.value, weekday: f.weekday.value, hour: f.hour.value, minute: f.minute.value,
				keep: String(f.keep.value).trim(), drive: f.drive.value
			};
			if (!/^\d{1,3}$/.test(values.keep) || +values.keep < 1 || +values.keep > 100) {
				err.keep.textContent = _('A whole number from 1 to 100.');
				return;
			}
			if (enc && (p !== '' || !cfg.passphrase_set)) {
				if (p === '' && !cfg.passphrase_set) {
					err.pass.textContent = _('Enter a passphrase to encrypt backups.');
					return;
				}
				if (p !== f.pass2.value) {
					err.pass.textContent = _('The two passphrases are not the same.');
					return;
				}
				if (p.length < 8) {
					err.pass.textContent = reasonText('invalid_passphrase');
					return;
				}
			}
			busyButton(save, true);
			/* A new passphrase first: setting one turns encryption on. */
			var step = (enc && p !== '') ? must(env.api.setPassphrase(p)) : Promise.resolve();
			step.then(function() {
				values.encrypt = enc ? '1' : '0';
				return must(env.api.set(values));
			}).then(function() {
				saved.textContent = _('Saved.');
				f.pass.value = f.pass2.value = '';
				return redraw();
			}).catch(function(e) {
				var k = e.field === 'passphrase' ? 'pass' : e.field === 'minute' ? 'hour' : e.field;
				if (k && err[k])
					err[k].textContent = errorOf(e);
				else
					saved.textContent = _('Not saved: %s').format(errorOf(e));
			}).then(function() {
				busyButton(save, false);
			});
		} }, [ _('Save') ]);

		var node = E('div', {}, [
			E('h2', {}, [ _('Settings') ]),
			untested(st),
			E('div', { 'class': 'cbi-section autobackup-form' }, [
				E('h3', {}, [ _('Schedule') ]),
				field('schedule', _('Back up'), select('schedule', [ [ 'off', _('Only when I press Back up now') ], [ 'daily', _('Every day') ], [ 'weekly', _('Every week') ] ], cfg.schedule || 'off')),
				weekdayRow,
				timeRow,
				field('keep', _('Keep'), f.keep, _('How many of this router\'s backups to keep on the drive; the oldest beyond that are deleted.')),
				E('h3', {}, [ _('USB drive') ]),
				field('drive', _('Save to'), select('drive', drives, cfg.drive || ''), _('Backups go into the folder autobackup/<router name>/ on the drive. If the drive is not plugged in, the backup fails and Status says so; nothing is saved on the router instead.')),
				E('h3', {}, [ _('Encryption') ]),
				field('encrypt', _('Encrypt backups'), E('span', {}, [ f.encrypt, ' ', E('label', { 'for': 'autobackup-encrypt' }, [ _('Encrypt backups with a passphrase (AES-256)') ]) ]),
					_('A backup holds your Wi-Fi passwords, VPN keys and the router\'s admin password. Encryption protects them if the USB drive is lost or stolen. It does not protect against someone who can already sign in to the router.')),
				passRow,
				encOff
			]),
			E('div', { 'class': 'autobackup-actions' }, [ save, ' ', saved ])
		]);
		show();
		return node;
	}
});

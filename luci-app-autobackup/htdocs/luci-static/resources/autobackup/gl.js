/*
 * Auto Backup inside the GL.iNet admin panel.
 *
 * The panel's menu entry (/usr/share/oui/menu.d/autobackup.json) loads
 * /views/gl-sdk4-ui-autobackup.common.js, which shows this script in a
 * frame of its own, so nothing here can change how the panel itself looks
 * or works. The pages are the same as in LuCI (autobackup/app.js); this
 * file gives them what they need, the panel's way:
 *   - the router: window.$request -> RPC object "autobackup"
 *     (/usr/lib/oui-httpd/rpc/autobackup), through the panel's login;
 *   - files: the panel's own /download and /upload, with its session
 *     (cookie Admin-Token) and the paths it allows
 *     (/usr/share/gl-download.d/autobackup, /usr/share/gl-upload.d/autobackup);
 *   - dialogs, notifications, and the panel's light or dark colours.
 *
 * As in LuCI, E() assigns a bare string child with innerHTML. Text from the
 * drive or the router is always passed as an array child.
 * SPDX-License-Identifier: MIT
 */
(function() {
	'use strict';

	var BASE = '/luci-static/resources/';
	var STAMP = Date.now();
	var UPLOAD = '/tmp/autobackup-upload';

	var host = null, frame = null;
	try {
		if (window.parent !== window && typeof window.parent.$request === 'function')
			host = window.parent;
		frame = window.frameElement;
	} catch (e) {}

	/* ---------------------------------------------------- LuCI stand-ins -- */

	window._ = function(s) { return s; };

	/* LuCI's String.prototype.format, for the conversions the pages use. */
	String.prototype.format = function() {
		var args = arguments, i = 0;
		return this.replace(/%(0|\x20)?(-)?(\d+)?(\.\d+)?([%dufs])/g, function(m, pad, left, width, prec, type) {
			if (type === '%')
				return '%';
			if (i >= args.length)
				return m;
			var v = args[i++];
			if (type === 'd' || type === 'u')
				v = Math.floor(+v || 0).toFixed(0);
			else if (type === 'f')
				v = prec ? (+v || 0).toFixed(+prec.substring(1)) : String(+v || 0);
			else
				v = String(v);
			while (width && v.length < +width)
				v = left ? v + ' ' : (pad || ' ') + v;
			return v;
		});
	};

	function append(node, c) {
		if (c == null)
			return;
		if (Array.isArray(c)) {
			c.forEach(function(x) {
				if (x instanceof Node)
					node.appendChild(x);
				else if (x != null)
					node.appendChild(document.createTextNode(String(x)));
			});
		}
		else if (c instanceof Node)
			node.appendChild(c);
		else
			node.innerHTML = String(c);   /* LuCI semantics: see the note at the top */
	}

	window.E = function(tag, attrs, data) {
		var el = document.createElement(tag);
		if (attrs != null && (typeof attrs !== 'object' || Array.isArray(attrs) || attrs instanceof Node)) {
			data = attrs;
			attrs = null;
		}
		for (var k in attrs || {}) {
			var v = attrs[k];
			if (v == null)
				continue;
			if (typeof v === 'function')
				el.addEventListener(k, v);
			else
				el.setAttribute(k, v);
		}
		append(el, data);
		return el;
	};

	function clear(node) {
		while (node.firstChild)
			node.removeChild(node.firstChild);
	}

	/* One call to the router, through the panel's login. */
	function call(method, params, seconds) {
		if (!host)
			return Promise.reject(new Error(_('This page only works inside the GL.iNet admin panel.')));
		return Promise.resolve(host.$request('call', [ 'sid', 'autobackup', method, params || {} ],
			{ timeout: (seconds || 60) * 1000, isCancel: false, ignoreCoreErrTips: true })).catch(function(e) {
			throw new Error(e && (e.message || e.err_msg || e.type) || String(e));
		});
	}

	/* The panel's session, as its own pages send it to /download and /upload. */
	function sid() {
		try {
			if (typeof host.$getCookie === 'function')
				return host.$getCookie('Admin-Token') || '';
			var m = /(?:^|;\s*)Admin-Token=([^;]*)/.exec(host.document.cookie);
			return m ? decodeURIComponent(m[1]) : '';
		} catch (e) {
			return '';
		}
	}

	function origin() {
		try { return host.location.origin; } catch (e) { return ''; }
	}

	var api = {
		status: function() { return call('get_status'); },
		list: function() { return call('get_list', {}, 90); },
		backup: function() { return call('backup', {}, 320); },
		remove: function(id) { return call('delete', { id: id }); },
		check: function(src) { return call('check_restore', { src: src }, 150); },
		restore: function(src, o) {
			var p = { src: src, force_firmware: !!o.force_firmware, force_unverified: !!o.force_unverified };
			if (o.passphrase)
				p.passphrase = o.passphrase;
			return call('restore', p, 200);
		},
		config: function() { return call('get_config'); },
		set: function(values) { return call('set_config', { values: values }); },
		setPassphrase: function(p) { return call('set_passphrase', { passphrase: p }); },
		/* As the panel's own $downloadFile: a form posted to /download from
		 * the panel's page; the router answers with the file. */
		download: function(path, name) {
			return new Promise(function(resolve, reject) {
				try {
					var doc = host.document, form = doc.createElement('form');
					form.action = origin() + '/download';
					form.method = 'POST';
					form.style.display = 'none';
					[ [ 'sid', sid() ], [ 'path', path ], [ 'filename', name ] ].forEach(function(f) {
						var i = doc.createElement('input');
						i.type = 'hidden';
						i.name = f[0];
						i.value = f[1];
						form.appendChild(i);
					});
					doc.body.appendChild(form);
					form.submit();
					setTimeout(function() { form.parentNode.removeChild(form); resolve(); }, 1000);
				} catch (e) {
					reject(e);
				}
			});
		},
		/* As the panel's own upload card: sid, size and path before the file. */
		upload: function(file) {
			var data = new FormData();
			data.append('sid', sid());
			data.append('size', String(file.size));
			data.append('path', UPLOAD);
			data.append('file', file, 'autobackup-upload');
			return fetch(origin() + '/upload', { method: 'POST', body: data, credentials: 'same-origin' }).then(function(r) {
				if (!r.ok)
					throw new Error(r.status === 413 || r.status === 507 ? _('the file is too large for the router\'s memory') : 'HTTP ' + r.status);
			});
		}
	};

	/* ------------------------------------------------------- dialogs etc. -- */

	var modal = null, modalReturn = null, notices = null;

	/* Distance from the top of this frame to the top of the visible part of
	 * the panel, so a dialog opens where the user is looking. */
	function visibleTop() {
		try {
			return Math.max(0, -frame.getBoundingClientRect().top);
		} catch (e) {
			return 0;
		}
	}

	var ui = {
		showModal: function(title, children) {
			ui.hideModal(true);
			modalReturn = modalReturn || document.activeElement;
			var box = E('div', { 'class': 'abgl-modal modal', 'role': 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'abgl-modal-title' }, [
				E('h4', { 'id': 'abgl-modal-title' }, [ title ]),
				E('div', {}, children)
			]);
			modal = E('div', { 'class': 'abgl-backdrop', 'keydown': function(ev) {
				if (ev.key === 'Escape')
					ui.hideModal();
			} }, [ box ]);
			document.body.appendChild(modal);
			box.style.top = (visibleTop() + 72) + 'px';
			resize();
			var first = box.querySelector('input, button');
			if (first)
				first.focus();
			return box;
		},
		hideModal: function(keepFocus) {
			if (modal && modal.parentNode)
				modal.parentNode.removeChild(modal);
			modal = null;
			if (keepFocus !== true) {
				if (modalReturn && modalReturn.focus && document.contains(modalReturn))
					modalReturn.focus();
				modalReturn = null;
			}
			resize();
		},
		addNotification: function(title, children, type) {
			var n = E('div', { 'class': 'alert-message ' + (type || ''), 'role': 'alert' }, [
				title ? E('strong', {}, [ title ]) : '',
				E('div', {}, children),
				E('button', { 'class': 'cbi-button', 'type': 'button', 'click': function() { n.parentNode.removeChild(n); resize(); } }, [ _('Dismiss') ])
			]);
			notices.appendChild(n);
			resize();
			return n;
		}
	};

	/* ------------------------------------------------ the pages' module -- */

	var BUILTIN = { baseclass: { extend: function(o) { return o; } } };
	var modules = {};

	function requireModule(name) {
		if (BUILTIN[name])
			return Promise.resolve(BUILTIN[name]);
		if (name !== 'autobackup.app')
			return Promise.reject(new Error(_('%s is not available in the GL.iNet panel').format(name)));
		if (!modules[name]) {
			var path = BASE + name.replace(/\./g, '/') + '.js';
			modules[name] = fetch(path + '?_t=' + STAMP, { credentials: 'same-origin', cache: 'no-store' }).then(function(r) {
				if (!r.ok)
					throw new Error(_('could not load %s (HTTP %d)').format(path, r.status));
				return r.text();
			}).then(function(src) {
				return instantiate(src, path);
			});
			modules[name].catch(function() { delete modules[name]; });
		}
		return modules[name];
	}

	/* LuCI-style modules: 'require x.y as z' lines at the top, a "return"
	 * at the end. */
	function instantiate(src, path) {
		var lines = src.split('\n'), reqs = [], m;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i].trim();
			if (line === '' || line === "'use strict';")
				continue;
			m = /^'require\s+([A-Za-z0-9_.]+)(?:\s+as\s+([A-Za-z_$][\w$]*))?'\s*;$/.exec(line);
			if (!m)
				break;
			reqs.push({ name: m[1], as: m[2] || m[1].split('.').pop() });
		}
		return Promise.all(reqs.map(function(r) { return requireModule(r.name); })).then(function(deps) {
			var fn = new Function(reqs.map(function(r) { return r.as; }).join(','), src + '\n//# sourceURL=' + path);
			return fn.apply(window, deps);
		});
	}

	/* ---------------------------------------------------------- theme -- */

	/* The panel's colours are CSS variables on its root element; copying
	 * them makes this page follow its light or dark theme. */
	var THEME = [ '--primary', '--primary-hover', '--primary-background', '--error', '--error-background',
		'--warning', '--warning-background', '--success', '--text-title', '--text-subtitle', '--text-strong',
		'--text-regular', '--text-weak', '--text-hint', '--text-disabled', '--background-card', '--background-title',
		'--background-content', '--background-disabled', '--border', '--divider', '--shadow', '--mask' ];

	function luminance(color) {
		var c = document.createElement('canvas').getContext('2d');
		c.fillStyle = '#fff';
		c.fillStyle = color;
		var hex = c.fillStyle, r, g, b;
		if (/^#[0-9a-f]{6}$/i.test(hex)) {
			r = parseInt(hex.substr(1, 2), 16); g = parseInt(hex.substr(3, 2), 16); b = parseInt(hex.substr(5, 2), 16);
		} else {
			var m = /(\d+),\s*(\d+),\s*(\d+)/.exec(hex) || [ 0, 255, 255, 255 ];
			r = +m[1]; g = +m[2]; b = +m[3];
		}
		return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
	}

	function syncTheme() {
		if (!host)
			return;
		try {
			var cs = host.getComputedStyle(host.document.documentElement), root = document.documentElement.style;
			THEME.forEach(function(v) {
				var x = cs.getPropertyValue(v).trim();
				if (x)
					root.setProperty(v, x);
				else
					root.removeProperty(v);
			});
			var font = host.getComputedStyle(host.document.body).fontFamily;
			if (font)
				root.setProperty('--font', font);
			var card = cs.getPropertyValue('--background-card').trim();
			document.documentElement.setAttribute('data-theme', card && luminance(card) < 0.4 ? 'dark' : 'light');
		} catch (e) {}
	}

	function watchTheme() {
		if (!host || !window.MutationObserver)
			return;
		try {
			var mo = new MutationObserver(function() {
				syncTheme();
				setTimeout(syncTheme, 400);
				setTimeout(syncTheme, 1500);
			});
			mo.observe(host.document.head, { childList: true });
			mo.observe(host.document.documentElement, { attributes: true, attributeFilter: [ 'class', 'style', 'data-theme' ] });
			window.addEventListener('pagehide', function() { mo.disconnect(); });
		} catch (e) {}
	}

	var CSS = [
		':root{--primary:#5272f7;--primary-hover:#425bc6;--primary-background:#eef1fe;--error:#e04c7e;--error-background:#fcedf2;',
		'--warning:#f5a623;--warning-background:#fef6e9;--success:#00a896;--text-title:#1f1f3d;--text-subtitle:#555557;--text-strong:#000;',
		'--text-regular:#141427;--text-weak:#333366;--text-hint:#b9b9bd;--text-disabled:#a0a0a3;--background-card:#fff;--background-title:#f2f2f7;',
		'--background-content:#ebebf0;--background-disabled:#ebebf0;--border:#d2d2d6;--divider:#ebebf0;--shadow:#d2d2d6;',
		'--mask:rgba(16,18,35,.24);--font:-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color-scheme:light}',
		/* The panel's own control colour is white in its dark theme too
		 * (its controls are styled separately), so buttons and fields here
		 * use a colour of their own. */
		':root{--abgl-control:#fff}',
		':root[data-theme=dark]{color-scheme:dark;--abgl-control:rgba(255,255,255,.06)}',
		'html,body{margin:0;padding:0;background:transparent}',
		'body{font:14px/1.5 var(--font);color:var(--text-regular);overflow:hidden}',
		'#abgl-app{background:var(--background-card);border-radius:8px;padding:8px 24px 24px;box-sizing:border-box;position:relative}',
		'.abgl-nav{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--border);margin:0 0 16px}',
		'.abgl-nav button{font:inherit;font-weight:600;color:var(--text-weak);background:none;border:0;border-bottom:2px solid transparent;margin:0 0 -1px;padding:10px 14px;min-height:44px;cursor:pointer}',
		'.abgl-nav button:hover{color:var(--primary)}',
		'.abgl-nav button[aria-current=page]{color:var(--primary);border-bottom-color:var(--primary)}',
		'h2{font-size:20px;line-height:1.3;color:var(--text-title);margin:4px 0 4px}',
		'h3{font-size:16px;color:var(--text-title);margin:22px 0 8px}',
		'h4{font-size:16px;margin:0 0 10px;color:var(--text-title)}',
		'a{color:var(--primary)}',
		'p{margin:.5em 0}',
		'code{font-size:13px;background:var(--background-title);border-radius:4px;padding:1px 5px}',
		'.cbi-map-descr{color:var(--text-subtitle);margin:0 0 14px;max-width:72em}',
		'.cbi-section{margin:0 0 18px}',
		'.cbi-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:36px;padding:6px 16px;',
		'border:1px solid var(--border);border-radius:6px;background:var(--abgl-control);color:var(--text-regular);font:inherit;font-weight:500;cursor:pointer;text-decoration:none}',
		'.cbi-button:hover{border-color:var(--primary);color:var(--primary)}',
		'.cbi-button:disabled,.cbi-button[disabled]{opacity:.55;cursor:default}',
		'.cbi-button-action,.cbi-button-action:hover{background:var(--primary);border-color:var(--primary);color:#fff}',
		'.cbi-button-action:hover{background:var(--primary-hover);border-color:var(--primary-hover)}',
		'.cbi-button-negative{color:var(--error)}',
		'.cbi-button-negative:hover{border-color:var(--error);color:var(--error)}',
		':focus-visible{outline:2px solid var(--primary);outline-offset:2px}',
		'input,select{font:inherit;color:var(--text-regular);background:var(--abgl-control);border:1px solid var(--border);border-radius:6px;padding:6px 10px;min-height:36px;box-sizing:border-box;max-width:100%}',
		'input:focus,select:focus{border-color:var(--primary);outline:none}',
		'input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:1px}',
		'input[type=checkbox]{width:18px;height:18px;min-height:0;vertical-align:-3px;accent-color:var(--primary)}',
		'select{min-width:12em}',
		'input[type=password]{width:18em}',
		'.alert-message{border:1px solid var(--warning);background:var(--warning-background);border-radius:6px;padding:10px 14px;margin:10px 0}',
		'.alert-message.error,.alert-message.danger{border-color:var(--error);background:var(--error-background)}',
		'.alert-message.notice{border-color:var(--primary);background:var(--primary-background)}',
		'.alert-message.success{border-color:var(--success);background:transparent}',
		'.alert-message .cbi-button{margin-top:6px}',
		'table.table{border-collapse:collapse;width:100%;font-size:13px}',
		'.table th,.table td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--divider);vertical-align:middle}',
		'.table th{white-space:nowrap;background:var(--background-title);color:var(--text-subtitle);font-weight:600}',
		'.table .right,.right{text-align:right}',
		'.spinning::before{content:"";display:inline-block;width:12px;height:12px;margin-right:8px;vertical-align:-1px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:abgl-spin .8s linear infinite}',
		'@keyframes abgl-spin{to{transform:rotate(360deg)}}',
		'@media (prefers-reduced-motion:reduce){.spinning::before{animation:none}}',
		'.abgl-backdrop{position:absolute;left:0;right:0;top:0;bottom:0;min-height:100%;background:var(--mask);z-index:50}',
		'.abgl-modal .right{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:12px}',
		'.abgl-modal{position:absolute;left:50%;transform:translateX(-50%);width:min(520px,calc(100% - 32px));box-sizing:border-box;background:var(--background-card);border-radius:10px;padding:18px 20px;box-shadow:0 12px 32px rgba(0,0,0,.25)}',
		'.autobackup-row{border-bottom:1px solid var(--divider);padding:12px 0}',
		'.autobackup-row>label{color:var(--text-title)}',
		'.autobackup-help{color:var(--text-subtitle)}',
		'@media (max-width:640px){#abgl-app{padding:8px 14px 18px}.table th,.table td{padding:6px}}'
	].join('\n');

	/* ------------------------------------------------------------ page -- */

	var PAGES = [ [ 'status', _('Status') ], [ 'backups', _('Backups') ], [ 'settings', _('Settings') ] ];
	var app, nav, view, pagesModule = null;

	function resize() {
		if (!frame || !app)
			return;
		var h = app.offsetHeight;
		if (modal && modal.firstChild)
			h = Math.max(h, modal.firstChild.offsetTop + modal.firstChild.offsetHeight + 24);
		frame.style.height = Math.ceil(h) + 'px';
	}

	function show(page) {
		if (!PAGES.some(function(p) { return p[0] === page; }))
			page = 'status';
		ui.hideModal();
		clear(notices);
		try { window.sessionStorage.setItem('autobackup.gl.page', page); } catch (e) {}
		Array.prototype.forEach.call(nav.children, function(b) {
			if (b.getAttribute('data-page') === page)
				b.setAttribute('aria-current', 'page');
			else
				b.removeAttribute('aria-current');
		});
		clear(view);
		view.appendChild(E('p', { 'class': 'spinning' }, [ _('Loading…') ]));
		if (visibleTop() > 0)
			try { frame.scrollIntoView({ block: 'start' }); } catch (e) {}
		return requireModule('autobackup.app').then(function(pages) {
			pagesModule = pages;
			clear(view);
			view.appendChild(pages.mount({ api: api, ui: ui, go: show }, page));
		}).catch(function(e) {
			clear(view);
			view.appendChild(E('div', { 'class': 'alert-message error', 'role': 'alert' }, [
				_('Auto Backup could not load this page: %s').format(e && e.message || e)
			]));
		}).then(resize);
	}

	function start() {
		document.head.appendChild(E('style', {}, [ CSS ]));
		syncTheme();
		watchTheme();

		nav = E('nav', { 'class': 'abgl-nav', 'aria-label': _('Auto Backup pages') }, PAGES.map(function(p) {
			return E('button', { 'type': 'button', 'data-page': p[0], 'click': function() { show(p[0]); } }, [ p[1] ]);
		}));
		notices = E('div');
		view = E('div', { 'id': 'abgl-view' });
		app = E('div', { 'id': 'abgl-app' }, [ nav, notices, view ]);
		document.body.appendChild(app);

		if (window.ResizeObserver)
			new ResizeObserver(resize).observe(app);
		else
			setInterval(resize, 1000);

		if (!host) {
			view.appendChild(E('div', { 'class': 'alert-message error', 'role': 'alert' }, [
				_('This page only works inside the GL.iNet admin panel: open System → Auto Backup there.')
			]));
			resize();
			return;
		}
		var first = null;
		try { first = window.sessionStorage.getItem('autobackup.gl.page'); } catch (e) {}
		show(first || 'status');
	}

	start();
})();

/*
 * Auto Backup
 * Page for the GL.iNet admin panel (menu entry /usr/share/oui/menu.d/autobackup.json).
 * The panel evaluates this file and uses the result as a Vue component, the
 * same way as its own pages. It only provides a frame; Auto Backup itself
 * runs inside it (/luci-static/resources/autobackup/gl.js), so its styles
 * and scripts cannot change how the panel looks or works. The frame's
 * content comes from this page itself (srcdoc), not from a separate address.
 * SPDX-License-Identifier: MIT
 */
module.exports = (function() {
	'use strict';
	var stamp = Date.now();
	var page = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
		'<meta name="viewport" content="width=device-width,initial-scale=1"><title>Auto Backup</title></head>' +
		'<body><script src="/luci-static/resources/autobackup/gl.js?_t=' + stamp + '"></script></body></html>';
	return {
		name: 'autobackup',
		render: function(h) {
			return h('div', { staticClass: 'autobackup-gl', style: { width: '100%', paddingBottom: '16px' } }, [
				h('iframe', {
					attrs: { title: 'Auto Backup', srcdoc: page },
					style: { display: 'block', width: '100%', height: '720px', border: '0', background: 'transparent' }
				})
			]);
		}
	};
})();

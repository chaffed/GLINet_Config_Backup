'use strict';
'require baseclass';
'require rpc';
'require ui';
'require fs';
'require request';

/*
 * What Auto Backup's pages (autobackup/app.js) need, the LuCI way: the
 * rpcd object luci.autobackup (/usr/libexec/rpcd/luci.autobackup), LuCI's
 * dialogs, its download (cgi-download) and upload (cgi-upload).
 * SPDX-License-Identifier: MIT
 */

var UPLOAD = '/tmp/autobackup-upload';

function declare(method, params) {
	return rpc.declare({ object: 'luci.autobackup', method: method, params: params || [] });
}

var callStatus = declare('status'), callList = declare('list'), callBackup = declare('backup'),
	callDelete = declare('delete', [ 'id' ]), callCheck = declare('check', [ 'src' ]),
	callRestore = declare('restore', [ 'src', 'passphrase', 'force_firmware', 'force_unverified' ]),
	callConfig = declare('config'), callSet = declare('set', [ 'values' ]),
	callSetPassphrase = declare('set_passphrase', [ 'passphrase' ]);

return baseclass.extend({
	env: function() {
		return {
			api: {
				status: function() { return callStatus(); },
				list: function() { return callList(); },
				backup: function() { return callBackup(); },
				remove: function(id) { return callDelete(id); },
				check: function(src) { return callCheck(src); },
				restore: function(src, o) { return callRestore(src, o.passphrase || '', !!o.force_firmware, !!o.force_unverified); },
				config: function() { return callConfig(); },
				set: function(values) { return callSet(values); },
				setPassphrase: function(p) { return callSetPassphrase(p); },
				download: function(path, name) {
					return fs.read_direct(path, 'blob').then(function(blob) {
						var url = URL.createObjectURL(blob), a = E('a', { 'href': url, 'download': name, 'style': 'display:none' });
						document.body.appendChild(a);
						a.click();
						setTimeout(function() { URL.revokeObjectURL(url); a.parentNode.removeChild(a); }, 1000);
					});
				},
				/* What ui.uploadFile does, without its own dialog. */
				upload: function(file) {
					var data = new FormData();
					data.append('sessionid', rpc.getSessionID());
					data.append('filename', UPLOAD);
					data.append('filedata', file);
					return request.post(L.env.cgi_base + '/cgi-upload', data).then(function(res) {
						var reply = res.json();
						if (!res.ok || (L.isObject(reply) && reply.failure))
							throw new Error(L.isObject(reply) && reply.message || res.statusText || ('HTTP ' + res.status));
						return reply;
					});
				}
			},
			ui: ui,
			go: function(page) { window.location.href = L.url('admin/system/autobackup', page); }
		};
	}
});

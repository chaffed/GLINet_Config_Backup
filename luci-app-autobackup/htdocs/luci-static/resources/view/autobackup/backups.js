'use strict';
'require view';
'require autobackup.app as app';
'require autobackup.luci as luci';

/* Auto Backup – the backups page (drawn by autobackup/app.js). SPDX-License-Identifier: MIT */
return view.extend({
	render: function() {
		return app.mount(luci.env(), 'backups');
	},
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});

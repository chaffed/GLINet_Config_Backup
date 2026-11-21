'use strict';
'require view';
'require autobackup.app as app';
'require autobackup.luci as luci';

/* Auto Backup – the settings page (drawn by autobackup/app.js). SPDX-License-Identifier: MIT */
return view.extend({
	render: function() {
		return app.mount(luci.env(), 'settings');
	},
	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});

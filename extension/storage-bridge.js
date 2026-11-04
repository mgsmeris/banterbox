/*
 * BanterBox storage bridge (runs in the extension's ISOLATED world, after settings-core.js).
 *
 * banterbox.js runs in the page and can't reach extension storage, so this
 * script hands it the settings through a DOM event carrying a JSON string:
 *
 *   page   -> bridge   "banterbox:request"            send me the settings
 *   bridge -> page     "banterbox:settings" (JSON)    current settings
 *
 * It's read-only on purpose: settings are only changed in the extension popup,
 * so nothing running on perpheads can change them.
 */
(() => {
	'use strict';

	const S = globalThis.BanterBoxSettings;
	const send = (settings) => {
		document.dispatchEvent(new CustomEvent('banterbox:settings', { detail: JSON.stringify(settings) }));
	};
	const sendCurrent = () => S.read().then(send, () => send(S.sanitize(null)));

	document.addEventListener('banterbox:request', sendCurrent);
	S.onChange(send); // changed in the popup: update open perpheads tabs right away
	sendCurrent();
})();

/*
 * BanterBox storage bridge (runs in the extension's ISOLATED world, after settings-core.js).
 *
 * banterbox.js runs in the page and can't reach extension storage, so this
 * script hands it the settings through a DOM event carrying a JSON string:
 *
 *   page   -> bridge   "banterbox:request"            send me the settings
 *   bridge -> page     "banterbox:settings" (JSON)    current settings
 *
 * Settings are otherwise only changed in the extension popup. The one exception
 * is the consent prompt in the emoji menu: its Save button is handled here, and
 * only for real clicks (isTrusted), so a script on perpheads can't answer it.
 */
(() => {
	'use strict';

	const S = globalThis.BanterBoxSettings;
	const send = (settings) => {
		document.dispatchEvent(new CustomEvent('banterbox:settings', { detail: JSON.stringify(settings) }));
	};
	const sendCurrent = () => S.read().then(send, () => send(S.sanitize(null)));

	document.addEventListener('banterbox:request', sendCurrent);

	document.addEventListener('click', (ev) => {
		if (!ev.isTrusted || !(ev.target instanceof Element)) return;
		const save = ev.target.closest('[data-bb-consent="save"]');
		const box = save && save.closest('.bb-consent');
		if (!box) return;
		const ticked = (name) => {
			const input = box.querySelector('input[data-bb-consent="' + name + '"]');
			return !!(input && input.checked);
		};
		const answer = { asked: true, remote: ticked('remote'), updates: ticked('updates') };
		S.read().then((s) => S.write({ ...s, ...answer }));
	}, true);
	S.onChange(send); // changed in the popup: update open perpheads tabs right away
	sendCurrent();
})();

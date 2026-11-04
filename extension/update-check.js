// BanterBox update checker (background). Reads https://sb.smeris.me/update.json,
// the same file Firefox uses for automatic updates. If a newer version is out and
// still isn't installed after a while (automatic updates off, or an unpacked
// Chrome install), it puts a badge on the toolbar icon; the popup says what's new.
//
// Can be switched off in the popup ("updateCheck" = false); then it fetches nothing.
'use strict';

const UPDATE_URL = 'https://sb.smeris.me/update.json';
const ADDON_ID = 'banterbox@smeris.me';
const CHECK_MINUTES = 12 * 60;
// Firefox with automatic updates on installs a new version within about a day;
// only tell people who still don't have it after that. Chrome never updates an
// unpacked install, so tell them straight away.
const GRACE_MS = typeof browser !== 'undefined' ? 36 * 3600 * 1000 : 0;
const VERSION_RE = /^\d{1,5}(\.\d{1,5}){0,3}$/;

function newer(a, b) {
	const x = a.split('.').map(Number);
	const y = b.split('.').map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
	}
	return false;
}

async function enabled() {
	const { updateCheck } = await chrome.storage.local.get('updateCheck');
	return updateCheck !== false;
}

async function showBadge() {
	const installed = chrome.runtime.getManifest().version;
	const { update } = await chrome.storage.local.get('update');
	const due = (await enabled()) && update && VERSION_RE.test(update.latest)
		&& newer(update.latest, installed) && Date.now() - update.seen >= GRACE_MS;
	await chrome.action.setBadgeText({ text: due ? '1' : '' });
	if (due) {
		await chrome.action.setBadgeBackgroundColor({ color: '#e8622c' });
		await chrome.action.setTitle({ title: 'BanterBox: version ' + update.latest + ' is available' });
	} else {
		await chrome.action.setTitle({ title: 'BanterBox' });
	}
}

async function check() {
	if (!(await enabled())) return showBadge();
	try {
		const res = await fetch(UPDATE_URL, { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' });
		if (!res.ok) throw new Error('HTTP ' + res.status);
		const data = await res.json();
		const list = data && data.addons && data.addons[ADDON_ID] && data.addons[ADDON_ID].updates;
		let latest = null;
		for (const u of Array.isArray(list) ? list : []) {
			const v = u && typeof u.version === 'string' ? u.version : '';
			if (VERSION_RE.test(v) && (!latest || newer(v, latest))) latest = v;
		}
		if (latest) {
			const { update } = await chrome.storage.local.get('update');
			// Remember when this version was first seen, for the grace period.
			const seen = update && update.latest === latest ? update.seen : Date.now();
			await chrome.storage.local.set({ update: { latest, seen } });
		}
	} catch (e) {
		// Offline or the site is down: try again next time.
	}
	return showBadge();
}

// Firefox drops alarms when it restarts, so set it up again on every start.
function start() {
	chrome.alarms.create('update-check', { delayInMinutes: 1, periodInMinutes: CHECK_MINUTES });
	check();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'update-check') check(); });
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && 'updateCheck' in changes) check();
});

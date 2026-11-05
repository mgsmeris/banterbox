/*
 * BanterBox settings: shape, validation and storage. Shared by the extension
 * popup and the storage bridge (both run in the extension's own context, never
 * in the page).
 *
 *   { asked: boolean,                        has the user answered the consent prompt?
 *     remote: boolean,                       load the sb.smeris.me list?
 *     updates: boolean,                      check sb.smeris.me for new versions?
 *     color: '' | '#rrggbb',                 default colour for shoutbox messages
 *     custom: [{ name, url, w, h }] }        the user's own emojis
 *
 * Nothing is requested from sb.smeris.me until asked is true. remote and
 * updates default to true, so the consent prompt starts with both ticked.
 */
(() => {
	'use strict';

	const api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;
	const KEY = 'settings';
	const MAX_CUSTOM = 200;
	const NAME_RE = /^[a-z0-9_]{2,32}$/;
	const COLOR_RE = /^#[0-9a-f]{6}$/;

	/**
	 * A user-supplied image link we're willing to store and post: https only, no
	 * login details, already in normalised form, and no characters that could
	 * break out of an [IMG] tag or an HTML attribute.
	 */
	function safeUrl(s) {
		if (typeof s !== 'string' || s.length > 500) return false;
		let u;
		try { u = new URL(s); } catch (e) { return false; }
		return u.protocol === 'https:' && !u.username && !u.password && u.href === s
			&& !/[\s"'<>[\]\\]/.test(s);
	}

	function sanitize(raw) {
		const s = raw && typeof raw === 'object' ? raw : {};
		const custom = [];
		const seen = new Set();
		for (const e of Array.isArray(s.custom) ? s.custom.slice(0, MAX_CUSTOM) : []) {
			if (!e || typeof e !== 'object') continue;
			const w = Number(e.w), h = Number(e.h);
			if (typeof e.name !== 'string' || !NAME_RE.test(e.name) || seen.has(e.name)) continue;
			if (!safeUrl(e.url)) continue;
			if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) continue;
			seen.add(e.name);
			custom.push({ name: e.name, url: e.url, w, h });
		}
		const color = typeof s.color === 'string' && COLOR_RE.test(s.color.toLowerCase()) ? s.color.toLowerCase() : '';
		return { asked: s.asked === true, remote: s.remote !== false, updates: s.updates !== false, color, custom };
	}

	async function read() {
		const got = await api.storage.local.get(KEY);
		return sanitize(got && got[KEY]);
	}

	async function write(settings) {
		const clean = sanitize(settings);
		await api.storage.local.set({ [KEY]: clean });
		return clean;
	}

	function onChange(fn) {
		api.storage.onChanged.addListener((changes, area) => {
			if (area === 'local' && changes[KEY]) fn(sanitize(changes[KEY].newValue));
		});
	}

	/** What the user actually allowed: nothing until they've answered. */
	const allows = (s, what) => s.asked && s[what];

	globalThis.BanterBoxSettings = Object.freeze({ MAX_CUSTOM, NAME_RE, COLOR_RE, safeUrl, sanitize, allows, read, write, onChange });
})();

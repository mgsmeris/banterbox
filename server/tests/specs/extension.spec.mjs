// Tests for the extension's emoji menu (banterbox.js), run in Edge against a stub of
// the perpheads chat: a fake XF object and a fake Froala editor. Network requests to
// sb.smeris.me are answered by Playwright, so the real production build is tested as is.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { png } from '../helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, '..', '..', '..', 'extension', 'banterbox.js');
const EXT = path.resolve(here, '..', '..', '..', 'extension');
const SRC = 'https://sb.smeris.me/';
const id = (n) => n.toString(16).padStart(32, '0');

// A fake chrome.storage, kept in a test-only localStorage key. Pages on the same test
// origin (the stub chat and the popup) share it, and the browser's "storage" event
// between tabs drives onChanged, just like the real extension storage.
const FAKE_STORAGE = `window.chrome = { storage: {
	local: {
		get: async (k) => ({ [k]: JSON.parse(localStorage.getItem('__ext') || '{}')[k] }),
		set: async (o) => { const d = JSON.parse(localStorage.getItem('__ext') || '{}'); Object.assign(d, o); localStorage.setItem('__ext', JSON.stringify(d)); },
	},
	onChanged: { addListener(fn) {
		addEventListener('storage', (e) => {
			if (e.key !== '__ext') return;
			fn({ settings: { newValue: JSON.parse(e.newValue || '{}').settings } }, 'local');
		});
	} },
} };`;
const extStorage = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('__ext') || '{}').settings);
const injectAll = async (page) => {
	await page.addScriptTag({ path: path.join(EXT, 'settings-core.js') });
	await page.addScriptTag({ path: path.join(EXT, 'storage-bridge.js') });
	await page.addScriptTag({ path: SCRIPT });
};

// "__proto__" is a legal name; it must not pollute anything (lookups use Map/Set).
const PROTO = { name: '__proto__', url: `${SRC}e/${id(18)}.png`, w: 10, h: 10 };
const GOOD = [
	{ name: 'kappa', url: `${SRC}e/${id(1)}.png`, w: 32, h: 32 },
	{ name: 'pog_champ', url: `${SRC}e/${id(2)}.gif`, w: 64, h: 64, animated: true },
	{ name: 'wide_boi', url: `${SRC}e/${id(3)}.webp`, w: 128, h: 64 },
];
const HOSTILE = [
	{ name: '<img src=x onerror=alert(1)>', url: `${SRC}e/${id(10)}.png`, w: 10, h: 10 },
	{ name: 'js_url', url: 'javascript:alert(1)', w: 10, h: 10 },
	{ name: 'other_host', url: `https://evil.example/sb/e/${id(11)}.png`, w: 10, h: 10 },
	{ name: 'lookalike', url: `https://sb.smeris.me.evil.example/e/${id(12)}.png`, w: 10, h: 10 },
	{ name: 'traversal', url: `${SRC}e/../../${id(13)}.png`, w: 10, h: 10 },
	{ name: 'query', url: `${SRC}e/${id(14)}.png?x=" onerror="alert(1)`, w: 10, h: 10 },
	{ name: 'svg', url: `${SRC}e/${id(15)}.svg`, w: 10, h: 10 },
	{ name: 'huge', url: `${SRC}e/${id(16)}.png`, w: 99999, h: 10 },
	{ name: 'kappa', url: `${SRC}e/${id(17)}.png`, w: 10, h: 10 }, // duplicate name
	'not an object',
	null,
];

const STUB = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>
<div id="siropuChat">
	<form>
		<div class="fr-toolbar">
			<div class="fr-btn-grp"><button type="button" data-cmd="bold">B</button><button type="button" data-cmd="insertImage">Img</button></div>
		</div>
		<div class="fr-element" contenteditable="true"></div>
		<textarea class="js-editor" name="message_html" data-xf-init="editor"></textarea>
	</form>
	<ul class="siropuChatMessages"></ul>
</div>
<script>
	// Minimal stand-ins for XenForo and Froala.
	window.bbView = false;
	const el = document.querySelector('.fr-element');
	const ed = {
		html: { insert: (h) => { el.insertAdjacentHTML('beforeend', h); }, get: () => el.innerHTML },
		selection: { save() {}, restore() {} },
		events: { focus() {}, on() {} },
		undo: { saveStep() {} },
	};
	const editorHandler = { ed, isBbCodeView: () => window.bbView };
	window.XF = {
		Element: {
			getHandler: (t, name) => (name === 'editor' && t.matches('textarea') ? editorHandler : null),
			newHandler: (o) => o,
			register() {},
		},
		ajax: () => Promise.resolve({}),
		on() {},
	};
</script>
</body></html>`;

async function setup(page, { list = [...GOOD, PROTO, ...HOSTILE], fail = false, raw = null, bridge = false } = {}) {
	let hits = 0;
	const smeris = [];
	page.on('request', (r) => { if (r.url().startsWith(SRC)) smeris.push(r.url()); });
	await page.route('https://perpheads.test/', (r) => r.fulfill({ contentType: 'text/html', body: STUB }));
	await page.route(`${SRC}emojis.json`, (r) => {
		hits++;
		if (fail) return r.fulfill({ status: 500, body: 'down' });
		return r.fulfill({
			contentType: 'application/json',
			headers: { 'access-control-allow-origin': 'https://perpheads.test' },
			body: raw ?? JSON.stringify({ version: 1, emojis: list }),
		});
	});
	await page.route(`${SRC}e/**`, (r) => r.fulfill({ contentType: 'image/png', body: png(16, 16) }));
	await page.route('https://evil.example/**', (r) => r.abort());
	// Somewhere for "own" emojis to live.
	await page.context().route('https://img.example/**', (r) => (r.request().url().includes('missing')
		? r.fulfill({ status: 404, body: 'nope' })
		: r.fulfill({ contentType: 'image/png', body: png(64, 48) })));
	if (bridge) {
		await page.context().addInitScript(FAKE_STORAGE);
		// The extension's files, so the popup can be opened on the same test origin.
		await page.context().route('https://perpheads.test/ext/**', (r) => {
			const file = path.join(EXT, new URL(r.request().url()).pathname.slice(5));
			if (!file.startsWith(EXT)) return r.abort();
			const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png' }[file.split('.').pop()];
			return r.fulfill({ path: file, contentType: type });
		});
	}
	await page.goto('https://perpheads.test/');
	if (bridge) await injectAll(page);
	else await page.addScriptTag({ path: SCRIPT });
	await expect(page.locator('.bb-emoji-btn')).toHaveCount(1);
	return { hits: () => hits, smeris: () => smeris.length };
}

const openMenu = async (page) => {
	await page.locator('.bb-emoji-btn').click();
	await expect(page.locator('.bb-emoji-menu')).toBeVisible();
};

test('adds a Kappa button right after the image button', async ({ page }) => {
	await setup(page);
	const prev = await page.locator('.bb-emoji-btn').evaluate((b) => b.previousElementSibling.dataset.cmd);
	expect(prev).toBe('insertImage');
	await expect(page.locator('.bb-emoji-btn img')).toHaveAttribute('src', /^data:image\/png;base64,/);
});

test('shows only emojis that pass validation', async ({ page }) => {
	const errors = [];
	page.on('pageerror', (e) => errors.push(e));
	page.on('dialog', (d) => { errors.push(new Error('dialog: ' + d.message())); d.dismiss(); });
	await setup(page);
	await openMenu(page);
	const tiles = page.locator('.bb-emoji-menu .bb-emoji-tile');
	await expect(tiles).toHaveCount(4);
	expect(await tiles.evaluateAll((ts) => ts.map((t) => t.title))).toEqual([':kappa:', ':pog_champ:', ':wide_boi:', ':__proto__:']);
	await page.locator('.bb-emoji-tile[title=":__proto__:"]').click();
	expect(await page.evaluate(() => Object.keys(Object.prototype).length + ({}).w)).toBeNaN(); // nothing added
	expect(await page.evaluate(() => Object.getOwnPropertyNames(Object.prototype).includes('w'))).toBe(false);
	for (const src of await page.locator('.bb-emoji-menu img').evaluateAll((is) => is.map((i) => i.src))) {
		expect(src).toMatch(/^https:\/\/sb\.smeris\.me\/e\/[a-f0-9]{32}\.(png|gif|webp)$/);
	}
	// Nothing from the hostile entries made it into the page.
	await expect(page.locator('img[src="x"]')).toHaveCount(0);
	expect(await page.content()).not.toContain('evil.example');
	expect(errors).toEqual([]);
});

test('picking an emoji inserts it as a sized image and remembers it', async ({ page }) => {
	await setup(page);
	await openMenu(page);
	await page.locator('.bb-emoji-tile[title=":wide_boi:"]').click();
	await expect(page.locator('.bb-emoji-menu')).toHaveCount(0);
	const img = page.locator('.fr-element img');
	await expect(img).toHaveAttribute('src', GOOD[2].url);
	await expect(img).toHaveAttribute('alt', ':wide_boi:');
	expect(await img.getAttribute('style')).toContain('width: 64px'); // 128x64 shown 32 px high

	await openMenu(page);
	await expect(page.locator('.bb-emoji-heading').first()).toHaveText('Recently used');
	await expect(page.locator('.bb-emoji-grid').first().locator('.bb-emoji-tile')).toHaveCount(1);
});

test('search filters, and Enter inserts the first match', async ({ page }) => {
	await setup(page);
	await openMenu(page);
	await page.keyboard.type(':pog');
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(1);
	await page.keyboard.press('Enter');
	await expect(page.locator('.fr-element img')).toHaveAttribute('alt', ':pog_champ:');

	await openMenu(page);
	await page.keyboard.type('zzz');
	await expect(page.locator('.bb-emoji-empty')).toContainText('No emojis match');
});

test('Escape and outside clicks close the menu', async ({ page }) => {
	await setup(page);
	await openMenu(page);
	await page.keyboard.press('Escape');
	await expect(page.locator('.bb-emoji-menu')).toHaveCount(0);
	await openMenu(page);
	await page.mouse.click(5, 300);
	await expect(page.locator('.bb-emoji-menu')).toHaveCount(0);
	await openMenu(page);
	await page.locator('.bb-emoji-btn').click(); // toggle
	await expect(page.locator('.bb-emoji-menu')).toHaveCount(0);
});

test('BB code mode gets an [IMG] tag in the textarea', async ({ page }) => {
	await setup(page);
	await page.evaluate(() => { window.bbView = true; });
	await openMenu(page);
	await page.locator('.bb-emoji-tile[title=":kappa:"]').click();
	expect(await page.locator('textarea').inputValue())
		.toBe(`[IMG width="32px" alt=":kappa:"]${GOOD[0].url}[/IMG]`);
});

test('a broken or hostile list shows an error, not a crash', async ({ page }) => {
	await setup(page, { raw: '{"version":1,"emojis":"<script>alert(1)</script>"}' });
	await openMenu(page);
	await expect(page.locator('.bb-emoji-empty')).toHaveText('Could not load BanterBox emojis. Try again later.');
});

test('the list is cached, and the cache is used when the server is down', async ({ page, context }) => {
	const s = await setup(page);
	await openMenu(page);
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(4);
	expect(s.hits()).toBe(1);

	// New page on the same site, server now failing: cached emojis still show.
	const page2 = await context.newPage();
	await setup(page2, { fail: true });
	await openMenu(page2);
	await expect(page2.locator('.bb-emoji-tile')).toHaveCount(4);
	await page2.close();
});

test('a tampered cache is validated too', async ({ page }) => {
	await setup(page, { fail: true });
	await page.evaluate((src) => {
		localStorage.setItem('banterbox.emojis.v1', JSON.stringify({
			source: src, at: Date.now(),
			data: { version: 1, emojis: [{ name: 'evil', url: 'javascript:alert(1)', w: 1, h: 1 }, { name: 'ok', url: src + 'e/' + '0'.repeat(31) + 'a.png', w: 8, h: 8 }] },
		}));
	}, SRC);
	await openMenu(page);
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(1);
	await expect(page.locator('.bb-emoji-tile')).toHaveAttribute('title', ':ok:');
});

test('screenshot of the menu (SHOTS=1 only)', async ({ page }) => {
	test.skip(!process.env.SHOTS, 'set SHOTS=1 to save screenshots');
	await page.setViewportSize({ width: 700, height: 560 });
	await setup(page);
	await page.addStyleTag({ content: 'body{background:#16181c;color:#ddd;font-family:system-ui} .fr-toolbar button{background:#23262b;color:#ddd;border:0;width:30px;height:32px}' });
	await openMenu(page);
	await page.screenshot({ path: path.join(here, '..', 'screenshots', 'emoji-menu.png') });
});

// ------------------------------------------- extension popup: settings + own emojis

/** Opens popup.html (the extension's toolbar popup) next to the stub chat. */
async function openPopup(page) {
	const popup = await page.context().newPage();
	await popup.setViewportSize({ width: 360, height: 600 });
	await popup.goto('https://perpheads.test/ext/popup.html');
	await expect(popup.locator('#remote')).toBeVisible();
	return popup;
}

async function addOwn(popup, name, url) {
	await popup.fill('#name', name);
	await popup.fill('#url', url);
	await popup.locator('#addBtn').click();
	await expect(popup.locator('#addBtn')).toHaveText('Add');
}

test('the shoutbox menu has no settings of its own', async ({ page }) => {
	await setup(page, { bridge: true });
	await openMenu(page);
	await expect(page.locator('.bb-emoji-menu input[type=checkbox], .bb-emoji-menu form, .bb-emoji-gear')).toHaveCount(0);
});

test('turning the list off in the popup stops every request to sb.smeris.me', async ({ page }) => {
	const s = await setup(page, { bridge: true });
	await openMenu(page);
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(4);
	expect(s.hits()).toBe(1);

	const popup = await openPopup(page);
	await expect(popup.locator('#remote')).toBeChecked();
	await popup.locator('#remote').uncheck();
	await expect.poll(() => extStorage(popup)).toMatchObject({ remote: false });

	// The open chat picks it up without a reload: list gone, cache deleted.
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(0);
	await expect(page.locator('.bb-emoji-empty')).toContainText('BanterBox extension menu');
	expect(await page.evaluate(() => localStorage.getItem('banterbox.emojis.v1'))).toBeNull();
	await expect(page.locator('.bb-emoji-foot a')).toHaveCount(0);

	// After a reload nothing is fetched from sb.smeris.me, not even on hover or open.
	const before = s.smeris();
	await page.reload();
	await injectAll(page);
	await page.locator('.bb-emoji-btn').hover();
	await openMenu(page);
	await page.waitForTimeout(500);
	expect(s.smeris()).toBe(before);
	expect(s.hits()).toBe(1);

	// And back on.
	await popup.locator('#remote').check();
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(4);
});

test('own emojis added in the popup show up and insert in the chat', async ({ page }) => {
	await setup(page, { bridge: true });
	const popup = await openPopup(page);
	await addOwn(popup, ':Pepe_Hands:', 'https://img.example/pepe.png');
	await expect(popup.locator('#own li')).toHaveCount(1);
	await expect(popup.locator('#own li')).toContainText(':pepe_hands:');
	await expect(popup.locator('#count')).toHaveText('(1/200)');
	await expect.poll(() => extStorage(popup)).toMatchObject({
		custom: [{ name: 'pepe_hands', url: 'https://img.example/pepe.png', w: 64, h: 48 }],
	});

	await openMenu(page);
	await expect(page.locator('.bb-emoji-heading').first()).toHaveText('My emojis');
	await page.locator('.bb-emoji-tile[title=":pepe_hands:"]').click();
	const img = page.locator('.fr-element img');
	await expect(img).toHaveAttribute('src', 'https://img.example/pepe.png');
	expect(await img.getAttribute('style')).toContain('width: 43px'); // 64x48 shown 32 px high

	await popup.locator('.remove').click();
	await expect(popup.locator('#own li')).toHaveCount(0);
	await openMenu(page);
	await expect(page.locator('.bb-emoji-tile[title=":pepe_hands:"]')).toHaveCount(0);
});

test('own emojis work with the list off', async ({ page }) => {
	const s = await setup(page, { bridge: true });
	const popup = await openPopup(page);
	await popup.locator('#remote').uncheck();
	await addOwn(popup, 'cat', 'https://img.example/cat.png');
	await expect(popup.locator('#own li')).toHaveCount(1);
	await page.reload();
	await injectAll(page);
	await openMenu(page);
	await expect(page.locator('.bb-emoji-tile')).toHaveCount(1);
	await page.keyboard.type('cat');
	await page.keyboard.press('Enter');
	await expect(page.locator('.fr-element img')).toHaveAttribute('src', 'https://img.example/cat.png');
	expect(s.hits()).toBe(0);
});

test('the popup refuses unsafe or broken links', async ({ page }) => {
	await setup(page, { bridge: true });
	const popup = await openPopup(page);
	// Skip the browser's own form checks, as a determined user could.
	await popup.evaluate(() => { document.getElementById('add').noValidate = true; });
	const err = popup.locator('#error');
	const cases = [
		['ok_name', 'http://img.example/a.png', 'https://'],
		['ok_name', 'javascript:alert(1)', 'https://'],
		['ok_name', 'data:image/png;base64,AAAA', 'https://'],
		['ok_name', 'https://user:pass@img.example/a.png', 'https://'],
		['ok_name', 'https://img.example/a[IMG].png', 'https://'],
		['ok_name', 'https://img.example/missing.png', "didn't load"],
		['<b>x</b>', 'https://img.example/a.png', 'Names use'],
		['x', 'https://img.example/a.png', 'Names use'],
	];
	for (const [n, u, msg] of cases) {
		await addOwn(popup, n, u);
		await expect(err, u).toContainText(msg);
	}
	await expect(popup.locator('#own li')).toHaveCount(0);

	// Quotes and spaces end up percent-encoded, so they can't break out of anything.
	await addOwn(popup, 'quoted', 'https://img.example/a.png" onerror="alert(1)');
	await expect(popup.locator('#own li')).toHaveCount(1);
	expect((await extStorage(popup)).custom[0].url).toBe('https://img.example/a.png%22%20onerror=%22alert(1)');

	await addOwn(popup, 'quoted', 'https://img.example/b.png');
	await expect(err).toContainText('already have');
});

test('perpheads can read the settings but not change them', async ({ page }) => {
	await setup(page, { bridge: true });
	const popup = await openPopup(page);
	await addOwn(popup, 'mine', 'https://img.example/mine.png');
	await expect(popup.locator('#own li')).toHaveCount(1);
	const before = await extStorage(popup);

	// A hostile page script trying the old save event, and faking a settings answer.
	await page.evaluate(() => {
		document.dispatchEvent(new CustomEvent('banterbox:save', { detail: JSON.stringify({ remote: false, custom: [] }) }));
		document.dispatchEvent(new CustomEvent('banterbox:settings', { detail: JSON.stringify({
			remote: true,
			custom: [
				{ name: 'evil', url: 'javascript:alert(1)', w: 1, h: 1 },
				{ name: '<svg onload=alert(1)>', url: 'https://img.example/a.png', w: 1, h: 1 },
			],
		}) }));
	});
	await page.waitForTimeout(300);
	expect(await extStorage(popup)).toEqual(before); // storage untouched
	// The faked answer was validated: nothing from it shows up.
	await openMenu(page);
	await expect(page.locator('.bb-emoji-tile[title=":evil:"]')).toHaveCount(0);
	expect(await page.content()).not.toContain('javascript:alert');
});

test('screenshot of the popup (SHOTS=1 only)', async ({ page }) => {
	test.skip(!process.env.SHOTS, 'set SHOTS=1 to save screenshots');
	await setup(page, { bridge: true });
	const popup = await openPopup(page);
	await addOwn(popup, 'pepe_hands', 'https://img.example/pepe.png');
	await expect(popup.locator('#own li')).toHaveCount(1);
	await popup.screenshot({ path: path.join(here, '..', 'screenshots', 'popup.png'), fullPage: true });
});

test('a saved edit is shown right away, without running scripts', async ({ page }) => {
	await setup(page);
	const result = await page.evaluate(() => {
		document.querySelector('.siropuChatMessages').insertAdjacentHTML('beforeend',
			'<li class="siropuChatMessageRow" data-id="5"><div class="siropuChatMessageText">old</div></li>');
		XF.activate = () => {};
		XF.flashMessage = () => {};
		const form = document.createElement('form');
		form.setAttribute('action', '/chat/message/5/edit');
		const save = (data) => XF.SiropuChatMessageSave.onResponse.call({ target: form }, { data, preventDefault() {} });
		save({ status: 'ok', message_id: 5, edited: '<div class="bbWrapper">new <b>text</b>'
			+ '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>'
			+ '<a href=" java	script:window.pwned=3">x</a><svg><animate onbegin="window.pwned=4"/></svg>'
			+ '<iframe srcdoc="<script>parent.pwned=5</script>"></iframe><a href="https://ok.example/">link</a></div>' });
		const after = document.querySelector('li[data-id="5"] .siropuChatMessageText').innerHTML;
		// A message id that isn't a number is ignored, not pasted into a selector.
		save({ status: 'ok', message_id: '5"], body, [x="', edited: '<b>hijack</b>' });
		return { after, again: document.querySelector('li[data-id="5"] .siropuChatMessageText').innerHTML, body: document.body.textContent.includes('hijack') };
	});
	expect(result.after).toContain('new <b>text</b>');
	expect(result.after).toContain('<a href="https://ok.example/">link</a>'); // normal links stay
	expect(result.after).not.toMatch(/onerror|<script|javascript|<svg|srcdoc|<iframe/i);
	await page.waitForTimeout(200);
	expect(await page.evaluate(() => window.pwned)).toBeUndefined();
	expect(result.again).toBe(result.after);
	expect(result.body).toBe(false);
});

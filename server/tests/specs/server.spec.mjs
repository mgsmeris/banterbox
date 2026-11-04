// End-to-end and attack tests for the emoji server, run against real PHP (php-wasm)
// in a real browser (Edge). One ordered story: setup -> uploads -> accounts -> abuse.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { totp, fixtures, PHP_PAYLOAD } from '../helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, '..', '.data', '8091', 'app');
const SETUP_TOKEN = 'test-setup-token-0123456789abcdef0123456789';
const SUPER = { user: 'smeris', pass: 'correct horse battery staple' };
const ALICE = { user: 'alice', pass: 'alice has a long password' };

test.describe.configure({ mode: 'serial' });

let browser;
let superCtx, superPage;
let superSecret, aliceSecret, aliceInviteUrl;

test.beforeAll(async ({ browser: b }) => {
	browser = b;
	superCtx = await browser.newContext({ baseURL: 'http://localhost:8091' });
	superPage = await superCtx.newPage();
});

const flashes = (page) => page.locator('.flash').allInnerTexts();
const csrfOf = (page) => page.locator('input[name=csrf]').first().inputValue();
const storedFiles = () => fs.readdirSync(path.join(DATA, 'emojis'));

async function upload(page, files, name = '') {
	await page.goto('/sb/admin/');
	await page.locator('[data-files]').setInputFiles(files.map(([n, buf, mime]) => ({ name: n, mimeType: mime || 'image/png', buffer: buf })));
	if (name) {
		const input = page.locator('[data-name-input]');
		// Skip the browser's own validation, as an attacker would.
		await input.evaluate((el) => { el.removeAttribute('pattern'); el.removeAttribute('maxlength'); });
		await input.fill(name);
	}
	await page.getByRole('button', { name: 'Upload' }).click();
	await page.waitForURL('**/sb/admin/');
	return flashes(page);
}

// -------------------------------------------------------------- public

test('homepage renders with strict security headers', async ({ page }) => {
	const res = await page.goto('/sb/');
	expect(res.status()).toBe(200);
	const h = res.headers();
	expect(h['content-security-policy']).toContain("default-src 'none'");
	expect(h['content-security-policy']).toContain("script-src 'self'");
	expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
	expect(h['x-content-type-options']).toBe('nosniff');
	expect(h['x-frame-options']).toBe('DENY');
	expect(h['strict-transport-security']).toContain('max-age=');
	expect(h['x-powered-by']).toBeUndefined();
	await expect(page.locator('h1')).toHaveText('BanterBox');
});

test('code, config and data are not reachable', async ({ request }) => {
	for (const p of ['/sb/config.php', '/sb/config.example.php', '/sb/src/App.php', '/sb/src/bootstrap.php',
		'/sb/data/banterbox.sqlite', '/sb/tests/.data/8091/app/banterbox.sqlite', '/sb/.htaccess',
		'/sb/assets/../../config.php', '/sb/admin/../../src/Db.php', '/sb/e/../../config.php']) {
		const r = await request.get(p, { maxRedirects: 0 });
		expect(r.status(), p).toBe(404);
	}
});

test('e.php rejects path tricks', async ({ request }) => {
	for (const q of ['id=../../config&ext=php', 'id=00000000000000000000000000000000&ext=php',
		'id[]=x&ext=png', 'id=%2e%2e%2fconfig&ext=png', 'id=00000000000000000000000000000000/../x&ext=png']) {
		const r = await request.get('/sb/e.php?' + q);
		expect(r.status(), q).toBe(404);
	}
});

// --------------------------------------------------------------- setup

test('setup rejects a wrong token, then creates the superuser via invite', async () => {
	const page = superPage;
	await page.goto('/sb/admin/?a=setup');
	await page.fill('input[name=token]', 'wrong-token-wrong-token-wrong-token');
	await page.fill('input[name=username]', SUPER.user);
	await page.getByRole('button', { name: 'Continue' }).click();
	expect(await flashes(page)).toContain('That setup token is wrong.');

	await page.fill('input[name=token]', SETUP_TOKEN);
	await page.fill('input[name=username]', SUPER.user);
	await page.getByRole('button', { name: 'Continue' }).click();
	await page.waitForURL(/\?a=invite$/);
	await expect(page.locator('h1')).toContainText('Activate your account');
	// QR code rendered by the vendored library (no inline script allowed).
	await expect(page.locator('.qr img')).toHaveAttribute('src', /^data:image\/gif;base64,/);
	superSecret = (await page.locator('code.secret').innerText()).replace(/\s/g, '');
	expect(superSecret).toMatch(/^[A-Z2-7]{32}$/);

	// Wrong code first.
	await page.fill('input[name=password]', SUPER.pass);
	await page.fill('input[name=confirm]', SUPER.pass);
	await page.fill('input[name=code]', '000000');
	await page.getByRole('button', { name: 'Activate account' }).click();
	expect((await flashes(page)).join()).toContain('authenticator code is wrong');

	// Weak password.
	await page.fill('input[name=password]', 'short');
	await page.fill('input[name=confirm]', 'short');
	await page.fill('input[name=code]', totp(superSecret));
	await page.evaluate(() => document.querySelectorAll('input').forEach((i) => i.removeAttribute('minlength')));
	await page.getByRole('button', { name: 'Activate account' }).click();
	expect((await flashes(page)).join()).toContain('at least 12 characters');

	await page.fill('input[name=password]', SUPER.pass);
	await page.fill('input[name=confirm]', SUPER.pass);
	await page.fill('input[name=code]', totp(superSecret));
	await page.getByRole('button', { name: 'Activate account' }).click();
	await page.waitForURL('**/sb/admin/');
	expect((await flashes(page)).join()).toContain('Welcome, smeris');
	await expect(page.locator('nav')).toContainText('Accounts');
});

test('setup is closed once a superuser exists', async ({ request }) => {
	expect((await request.get('/sb/admin/?a=setup')).status()).toBe(404);
});

test('session cookie is locked down', async () => {
	const cookies = await superCtx.cookies();
	const c = cookies.find((x) => x.name === '__Host-bbsess');
	expect(c).toBeTruthy();
	expect(c.httpOnly).toBe(true);
	expect(c.secure).toBe(true);
	expect(c.sameSite).toBe('Strict');
	expect(c.path).toBe('/');
});

// -------------------------------------------------------------- uploads

test('good images are accepted and re-encoded', async () => {
	const f = await upload(superPage, [['Kappa Pride.png', fixtures.small()]]);
	expect(f.join()).toContain('Added :kappa_pride:');

	const f2 = await upload(superPage, [
		['wide.png', fixtures.big()],
		['dance.gif', fixtures.animated(), 'image/gif'],
		['still.gif', fixtures.staticGif(), 'image/gif'],
	]);
	expect(f2.join()).toContain('Added :wide:');
	expect(f2.join()).toContain('Added :dance:');
	expect(f2.join()).toContain('Added :still:');

	const json = await (await superPage.request.get('/sb/emojis.json')).json();
	const by = Object.fromEntries(json.emojis.map((e) => [e.name, e]));
	// Every emoji is stored as exactly 32x32, whatever went in (400x200, 32x32, 16x16).
	for (const e of json.emojis) {
		expect([e.name, e.w, e.h]).toEqual([e.name, 32, 32]);
		const bytes = await (await superPage.request.get(new URL(e.url).pathname)).body();
		const real = e.url.endsWith('.png')
			? [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]   // PNG IHDR
			: [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];    // GIF logical screen
		expect([e.name, ...real]).toEqual([e.name, 32, 32]);
	}
	expect(by.dance.animated).toBe(true);  // kept animated by Imagick
	expect(by.dance.url).toMatch(/\.gif$/);
	expect(by.still.animated).toBe(false); // single-frame GIF becomes PNG
	expect(by.still.url).toMatch(/\.png$/);
	for (const e of json.emojis) {
		expect(e.url).toMatch(/^http:\/\/localhost:8091\/sb\/e\/[a-f0-9]{32}\.(png|gif|webp)$/);
	}
});

test('animated GIF keeps all its frames', async () => {
	const json = await (await superPage.request.get('/sb/emojis.json')).json();
	const dance = json.emojis.find((e) => e.name === 'dance');
	const bytes = await (await superPage.request.get(new URL(dance.url).pathname)).body();
	expect(bytes.subarray(0, 6).toString()).toBe('GIF89a');
	const frames = bytes.toString('latin1').split('\x21\xf9\x04').length - 1;
	expect(frames).toBe(3);
});

test('dangerous or broken files are rejected and never stored', async () => {
	const before = storedFiles().length;
	const cases = [
		['shell.png', fixtures.phpAsPng(), 'Only PNG, JPEG, GIF and WebP'],
		['shell.php', fixtures.phpAsPng(), 'Only PNG, JPEG, GIF and WebP'],
		['x.svg', fixtures.svg(), 'Only PNG, JPEG, GIF and WebP'],
		['page.png', fixtures.html(), 'Only PNG, JPEG, GIF and WebP'],
		['fake.png', fixtures.fakePng(), ''],
		['huge.png', fixtures.tooBig(), 'larger than 1024'],
		['bomb.png', fixtures.bomb(), 'larger than 1024'],
	];
	const f = (await upload(superPage, cases.map(([n, b]) => [n, b]))).join('\n');
	for (const [n, , msg] of cases) {
		expect(f, n).toContain(n + ':');
		if (msg) expect(f, n).toContain(msg);
	}
	expect(f).not.toContain('Added');
	expect(storedFiles().length).toBe(before);
});

test('polyglot images are cleaned: no PHP or HTML survives', async () => {
	const f = await upload(superPage, [['poly.png', fixtures.polyglot()], ['chunk.png', fixtures.chunkPayload()]]);
	expect(f.join()).toContain('Added :poly:');
	expect(f.join()).toContain('Added :chunk:');
	for (const file of storedFiles()) {
		expect(file).toMatch(/^[a-f0-9]{32}\.(png|gif|webp)$/);
		const bytes = fs.readFileSync(path.join(DATA, 'emojis', file)).toString('latin1');
		expect(bytes, file).not.toContain('<?php');
		expect(bytes, file).not.toContain('<script');
		expect(bytes, file).not.toContain(PHP_PAYLOAD);
	}
});

test('emoji files are served as inert images', async () => {
	const json = await (await superPage.request.get('/sb/emojis.json')).json();
	const r = await superPage.request.get(new URL(json.emojis[0].url).pathname);
	const h = r.headers();
	expect(h['content-type']).toMatch(/^image\/(png|gif|webp)$/);
	expect(h['x-content-type-options']).toBe('nosniff');
	expect(h['content-security-policy']).toContain('sandbox');
	expect(h['cross-origin-resource-policy']).toBe('cross-origin');
	expect(h['cache-control']).toContain('immutable');
});

test('names are sanitised and escaped', async () => {
	const f = await upload(superPage, [['x.png', fixtures.big().subarray(0)]], '"><img src=x onerror=alert(1)>');
	// The big fixture is already uploaded, so this is a duplicate image...
	expect(f.join()).toContain('already uploaded');
	// ...use a fresh image instead.
	const { png } = await import('../helpers.mjs');
	const f2 = await upload(superPage, [['x.png', png(10, 10, { seed: 42 })]], '"><img src=x onerror=alert(1)>');
	expect(f2.join()).toMatch(/Added :[a-z0-9_]+:/);
	await expect(superPage.locator('img[src="x"]')).toHaveCount(0);
	const json = await (await superPage.request.get('/sb/emojis.json')).json();
	for (const e of json.emojis) expect(e.name).toMatch(/^[a-z0-9_]{2,32}$/);

	const dup = await upload(superPage, [['y.png', png(11, 11, { seed: 43 })]], 'kappa_pride');
	expect(dup.join()).toContain('already exists');
});

test('emojis.json only allows perpheads in CORS', async ({ request }) => {
	const ok = await request.get('/sb/emojis.json', { headers: { Origin: 'https://perpheads.com' } });
	expect(ok.headers()['access-control-allow-origin']).toBe('https://perpheads.com');
	const evil = await request.get('/sb/emojis.json', { headers: { Origin: 'https://evil.example' } });
	expect(evil.headers()['access-control-allow-origin']).toBeUndefined();
	expect(evil.headers()['content-type']).toContain('application/json');
});

// ----------------------------------------------------------------- CSRF

test('state changes need a CSRF token and same-origin request', async () => {
	await superPage.goto('/sb/admin/');
	const token = await csrfOf(superPage);
	const id = await superPage.locator('.admin-list input[name=id]').first().inputValue();
	const req = superPage.request;

	let r = await req.post('/sb/admin/?a=delete', { form: { id } });
	expect(r.status()).toBe(403);
	r = await req.post('/sb/admin/?a=delete', { form: { id, csrf: 'nope' } });
	expect(r.status()).toBe(403);
	r = await req.post('/sb/admin/?a=delete', { form: { id, csrf: token }, headers: { Origin: 'https://evil.example' } });
	expect(r.status()).toBe(403);
	r = await req.post('/sb/admin/?a=delete', { form: { id, csrf: token }, headers: { 'Sec-Fetch-Site': 'cross-site' } });
	expect(r.status()).toBe(403);
	// GET can't change anything.
	r = await req.get('/sb/admin/?a=delete&id=' + id);
	expect(r.status()).toBe(405);

	const count = (await (await req.get('/sb/emojis.json')).json()).emojis.length;
	expect(count).toBeGreaterThan(0);
	expect(storedFiles().length).toBe(count);
});

test('unknown actions and logged-out access are refused', async ({ request }) => {
	expect((await request.get('/sb/admin/?a=../../config')).status()).toBe(404);
	expect((await request.get('/sb/admin/?a[]=x')).status()).toBe(404);
	const r = await request.get('/sb/admin/?a=accounts', { maxRedirects: 0 });
	expect(r.status()).toBe(303); // to the login page
});

// ------------------------------------------------------------- accounts

test('superuser invites an admin who activates their own account', async () => {
	await superPage.goto('/sb/admin/?a=accounts');
	await superPage.fill('input[name=username]', ALICE.user);
	await superPage.getByRole('button', { name: 'Create invite' }).click();
	aliceInviteUrl = await superPage.locator('[data-copy-src]').inputValue();
	expect(aliceInviteUrl).toMatch(/\/sb\/admin\/\?a=invite&t=[a-f0-9]{64}$/);
	await expect(superPage.locator('.account-list')).toContainText('Invite pending');

	// The link is shown once only.
	await superPage.reload();
	await expect(superPage.locator('[data-copy-src]')).toHaveCount(0);

	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto(aliceInviteUrl);
	// Token moved out of the address bar.
	expect(page.url()).not.toContain('&t=');
	aliceSecret = (await page.locator('code.secret').innerText()).replace(/\s/g, '');
	await page.fill('input[name=password]', ALICE.pass);
	await page.fill('input[name=confirm]', ALICE.pass);
	await page.fill('input[name=code]', totp(aliceSecret));
	await page.getByRole('button', { name: 'Activate account' }).click();
	await page.waitForURL('**/sb/admin/');
	await expect(page.locator('nav')).not.toContainText('Accounts');

	// Normal admins can't manage accounts, even with a valid token.
	expect((await page.request.get('/sb/admin/?a=accounts')).status()).toBe(403);
	const token = await csrfOf(page);
	expect((await page.request.post('/sb/admin/?a=account_create', { form: { csrf: token, username: 'mallory' } })).status()).toBe(403);
	expect((await page.request.get('/sb/admin/?a=system')).status()).toBe(403);
	await ctx.close();
});

test('an invite link works only once', async () => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto(aliceInviteUrl);
	await expect(page.locator('h1')).toContainText('not valid');
	await ctx.close();
});

test('superuser cannot be edited from the web', async () => {
	await superPage.goto('/sb/admin/?a=accounts');
	const token = await csrfOf(superPage);
	for (const a of ['account_delete', 'account_disable', 'account_reset']) {
		await superPage.request.post('/sb/admin/?a=' + a, { form: { csrf: token, id: '1' } });
	}
	await superPage.goto('/sb/admin/?a=accounts');
	await expect(superPage.locator('.account-list li').first()).toContainText('Active');
});

test('TOTP codes cannot be replayed', async () => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/sb/admin/');
	// Alice's current-step code was used to activate her account.
	await page.fill('input[name=username]', ALICE.user);
	await page.fill('input[name=password]', ALICE.pass);
	await page.fill('input[name=code]', totp(aliceSecret, 0));
	await page.getByRole('button', { name: 'Log in' }).click();
	expect((await flashes(page)).join()).toContain('Login failed');
	await ctx.close();
});

test('disabling an admin ends their session', async () => {
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	await page.goto('/sb/admin/');
	await page.fill('input[name=username]', ALICE.user);
	await page.fill('input[name=password]', ALICE.pass);
	await page.fill('input[name=code]', totp(aliceSecret, 1)); // next step: not used yet
	await page.getByRole('button', { name: 'Log in' }).click();
	await expect(page.locator('.admin-bar')).toBeVisible();

	await superPage.goto('/sb/admin/?a=accounts');
	await superPage.locator('.account-list li', { hasText: 'alice' }).getByRole('button', { name: 'Disable' }).click();
	await expect(superPage.locator('.account-list li', { hasText: 'alice' })).toContainText('Disabled');

	await page.goto('/sb/admin/');
	await expect(page.locator('button', { hasText: 'Log in' })).toBeVisible();
	await ctx.close();
});

test('repeated failed logins lock the account even with the right password', async () => {
	await superPage.goto('/sb/admin/?a=accounts');
	await superPage.locator('.account-list li', { hasText: 'alice' }).getByRole('button', { name: 'Enable' }).click();

	const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Test-IP': '203.0.113.7' } });
	const page = await ctx.newPage();
	const tryLogin = async (pass, code) => {
		await page.goto('/sb/admin/');
		await page.fill('input[name=username]', ALICE.user);
		await page.fill('input[name=password]', pass);
		await page.fill('input[name=code]', code);
		await page.getByRole('button', { name: 'Log in' }).click();
	};
	for (let i = 0; i < 5; i++) await tryLogin('wrong password ' + i, '123456');
	// Right password and a fresh code, but the account is locked for now.
	await tryLogin(ALICE.pass, totp(aliceSecret, -1));
	expect((await flashes(page)).join()).toContain('Login failed');
	await expect(page.locator('.admin-bar')).toHaveCount(0);
	await ctx.close();
});

test('changing the password signs out other sessions', async () => {
	const other = await browser.newContext();
	const otherPage = await other.newPage();
	await other.addCookies(await superCtx.cookies());
	await otherPage.goto('/sb/admin/');
	await expect(otherPage.locator('.admin-bar')).toBeVisible();

	await superPage.goto('/sb/admin/?a=password');
	await superPage.fill('input[name=current]', SUPER.pass);
	await superPage.fill('input[name=new]', SUPER.pass + ' v2');
	await superPage.fill('input[name=confirm]', SUPER.pass + ' v2');
	await superPage.getByRole('button', { name: 'Change password' }).click();
	expect((await flashes(superPage)).join()).toContain('Password changed');

	await otherPage.goto('/sb/admin/');
	await expect(otherPage.locator('button', { hasText: 'Log in' })).toBeVisible();
	await superPage.goto('/sb/admin/');
	await expect(superPage.locator('.admin-bar')).toBeVisible();
	await other.close();
});

test('system page reports the server state', async () => {
	await superPage.goto('/sb/admin/?a=system');
	await expect(superPage.locator('.checks')).toContainText('Extension gd');
	await expect(superPage.locator('.checks')).toContainText('Extension imagick');
	await expect(superPage.locator('.check-fail')).toHaveCount(0); // setup_token still set is only a warning
});

test('the audit log records what happened', async () => {
	await superPage.goto('/sb/admin/?a=audit');
	const text = await superPage.locator('.audit').innerText();
	for (const a of ['superuser_created', 'invite_accepted', 'upload', 'account_created', 'account_disabled', 'login_failed', 'password_changed']) {
		expect(text).toContain(a);
	}
});

test('screenshots (SHOTS=1 only)', async () => {
	test.skip(!process.env.SHOTS, 'set SHOTS=1 to save screenshots');
	const dir = path.join(here, '..', 'screenshots');
	await superPage.setViewportSize({ width: 1200, height: 800 });
	await superPage.goto('/sb/');
	await superPage.screenshot({ path: path.join(dir, 'homepage.png'), fullPage: true });
	await superPage.goto('/sb/admin/');
	await superPage.screenshot({ path: path.join(dir, 'admin-emojis.png'), fullPage: true });
	await superPage.goto('/sb/admin/?a=accounts');
	await superPage.screenshot({ path: path.join(dir, 'admin-accounts.png'), fullPage: true });
	const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
	const p = await ctx.newPage();
	await p.goto('/sb/admin/');
	await p.screenshot({ path: path.join(dir, 'admin-login.png') });
	await ctx.close();
});

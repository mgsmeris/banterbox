// Checks a deployed BanterBox server from the outside, mainly the Apache/.htaccess
// rules that the local php-wasm tests can't cover. Read-only: it never logs in,
// uploads or changes anything.
//
//   node deploy-check.mjs                       (checks https://sb.smeris.me)
//   node deploy-check.mjs https://example.com/sb

const base = (process.argv[2] || 'https://sb.smeris.me').replace(/\/$/, '');
let failed = 0;

const get = (p, opts = {}) => fetch(base + p, { redirect: 'manual', ...opts });
function check(ok, label, detail = '') {
	if (!ok) failed++;
	console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  (' + detail + ')' : ''}`);
}

const home = await get('/');
check(home.status === 200, 'homepage loads', String(home.status));
const h = home.headers;
check((h.get('content-security-policy') || '').includes("default-src 'none'"), 'strict Content-Security-Policy');
check(h.get('x-content-type-options') === 'nosniff', 'X-Content-Type-Options: nosniff');
check(h.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');
check((h.get('strict-transport-security') || '').includes('max-age'), 'HSTS header');
check(!h.get('x-powered-by'), 'no X-Powered-By header', h.get('x-powered-by') || '');

if (base.startsWith('https://')) {
	const http = await fetch(base.replace('https://', 'http://') + '/admin/', { redirect: 'manual' }).catch(() => null);
	check(!http || http.status !== 200 || !(await http.text()).includes('csrf'), 'admin is not usable over plain http');
}

// Nothing but the entry points may answer, and no source code may leak.
const secret = ['/bb-root.php', '/config.php', '/../config.php', '/src/App.php', '/../src/App.php',
	'/data/banterbox.sqlite', '/../data/banterbox.sqlite', '/.htaccess', '/admin/.htaccess',
	'/assets/', '/e/', '/admin/nope.php', '/index.php.bak', '/tests/dev-server.mjs'];
for (const p of secret) {
	const r = await get(p);
	const body = await r.text();
	const leak = body.includes('<?php') || body.includes('SQLite format') || body.includes('Require all');
	check([301, 302, 403, 404].includes(r.status) && !leak, 'blocked: ' + p, String(r.status) + (leak ? ' LEAKS CONTENT' : ''));
}

const json = await get('/emojis.json', { headers: { Origin: 'https://perpheads.com' } });
check(json.status === 200 && (json.headers.get('content-type') || '').includes('application/json'), '/emojis.json works (mod_rewrite on)', String(json.status));
check(json.headers.get('access-control-allow-origin') === 'https://perpheads.com', 'CORS allows perpheads.com');
const evil = await get('/emojis.json', { headers: { Origin: 'https://evil.example' } });
check(!evil.headers.get('access-control-allow-origin'), 'CORS refuses other sites');

let list = [];
try { list = (await json.json()).emojis || []; } catch { /* reported above */ }
if (list.length) {
	const img = await fetch(list[0].url);
	check(img.status === 200 && /^image\//.test(img.headers.get('content-type') || ''), 'emoji image served as an image', list[0].url);
	check((img.headers.get('content-security-policy') || '').includes('sandbox'), 'emoji image has CSP sandbox');
} else {
	console.log('     (no emojis uploaded yet, image checks skipped)');
}

const setup = await get('/admin/?a=setup');
check(setup.status === 404, 'setup page closed', setup.status === 200 ? 'still open: clear setup_token in config.php' : String(setup.status));

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exit(failed ? 1 : 0);

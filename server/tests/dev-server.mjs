// Local test server: runs the real PHP code in PHP 8.3 compiled to WebAssembly
// (php-wasm, with GD, Imagick and SQLite), no PHP install needed.
//
//   npm run dev            -> http://localhost:8090/sb/
//
// It copies the routing rules from public/.htaccess, so anything .htaccess would
// refuse (src/, data/, config.php, unknown .php files) returns 404 here as well.
// The server pretends to be HTTPS so cookies and checks behave like production.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime, createNodeFsMountHandler } from '@php-wasm/node';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const PORT = Number(process.env.PORT || 8090);
const DATA = path.join(here, '.data', String(PORT)); // one data dir per port

// Test config, kept out of the real config.php.
fs.mkdirSync(DATA, { recursive: true });
const configFile = path.join(DATA, 'config.php');
const setupToken = process.env.SETUP_TOKEN || 'test-setup-token-0123456789abcdef0123456789';
fs.writeFileSync(configFile, `<?php
return [
	'base_url' => 'http://localhost:${PORT}/sb',
	'data_dir' => '/srv/tests/.data/${PORT}/app',
	'https_only' => true,
	'setup_token' => ${JSON.stringify(setupToken)},
	'allow_superuser_reset' => ${process.env.ALLOW_RESET === '1' ? 'true' : 'false'},
];
`);

// PHP_VERSION=8.3 npm test to try another version. Default matches sb.smeris.me (8.5).
const PHP_VERSION = process.env.PHP_VERSION || '8.5';
const php = new PHP(await loadNodeRuntime(PHP_VERSION, { emscriptenOptions: { processId: 1 } }));
php.mkdir('/srv');
await php.mount('/srv', createNodeFsMountHandler(serverRoot));

const STATIC = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', png: 'image/png' };

/** Maps a URL path to [script, extra query] like public/.htaccess does, or null for 404. */
function route(p) {
	if (p === '/sb') return { redirect: '/sb/' };
	if (p === '/sb/admin') return { redirect: '/sb/admin/' };
	if (p === '/sb/' || p === '/sb/index.php') return { script: 'index.php' };
	if (p === '/sb/admin/' || p === '/sb/admin/index.php') return { script: 'admin/index.php' };
	if (p === '/sb/emojis.json') return { script: 'emojis.php' };
	// Apache also serves these two directly (the .htaccess allows them by name).
	if (p === '/sb/e.php' || p === '/sb/emojis.php') return { script: p.slice(4) };
	let m = p.match(/^\/sb\/e\/([a-f0-9]{32})\.(png|gif|webp)$/);
	if (m) return { script: 'e.php', query: `id=${m[1]}&ext=${m[2]}` };
	m = p.match(/^\/sb\/(assets\/(?:vendor\/)?[a-z0-9.-]+\.(css|js|png))$/);
	if (m && !m[1].includes('..')) return { file: m[1], type: STATIC[m[2]] };
	return null;
}

// php-wasm runs one request at a time; queue them.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const r = route(url.pathname);
	if (!r) {
		res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found\n');
		return;
	}
	if (r.redirect) {
		res.writeHead(301, { location: r.redirect }).end();
		return;
	}
	if (r.file) {
		const file = path.join(serverRoot, 'public', r.file);
		if (!fs.existsSync(file)) return res.writeHead(404).end();
		res.writeHead(200, { 'content-type': r.type, 'x-content-type-options': 'nosniff' });
		return res.end(fs.readFileSync(file));
	}

	const chunks = [];
	for await (const c of req) chunks.push(c);
	const body = Buffer.concat(chunks);

	const query = [r.query, url.search.slice(1)].filter(Boolean).join('&');
	const headers = { ...req.headers };
	delete headers['content-length'];

	try {
		const out = await serial(() => php.run({
			scriptPath: `/srv/public/${r.script}`,
			relativeUri: url.pathname + (query ? `?${query}` : ''),
			method: req.method,
			headers,
			body: body.length ? new Uint8Array(body) : undefined,
			env: { BANTERBOX_CONFIG: `/srv/tests/.data/${PORT}/config.php` },
			$_SERVER: {
				HTTPS: 'on',
				DOCUMENT_ROOT: '/srv/public',
				SCRIPT_NAME: `/sb/${r.script}`,
				REMOTE_ADDR: req.headers['x-test-ip'] || '127.0.0.1',
				QUERY_STRING: query,
			},
		}));
		const h = {};
		for (const [k, v] of Object.entries(out.headers)) h[k] = v.length === 1 ? v[0] : v;
		res.writeHead(out.httpStatusCode, h);
		res.end(Buffer.from(out.bytes));
		if (out.errors) console.error(out.errors);
	} catch (e) {
		console.error(e);
		res.writeHead(500, { 'content-type': 'text/plain' }).end('dev-server error\n');
	}
});

server.listen(PORT, 'localhost', () => {
	console.log(`BanterBox dev server (PHP ${PHP_VERSION}): http://localhost:${PORT}/sb/  (admin: /sb/admin/)`);
});

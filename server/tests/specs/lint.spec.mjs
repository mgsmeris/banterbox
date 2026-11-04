// Syntax-checks every PHP file with the same PHP version as the server (php -l),
// so a broken file fails here instead of on sb.smeris.me.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime, createNodeFsMountHandler } from '@php-wasm/node';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const files = [];
(function walk(dir) {
	for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
		if (f.name === 'tests' || f.name === 'data' || f.name === 'node_modules') continue;
		const p = path.join(dir, f.name);
		if (f.isDirectory()) walk(p);
		else if (f.name.endsWith('.php')) files.push(path.relative(root, p).split(path.sep).join('/'));
	}
})(root);

test('every PHP file parses', async () => {
	const php = new PHP(await loadNodeRuntime(process.env.PHP_VERSION || '8.5', { emscriptenOptions: { processId: 2 } }));
	php.mkdir('/srv');
	await php.mount('/srv', createNodeFsMountHandler(root));
	const code = `<?php foreach (${JSON.stringify(files)} as $f) { try { token_get_all(file_get_contents('/srv/' . $f), TOKEN_PARSE); } catch (ParseError $e) { echo $f, ':', $e->getLine(), ': ', $e->getMessage(), "\n"; } }`;
	const r = await php.run({ code });
	expect(files.length).toBeGreaterThan(10);
	expect(r.text.trim(), r.text).toBe('');
});

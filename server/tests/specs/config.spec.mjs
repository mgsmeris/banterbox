// Where the server finds config.php. Deploys from git must never be able to
// replace or remove the settings, so banterbox-private/ (outside the code) wins.
import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHP } from '@php-wasm/universal';
import { loadNodeRuntime, createNodeFsMountHandler } from '@php-wasm/node';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function phpWithLayout() {
	const php = new PHP(await loadNodeRuntime(process.env.PHP_VERSION || '8.5', { emscriptenOptions: { processId: 3 } }));
	// /www/site/code = the deployed code (a read-only mount of server/src here).
	php.mkdir('/www/site/code/src');
	await php.mount('/www/site/code/src', createNodeFsMountHandler(path.join(server, 'src')));
	return php;
}

const locate = (php) => php.run({ code: `<?php
	require '/www/site/code/src/App.php';
	$m = new ReflectionMethod(BanterBox\\App::class, 'locateConfig');
	echo $m->invoke(null, '/www/site/code') ?? 'NONE';` }).then((r) => r.text.trim());

test('banterbox-private next to the code is used before a config.php in the code', async () => {
	const php = await phpWithLayout();
	php.writeFile('/www/site/code/config.php', '<?php return [];');
	expect(await locate(php)).toBe('/www/site/code/config.php');

	php.mkdir('/www/site/banterbox-private');
	php.writeFile('/www/site/banterbox-private/config.php', '<?php return [];');
	expect(await locate(php)).toBe('/www/site/banterbox-private/config.php');
});

test('banterbox-private one level higher is found too', async () => {
	const php = await phpWithLayout();
	php.mkdir('/www/banterbox-private');
	php.writeFile('/www/banterbox-private/config.php', '<?php return [];');
	expect(await locate(php)).toBe('/www/banterbox-private/config.php');
});

test('the search stops after two levels', async () => {
	const php = await phpWithLayout();
	php.mkdir('/banterbox-private');
	php.writeFile('/banterbox-private/config.php', '<?php return [];');
	expect(await locate(php)).toBe('NONE');
});

test('data defaults to sitting next to the config that was used', async () => {
	const php = await phpWithLayout();
	php.mkdir('/www/site/banterbox-private');
	php.writeFile('/www/site/banterbox-private/config.php', "<?php return ['base_url' => 'https://sb.example.test'];");
	php.mkdir('/www/site/code/public');
	const r = await php.run({ code: `<?php
		define('BANTERBOX_PUBLIC', '/www/site/code/public');
		require '/www/site/code/src/bootstrap.php';
		echo BanterBox\\App::dataDir(), '|', BanterBox\\App::insideCode(BanterBox\\App::dataDir()) ? 'inside' : 'outside';` });
	expect(r.text.trim()).toBe('/www/site/banterbox-private/data|outside');
});

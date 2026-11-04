// BanterBox popup: privacy setting and the user's own emojis.
'use strict';

const S = globalThis.BanterBoxSettings;
const $ = (id) => document.getElementById(id);

/** Loads an image to check the link works and to get its size. Sends no referrer. */
function probeImage(url, timeout = 8000) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.referrerPolicy = 'no-referrer';
		const timer = setTimeout(() => { img.src = ''; reject(new Error('timeout')); }, timeout);
		img.onload = () => {
			clearTimeout(timer);
			if (img.naturalWidth && img.naturalHeight) resolve({ w: img.naturalWidth, h: img.naturalHeight });
			else reject(new Error('empty image'));
		};
		img.onerror = () => {
			clearTimeout(timer);
			reject(new Error('not an image'));
		};
		img.src = url;
	});
}

let settings = S.sanitize(null);

function render() {
	$('remote').checked = settings.remote;
	$('count').textContent = '(' + settings.custom.length + '/' + S.MAX_CUSTOM + ')';
	const list = $('own');
	list.replaceChildren();
	for (const e of settings.custom) {
		const img = document.createElement('img');
		img.src = e.url;
		img.alt = '';
		img.loading = 'lazy';
		img.referrerPolicy = 'no-referrer';
		const name = document.createElement('span');
		name.textContent = ':' + e.name + ':';
		const remove = document.createElement('button');
		remove.type = 'button';
		remove.className = 'remove';
		remove.title = 'Remove :' + e.name + ':';
		remove.setAttribute('aria-label', 'Remove ' + e.name);
		remove.textContent = '×';
		remove.addEventListener('click', async () => {
			settings = await S.write({ ...settings, custom: settings.custom.filter((c) => c.name !== e.name) });
			render();
		});
		const li = document.createElement('li');
		li.append(img, name, remove);
		list.append(li);
	}
}

$('remote').addEventListener('change', async () => {
	settings = await S.write({ ...settings, remote: $('remote').checked });
	render();
});

$('add').addEventListener('submit', async (ev) => {
	ev.preventDefault();
	const error = $('error');
	const btn = $('addBtn');
	error.textContent = '';

	const name = $('name').value.trim().toLowerCase().replace(/^:+|:+$/g, '');
	let url = $('url').value.trim();
	try { url = new URL(url).href; } catch (e) { /* checked below */ }

	if (!S.NAME_RE.test(name)) return void (error.textContent = 'Names use a-z, 0-9 and _, 2 to 32 characters.');
	if (settings.custom.some((c) => c.name === name)) return void (error.textContent = 'You already have :' + name + ':.');
	if (settings.custom.length >= S.MAX_CUSTOM) return void (error.textContent = 'You can keep up to ' + S.MAX_CUSTOM + ' emojis.');
	if (!S.safeUrl(url)) return void (error.textContent = 'Use a plain https:// image link.');

	btn.disabled = true;
	btn.textContent = 'Checking…';
	try {
		const size = await probeImage(url);
		settings = await S.write({ ...settings, custom: [...settings.custom, { name, url, ...size }] });
		$('name').value = '';
		$('url').value = '';
		render();
	} catch (e) {
		error.textContent = 'That link didn\'t load as an image.';
	} finally {
		btn.disabled = false;
		btn.textContent = 'Add';
	}
});

S.onChange((next) => {
	settings = next;
	render();
});

S.read().then((s) => {
	settings = s;
	render();
});

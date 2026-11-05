// Small progressive enhancements for the admin pages. Everything works without it.
// Loaded as an external file because the CSP forbids inline script.
'use strict';

document.addEventListener('DOMContentLoaded', () => {
	// Ask before deleting.
	document.querySelectorAll('form[data-confirm]').forEach((form) => {
		form.addEventListener('submit', (e) => {
			if (!window.confirm(form.dataset.confirm)) e.preventDefault();
		});
	});

	// QR code for authenticator setup (qrcode.js is a vendored MIT library, loaded only on that page).
	const qrBox = document.querySelector('[data-qr]');
	if (qrBox && typeof window.qrcode === 'function') {
		const qr = window.qrcode(0, 'M');
		qr.addData(qrBox.dataset.qr);
		qr.make();
		const img = document.createElement('img');
		img.src = qr.createDataURL(5, 2);
		img.alt = 'QR code for your authenticator app';
		qrBox.append(img);
	}

	// Copy the invite link.
	const copyBtn = document.querySelector('[data-copy]');
	const copySrc = document.querySelector('[data-copy-src]');
	if (copyBtn && copySrc) {
		copySrc.addEventListener('focus', () => copySrc.select());
		copyBtn.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(copySrc.value);
				copyBtn.textContent = 'Copied';
			} catch (err) {
				copySrc.select();
			}
		});
	}

	// Filter the emoji list.
	const filter = document.querySelector('[data-filter]');
	const list = document.querySelector('[data-list]');
	if (filter && list) {
		filter.addEventListener('input', () => {
			const q = filter.value.trim().toLowerCase().replace(/:/g, '');
			list.querySelectorAll('li').forEach((li) => {
				li.hidden = q !== '' && !li.dataset.name.includes(q);
			});
		});
	}

	// Drop zone: show chosen files and suggest a name for a single upload.
	const drop = document.querySelector('[data-drop]');
	const input = document.querySelector('[data-files]');
	const label = document.querySelector('[data-drop-label]');
	const name = document.querySelector('[data-name-input]');
	if (drop && input && label) {
		const update = () => {
			const files = [...input.files];
			label.textContent = files.length === 0
				? 'Drop images here or click to choose'
				: files.length === 1 ? files[0].name : files.length + ' images selected';
			if (name) {
				name.disabled = files.length > 1;
				if (files.length === 1 && name.value === '') {
					name.value = files[0].name.replace(/\.[^.]+$/, '').toLowerCase()
						.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
				}
			}
		};
		// WebM videos are turned into animated GIFs here, before uploading.
		const convert = async () => {
			const W = window.BanterBoxWebm;
			const files = [...input.files];
			if (!W || !files.some(W.isWebm)) return update();
			const form = input.form;
			const submit = form && form.querySelector('[type="submit"]');
			if (submit) submit.disabled = true;
			const out = new DataTransfer();
			const failed = [];
			for (const f of files) {
				if (!W.isWebm(f)) { out.items.add(f); continue; }
				label.textContent = 'Converting ' + f.name + ' to GIF…';
				try {
					out.items.add(await W.toGif(f));
				} catch (err) {
					failed.push(f.name + ': ' + err.message);
				}
			}
			input.files = out.files;
			if (submit) submit.disabled = false;
			update();
			if (failed.length) label.textContent = failed.join(' · ');
		};
		input.addEventListener('change', convert);
		['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, () => drop.classList.add('is-over')));
		['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));
	}
});

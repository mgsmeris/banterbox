// WebM to animated GIF, in the browser, for the admin upload form.
//
// The browser decodes the video and this file encodes the frames as a GIF. The
// result is uploaded like any other GIF, so the server's normal checks and its
// re-encoding to 32x32 apply unchanged. Nothing here reaches the server except
// that GIF.
'use strict';

window.BanterBoxWebm = (() => {
	const MAX_FRAMES = 150;   // same limit as the server (Images::MAX_FRAMES)
	const MAX_BYTES = 512 * 1024;
	const FPS = 20;
	const SIDES = [64, 48, 32]; // try smaller if the GIF comes out too big

	const isWebm = (file) => file.type === 'video/webm' || /\.webm$/i.test(file.name);

	function once(el, ok) {
		return new Promise((resolve, reject) => {
			const done = () => { el.removeEventListener(ok, done); el.removeEventListener('error', fail); resolve(); };
			const fail = () => { el.removeEventListener(ok, done); el.removeEventListener('error', fail); reject(new Error('The video could not be read.')); };
			el.addEventListener(ok, done);
			el.addEventListener('error', fail);
		});
	}

	async function seek(video, t) {
		const p = once(video, 'seeked');
		video.currentTime = t;
		await p;
	}

	/** Decodes the video into RGBA frames that fit side x side. */
	async function readFrames(file, side) {
		const url = URL.createObjectURL(file);
		const video = document.createElement('video');
		video.muted = true;
		video.playsInline = true;
		video.preload = 'auto';
		try {
			const meta = once(video, 'loadeddata');
			video.src = url;
			await meta;
			// WebM files from some tools don't store their length; seeking far ahead makes
			// the browser work it out.
			if (!Number.isFinite(video.duration)) {
				await seek(video, 1e9);
				await seek(video, 0);
			}
			const duration = video.duration;
			if (!Number.isFinite(duration) || duration <= 0 || !video.videoWidth) {
				throw new Error('The video has no frames.');
			}
			const fps = Math.min(FPS, MAX_FRAMES / duration);
			const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(duration * fps)));
			const delay = Math.max(2, Math.round(100 / fps)); // GIF delays are in 1/100 s

			const scale = Math.min(side / video.videoWidth, side / video.videoHeight);
			const w = Math.max(1, Math.round(video.videoWidth * scale));
			const h = Math.max(1, Math.round(video.videoHeight * scale));
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d', { willReadFrequently: true });

			const frames = [];
			for (let i = 0; i < count; i++) {
				await seek(video, Math.min(duration - 0.001, i / fps));
				ctx.clearRect(0, 0, w, h);
				ctx.drawImage(video, 0, 0, w, h);
				frames.push(ctx.getImageData(0, 0, w, h).data);
			}
			return { w, h, delay, frames };
		} finally {
			video.removeAttribute('src');
			video.load();
			URL.revokeObjectURL(url);
		}
	}

	/** Up to 255 colours (index 0 = transparent), picked by how often they occur. */
	function palette(frames) {
		const counts = new Map();
		for (const f of frames) {
			for (let i = 0; i < f.length; i += 4) {
				if (f[i + 3] < 128) continue;
				const key = ((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3);
				counts.set(key, (counts.get(key) || 0) + 1);
			}
		}
		const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([k]) => k);
		const colors = top.map((k) => [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4]);
		const cache = new Map();
		const index = (key) => {
			let hit = cache.get(key);
			if (hit !== undefined) return hit;
			const r = ((key >> 10) & 31) << 3 | 4, g = ((key >> 5) & 31) << 3 | 4, b = (key & 31) << 3 | 4;
			let best = 1, bestD = Infinity;
			for (let i = 0; i < colors.length; i++) {
				const c = colors[i];
				const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
				if (d < bestD) { bestD = d; best = i + 1; }
			}
			cache.set(key, best);
			return best;
		};
		return { colors, index };
	}

	/** GIF LZW, as in the GIF89a spec. */
	function lzw(pixels, minSize) {
		const out = [];
		const clear = 1 << minSize, eoi = clear + 1;
		let size = minSize + 1, next = eoi + 1, acc = 0, bits = 0;
		let dict = new Map();
		const emit = (code) => {
			acc |= code << bits;
			bits += size;
			while (bits >= 8) { out.push(acc & 255); acc >>>= 8; bits -= 8; }
			if (next > (1 << size) - 1 && size < 12) size++;
		};
		emit(clear);
		let prefix = pixels[0];
		for (let i = 1; i < pixels.length; i++) {
			const k = pixels[i];
			const key = prefix * 256 + k;
			const hit = dict.get(key);
			if (hit !== undefined) { prefix = hit; continue; }
			emit(prefix);
			if (next < 4096) {
				dict.set(key, next++);
			} else {
				next = eoi + 1;
				emit(clear);
				dict = new Map();
				size = minSize + 1;
			}
			prefix = k;
		}
		emit(prefix);
		emit(eoi);
		if (bits > 0) out.push(acc & 255);
		return out;
	}

	function encode({ w, h, delay, frames }) {
		const { colors, index } = palette(frames);
		const bytes = [];
		const push = (...b) => { for (const x of b) bytes.push(x); };
		const u16 = (n) => push(n & 255, (n >> 8) & 255);
		const ascii = (s) => push(...[...s].map((c) => c.charCodeAt(0)));

		ascii('GIF89a');
		u16(w); u16(h);
		push(0xF7, 0, 0); // global colour table of 256 entries
		for (let i = 0; i < 256; i++) {
			const c = i > 0 && colors[i - 1] ? colors[i - 1] : [0, 0, 0];
			push(c[0], c[1], c[2]);
		}
		push(0x21, 0xFF, 11); ascii('NETSCAPE2.0'); push(3, 1, 0, 0, 0); // loop forever

		const px = new Uint8Array(w * h);
		for (const f of frames) {
			for (let i = 0, p = 0; p < px.length; i += 4, p++) {
				px[p] = f[i + 3] < 128 ? 0
					: index(((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3));
			}
			// Graphic control: restore to background (so transparency works), delay, transparent index 0.
			push(0x21, 0xF9, 4, 0x09); u16(delay); push(0, 0);
			push(0x2C); u16(0); u16(0); u16(w); u16(h); push(0);
			push(8);
			const data = lzw(px, 8);
			for (let i = 0; i < data.length; i += 255) {
				const chunk = data.slice(i, i + 255);
				push(chunk.length, ...chunk);
			}
			push(0);
		}
		push(0x3B);
		return new Uint8Array(bytes);
	}

	/** Returns a GIF File made from a WebM File. */
	async function toGif(file) {
		let gif = null;
		for (const side of SIDES) {
			gif = encode(await readFrames(file, side));
			if (gif.length <= MAX_BYTES) break;
		}
		if (gif.length > MAX_BYTES) throw new Error('The GIF made from this video is too large. Try a shorter clip.');
		return new File([gif], file.name.replace(/\.webm$/i, '') + '.gif', { type: 'image/gif' });
	}

	return { isWebm, toGif };
})();

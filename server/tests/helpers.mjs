// Test helpers: TOTP codes and image fixtures, built in plain Node (no image libraries).
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// ------------------------------------------------------------------ TOTP

function base32Decode(s) {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const c of s.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
	const out = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(out);
}

/** 6-digit code for `secret`, `offset` 30-second steps from now. */
export function totp(secret, offset = 0) {
	const step = Math.floor(Date.now() / 1000 / 30) + offset;
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(step));
	const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
	const o = h[19] & 0x0f;
	const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
	return String(n % 1e6).padStart(6, '0');
}

// ---------------------------------------------------------------- images

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(zlib.crc32(td));
	return Buffer.concat([len, td, crc]);
}

/** RGBA PNG of the given size, a coloured gradient so re-encoding has real pixels. */
export function png(w, h, { seed = 0 } = {}) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
	const raw = Buffer.alloc((w * 4 + 1) * h);
	for (let y = 0; y < h; y++) {
		const row = y * (w * 4 + 1);
		for (let x = 0; x < w; x++) {
			const i = row + 1 + x * 4;
			raw[i] = (x * 7 + seed) & 255; raw[i + 1] = (y * 5 + seed * 3) & 255; raw[i + 2] = (seed * 11) & 255; raw[i + 3] = 255;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** A PNG header claiming huge dimensions, with almost no data: a decompression bomb. */
export function pngBomb() {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(50000, 0);
	ihdr.writeUInt32BE(50000, 4);
	ihdr[8] = 8; ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(Buffer.alloc(1000))),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

/** Uncompressed-LZW GIF image data for a w×h frame filled with colour index `c` (0 or 1). */
function gifFrame(w, h, c) {
	// Minimum code size 2 -> clear=4, end=5. Emit a clear code before every pixel so the
	// code size stays at 3 bits. Simple and valid, if not compact.
	const codes = [];
	for (let i = 0; i < w * h; i++) codes.push(4, c);
	codes.push(5);
	const bytes = [];
	let acc = 0, n = 0;
	for (const code of codes) {
		acc |= code << n; n += 3;
		while (n >= 8) { bytes.push(acc & 255); acc >>= 8; n -= 8; }
	}
	if (n > 0) bytes.push(acc & 255);
	const sub = [];
	for (let i = 0; i < bytes.length; i += 255) {
		const part = bytes.slice(i, i + 255);
		sub.push(part.length, ...part);
	}
	return [0x02, ...sub, 0x00];
}

/** GIF with `frames` frames (frames > 1 = animated). */
export function gif(w, h, frames = 2) {
	const out = [...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xf0, 0, 0,
		255, 0, 0, 0, 0, 255]; // global colour table: red, blue
	if (frames > 1) {
		out.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00);
	}
	for (let f = 0; f < frames; f++) {
		out.push(0x21, 0xf9, 0x04, 0x04, 10, 0, 0, 0x00); // graphic control: 0.1 s
		out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0x00);
		out.push(...gifFrame(w, h, f % 2));
	}
	out.push(0x3b);
	return Buffer.from(out);
}

export const PHP_PAYLOAD = '<?php system($_GET["c"]); ?>';
export const HTML_PAYLOAD = '<script>alert(document.domain)</script>';

export const fixtures = {
	small: () => png(32, 32),
	big: () => png(400, 200, { seed: 3 }),
	tooBig: () => png(1500, 20),
	bomb: pngBomb,
	animated: () => gif(16, 16, 3),
	staticGif: () => gif(16, 16, 1),
	// A valid PNG with PHP and HTML appended: the classic "polyglot" upload.
	polyglot: () => Buffer.concat([png(24, 24, { seed: 9 }), Buffer.from(PHP_PAYLOAD + HTML_PAYLOAD)]),
	// Same, with the payload hidden in a text chunk inside the PNG.
	chunkPayload: () => {
		const p = png(20, 20, { seed: 5 });
		const iend = p.subarray(p.length - 12);
		return Buffer.concat([p.subarray(0, p.length - 12), chunk('tEXt', Buffer.from('Comment\0' + PHP_PAYLOAD)), iend]);
	},
	phpAsPng: () => Buffer.from(PHP_PAYLOAD),
	svg: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>'),
	html: () => Buffer.from('<!DOCTYPE html><html>' + HTML_PAYLOAD + '</html>'),
	// PNG magic bytes followed by garbage.
	fakePng: () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not really a png' + PHP_PAYLOAD)]),
};

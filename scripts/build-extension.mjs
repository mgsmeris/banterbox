// Builds the browser packages from extension/:
//
//   node scripts/build-extension.mjs
//     -> dist/banterbox-chrome.zip    (Chrome, Edge, Brave: Web Store upload or unzip + Load unpacked)
//     -> dist/banterbox-firefox.xpi   (Firefox: AMO signing upload)
//
// Each package gets a manifest tuned for its browser. Plain Node (22+), no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'extension');
const out = path.join(root, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
const version = manifest.version;

// ------------------------------------------------------------------ files

function listFiles(dir, base = dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.name.startsWith('.')) return [];
		return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
	}).sort();
}
const files = listFiles(src).filter((f) => f !== 'manifest.json');

// Every file the manifest points at must exist.
const referenced = [
	...Object.values(manifest.icons || {}),
	...Object.values(manifest.action?.default_icon || {}),
	manifest.action?.default_popup,
	...(manifest.content_scripts || []).flatMap((c) => c.js || []),
	...(manifest.background?.scripts || []),
	manifest.background?.service_worker,
].filter(Boolean);
for (const f of referenced) {
	if (!files.includes(f)) throw new Error(`manifest.json refers to a missing file: ${f}`);
}

// --------------------------------------------------------------- manifests

function chromeManifest() {
	const m = structuredClone(manifest);
	delete m.browser_specific_settings; // Chrome only warns about it
	delete m.background.scripts; // Chrome uses the service worker
	return m;
}

function firefoxManifest() {
	const m = structuredClone(manifest);
	delete m.background.service_worker; // Firefox runs background scripts instead
	m.browser_specific_settings = {
		gecko: {
			...(manifest.browser_specific_settings?.gecko || {}),
			// Self-hosted (unlisted) add-on: Firefox checks this file for new versions.
			// CI writes it to server/public/update.json after signing each new version.
			update_url: 'https://sb.smeris.me/update.json',
			// Required by addons.mozilla.org for new add-ons: BanterBox collects nothing.
			data_collection_permissions: { required: ['none'] },
		},
	};
	return m;
}

// --------------------------------------------------------------------- zip

function zip(entries) {
	const local = [];
	const central = [];
	let offset = 0;
	// Fixed timestamp (1 Jan 2024) so builds are reproducible.
	const time = 0, date = ((2024 - 1980) << 9) | (1 << 5) | 1;
	for (const { name, data } of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const deflated = zlib.deflateRawSync(data, { level: 9 });
		const useDeflate = deflated.length < data.length;
		const body = useDeflate ? deflated : data;
		const crc = zlib.crc32(data);
		const head = Buffer.alloc(30);
		head.writeUInt32LE(0x04034b50, 0);
		head.writeUInt16LE(20, 4);
		head.writeUInt16LE(0x0800, 6); // UTF-8 names
		head.writeUInt16LE(useDeflate ? 8 : 0, 8);
		head.writeUInt16LE(time, 10);
		head.writeUInt16LE(date, 12);
		head.writeUInt32LE(crc, 14);
		head.writeUInt32LE(body.length, 18);
		head.writeUInt32LE(data.length, 22);
		head.writeUInt16LE(nameBuf.length, 26);
		local.push(head, nameBuf, body);

		const dir = Buffer.alloc(46);
		dir.writeUInt32LE(0x02014b50, 0);
		dir.writeUInt16LE(20, 4);
		dir.writeUInt16LE(20, 6);
		dir.writeUInt16LE(0x0800, 8);
		dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
		dir.writeUInt16LE(time, 12);
		dir.writeUInt16LE(date, 14);
		dir.writeUInt32LE(crc, 16);
		dir.writeUInt32LE(body.length, 20);
		dir.writeUInt32LE(data.length, 24);
		dir.writeUInt16LE(nameBuf.length, 28);
		dir.writeUInt32LE(offset, 42);
		central.push(dir, nameBuf);
		offset += head.length + nameBuf.length + body.length;
	}
	const centralBuf = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, centralBuf, end]);
}

function build(target, m, ext) {
	const entries = [
		{ name: 'manifest.json', data: Buffer.from(JSON.stringify(m, null, 2) + '\n') },
		...files.map((f) => ({ name: f, data: fs.readFileSync(path.join(src, f)) })),
	];
	// Same name every version, so https://github.com/…/releases/latest/download/<name> always works.
	const file = path.join(out, `banterbox-${target}.${ext}`);
	fs.writeFileSync(file, zip(entries));
	console.log(`${path.relative(root, file)}  v${version} (${entries.length} files, ${(fs.statSync(file).size / 1024).toFixed(1)} KB)`);
	return file;
}

fs.mkdirSync(out, { recursive: true });
build('chrome', chromeManifest(), 'zip');
build('firefox', firefoxManifest(), 'xpi');

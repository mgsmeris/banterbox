/*
 * BanterBox
 * Patches two bugs in the Siropu Chat add-on used as the perpheads.com shoutbox.
 *
 * 1. Edit button does nothing.
 *    The edit link is a normal XenForo overlay link, but the server answers with
 *    {"message_html": "<form…>"} instead of the standard {"html": {"content": …}},
 *    so XenForo's overlay handler silently ignores it. The form also asks for an
 *    element handler "siropu-chat-message-save" that no longer exists in the
 *    add-on's JS. We intercept the click, build the overlay ourselves, and
 *    provide the missing handler.
 *
 * 2. "Load more messages" ends up above the loaded messages.
 *    In inverse mode (newest on top) the add-on appends older messages after the
 *    button's <li>, so the button drifts upward. We keep the button at the
 *    "old" end of the list (bottom in inverse mode, top in normal mode).
 *
 * 3. Emoji menu: a Kappa button in the chat toolbar opens a menu of custom
 *    emojis hosted on sb.smeris.me plus the user's own emojis, inserted as
 *    [IMG] so everyone sees them. The sb.smeris.me list can be switched off.
 *
 * Runs in the page's MAIN world so it can use the page's XF object.
 */
(() => {
	'use strict';

	const TAG = '[BanterBox]';
	const EDIT_HREF_RE = /chat\/message\/(\d+)\/edit(?:[?#&]|$)/;

	// ---------------------------------------------------------------- helpers

	function getCore(chat) {
		try {
			return window.XF.Element.getHandler(chat, 'siropu-chat') || null;
		} catch (e) {
			return null;
		}
	}

	/**
	 * Removes everything that could run code from parsed HTML: script-like
	 * elements, event handler attributes and javascript:/data: links. Message
	 * markup (text, formatting, images, links, embeds) stays.
	 */
	function defuse(root) {
		root.querySelectorAll('script, style, link, meta, base, object, embed, applet, form, frame, frameset, template, noscript, svg, math')
			.forEach((el) => el.remove());
		for (const el of root.querySelectorAll('*')) {
			for (const { name, value } of [...el.attributes]) {
				const n = name.toLowerCase();
				const v = value.replace(/[\s\u0000-\u001f]+/g, '').toLowerCase();
				if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction'
					|| (/^(href|src|action|xlink:href|data|poster|background)$/.test(n) && /^(javascript|vbscript|data):/.test(v) && !/^data:image\/(png|gif|jpeg|webp);/.test(v))) {
					el.removeAttribute(name);
				}
			}
			if (el.tagName === 'IFRAME' && !/^https:\/\//i.test(el.getAttribute('src') || '')) el.remove();
		}
	}

	// ------------------------------------------------------------ edit fix

	function installEditFix(XF, chat) {
		const overlayForForm = new WeakMap();
		let busy = false;

		// Provide the missing element handler for the edit form.
		if (!XF.SiropuChatMessageSave) {
			XF.SiropuChatMessageSave = XF.Element.newHandler({
				options: {},

				init() {
					const form = this.target;
					XF.on(form, 'ajax-submit:response', this.onResponse.bind(this));

					// Enter saves (Shift+Enter = newline), like the main chat box.
					const textarea = form.querySelector('textarea[name="message_html"]');
					if (textarea) {
						XF.on(textarea, 'editor:init', (e) => {
							const ed = e.ed;
							if (!ed || !ed.events) return;
							ed.events.on('keydown', (ev) => {
								if (ev.keyCode === 13 && !ev.shiftKey) {
									ev.preventDefault();
									XF.trigger(form, 'submit');
									return false;
								}
							}, true);
							setTimeout(() => {
								try { XF.EditorHelpers.focus(ed); } catch (err) { /* ignore */ }
							}, 100);
						});
					}
				},

				onResponse(e) {
					const data = e.data || {};
					// Let XenForo show errors (e.g. "time limit to edit has expired").
					if (data.errors || data.exception || data.status === 'error') {
						return;
					}
					e.preventDefault(); // stop any redirect / page reload

					const form = this.target;
					const overlay = overlayForForm.get(form);
					if (overlay && typeof overlay.hide === 'function') {
						overlay.hide();
					}

					// The save response looks like:
					//   { status: "ok", message: "Message has been edited.", message_id, room_id,
					//     edited: "<div class=\"bbWrapper\">…</div>", html: { content: "" } }
					// so the rendered message is in `edited`. Show it right away rather than
					// waiting for the chat's next poll.
					const match = (form.getAttribute('action') || '').match(EDIT_HREF_RE);
					const id = data.message_id || (match && match[1]);
					const newHtml = data.edited
						|| data.message_html
						|| (data.html && data.html.content);
					if (/^\d+$/.test(String(id)) && typeof newHtml === 'string' && newHtml.trim()) {
						const text = chat.querySelector('li[data-id="' + id + '"] .siropuChatMessageText');
						if (text) {
							// The message as perpheads rendered it. Parsed in an inert document,
							// with anything active removed before it goes into the page.
							const doc = new DOMParser().parseFromString(newHtml, 'text/html');
							const from = doc.querySelector('.siropuChatMessageText') || doc.body;
							defuse(from);
							text.replaceChildren(...from.childNodes);
							XF.activate(text);
						}
					}

					if (data.message) {
						XF.flashMessage(data.message, 1500);
					}

					// Pull the edit through the chat's normal update cycle as well.
					const core = getCore(chat);
					if (core && typeof core.refresh === 'function') {
						setTimeout(() => core.refresh(), 300);
					}
				}
			});
			XF.Element.register('siropu-chat-message-save', 'XF.SiropuChatMessageSave');
		}

		// Intercept clicks on the edit link before XenForo's (broken) overlay handler.
		window.addEventListener('click', (e) => {
			if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) {
				return; // let middle/ctrl-click open in a new tab as before
			}
			const link = e.target.closest && e.target.closest('a[href]');
			if (!link || !chat.contains(link)) return;
			const href = link.getAttribute('href');
			if (!EDIT_HREF_RE.test(href)) return;

			e.preventDefault();
			e.stopImmediatePropagation();
			if (busy) return;
			busy = true;

			XF.ajax('GET', href, {}, (data) => {
				let html = null;
				if (data.html && data.html.content) {
					html = data.html; // in case the add-on is ever fixed upstream
				} else if (data.message_html) {
					html = { content: data.message_html };
				}
				if (!html) return;

				XF.setupHtmlInsert(html, (content, container) => {
					const title = (container && (container.title || container.h1))
						|| link.getAttribute('title') || 'Edit';
					const overlayEl = XF.getOverlayHtml({ html: content, title: title });
					const overlay = XF.showOverlay(overlayEl);
					const form = overlayEl.querySelector('form');
					if (form) overlayForForm.set(form, overlay);
				});
			}).finally(() => {
				busy = false;
			});
		}, true);
	}

	// ---------------------------------------------------------- emoji menu
	//
	// A Kappa button in the chat editor's toolbar opens a menu of custom emojis
	// listed at EMOJI_SOURCE/emojis.json. Picking one inserts it as an image, which
	// XenForo saves as [IMG]…[/IMG], so everyone sees it without the extension.
	//
	// The list comes from another server, so it is treated as untrusted: every
	// entry must match strict patterns, and the menu is built with DOM methods
	// only (never innerHTML), so a compromised server still can't inject script
	// or markup into perpheads.

	const EMOJI_SOURCE = 'https://sb.smeris.me/';
	const EMOJI_CACHE_KEY = 'banterbox.emojis.v1';
	const EMOJI_RECENT_KEY = 'banterbox.recent.v2';
	const EMOJI_CACHE_TTL = 10 * 60 * 1000;
	const EMOJI_MAX = 2000;
	const CUSTOM_MAX = 200;
	const EMOJI_INSERT_HEIGHT = 32; // px, roughly a line of chat text
	const NAME_RE = /^[a-z0-9_]{2,32}$/;
	const COLOR_RE = /^#[0-9a-f]{6}$/;
	const PAINT_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAD00lEQVR4AaxXPU8bQRB9IGEwIH9BZUuRkWlApMMSooIUlFAhqkiJBCkpKIiEC0xhRCj4AaYKHaKM0yAk25EgSCQKBSINiWmoEFggg7FTOPvW3tPZvvOdMda9m53Z2Zl3u3uz53aY/GLrsdJLwiQNTAlwwNLSEl4CjCVQEqi7GhJQ3ouLi9ja2gKls8upzE1JMZv0ryNhi0ChUEBkJYLt+DaDPAvj4+MwImGLwM7nnaqk19fXIKqMFsrY2BiMSNgikEwlZfjJN5NSFotFKZu9kcTIyEjVTNgiwEQXfy4oNDRDgsvHvUPMTM/I5awEKkkCYm24OYiKvV7s7u4in8/XdxhYmIhQXSRvBPa3MzmnhYqAIYmjoyPc3d3h+PuxcAH49IRUam4qsYgL1Q4EAlVj9GPbxfS0nZ2dqXVhOI3E1dUVdRTFG7DxaROrUgMeHh4qrWrBV5VPSquIS6FhYGBAtpmc4ylpkEsgnNuo5J/yiogkkc1mkclk2GUJJp+bm8PBwQGWPy5L//Pf51XjSYLJe3p6tIeQBOhNEgyiliOy8o9mzVEquhsDKXVjw4m+vj7E43EkEglsitk6+XEix+r9IH6Mr7dpBEQfd2fbzPQvIMrJXkV49CvNDcHkq8L95uYGe3t7SHxJgMnVICZUbSX1tioCZYdoG8SFaBQQq65I/MSC0MtXLpcDoZKn00mxySLI/M1A1Qx66hNRN4IBAboJBuJSJNYQRe0vlZoEn5zJ2V4TLklRsHp7e6WrneR0NCEAsRk7AJLAGvgLI0AhkRLJJyaSaDU5g5kSYGdsvUMSUdKxHhN6DA5HDKwNBNvc9ff39+DutvvkjE8YEhBFpDQ1NaV9C8zPz4OvGA8TJvD7X8Hj8XC8LFB8XVliubvtvrZysLgZEhB2w0utr2FnxUgSLGwV1VLYItDZ2WkZ6LkODQns7++DSKfTssjwPT88PBTr/w2np6e4vLyURaeVDxVDAqyKTOz3+8EznHJ2dhZDQ68lgsEgggJerxcLH8r1QV98mpkNQwK1AZiIhcfnc8kun9cnpdmNG9Wsr9ZuScDlcqG/vx+hUAhs2yVRm8hMtySgBvL45FtAEv6AX5rdbreUrdwsCfCLmOjuLshCw4LTSsLasZYE+AoSj4+d8njlDKggVntB+TWSlgTUYIfDUTUDXc7yoaP6nystCXD6GZx7gFI/A9RbhSUBTr9KwjKr2k/5nGq2JBsS4Ommj05dbUIuwW32Vt+ttXkWWEE5mxJgNRweGpaf1h63B4OhQVDnqUe8f/eWn3Da/8XwaFh8wtWjkZ0k/gMAAP//ShpCKgAAAAZJREFUAwA20fQ3JwQSogAAAABJRU5ErkJggg==';
	const KAPPA_ICON = 'data:image/png;base64,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';

	const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

	/**
	 * A user-supplied image link we're willing to store and post: https only, no
	 * login details, already in normalised form, and no characters that could break
	 * out of an [IMG] tag or an HTML attribute.
	 */
	function safeImageUrl(s) {
		if (typeof s !== 'string' || s.length > 500) return false;
		let u;
		try { u = new URL(s); } catch (e) { return false; }
		return u.protocol === 'https:' && !u.username && !u.password && u.href === s
			&& !/[\s"'<>[\]\\]/.test(s);
	}

	function sanitizeSettings(raw) {
		const s = raw && typeof raw === 'object' ? raw : {};
		const custom = [];
		const seen = new Set();
		for (const e of Array.isArray(s.custom) ? s.custom.slice(0, CUSTOM_MAX) : []) {
			if (!e || typeof e !== 'object') continue;
			const w = Number(e.w), h = Number(e.h);
			if (typeof e.name !== 'string' || !NAME_RE.test(e.name) || seen.has(e.name)) continue;
			if (!safeImageUrl(e.url)) continue;
			if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096) continue;
			seen.add(e.name);
			custom.push({ name: e.name, url: e.url, w, h });
		}
		const color = typeof s.color === 'string' && COLOR_RE.test(s.color.toLowerCase()) ? s.color.toLowerCase() : '';
		return { asked: s.asked === true, remote: s.remote !== false, updates: s.updates !== false, color, custom };
	}

	/**
	 * User settings: { asked, remote, updates, color, custom: [{name, url, w, h}] }, edited
	 * in the extension popup and handed over by storage-bridge.js. Read-only here:
	 * the consent prompt's and colour menu's buttons are handled by the bridge. If the bridge
	 * doesn't answer (e.g. the script was injected by hand), the defaults apply,
	 * and those make no requests (asked is false).
	 */
	function createSettingsStore() {
		let settings = sanitizeSettings(null);
		let ready = false;
		let resolveReady;
		const readyPromise = new Promise((r) => { resolveReady = r; });
		const listeners = new Set();

		const update = (next) => {
			settings = next;
			if (!ready) {
				ready = true;
				resolveReady();
			}
			listeners.forEach((fn) => fn(settings));
		};

		document.addEventListener('banterbox:settings', (ev) => {
			if (typeof ev.detail !== 'string') return;
			let parsed;
			try { parsed = JSON.parse(ev.detail); } catch (err) { return; }
			update(sanitizeSettings(parsed));
		});
		document.dispatchEvent(new CustomEvent('banterbox:request'));
		setTimeout(() => { if (!ready) update(settings); }, 1500);

		return {
			get: () => settings,
			ready: () => readyPromise,
			onChange: (fn) => listeners.add(fn),
		};
	}

	function installEmojiMenu(XF, chat, source) {
		const urlRe = new RegExp('^' + escapeRe(source) + 'e/[a-f0-9]{32}\\.(?:png|gif|webp)$');
		const store = createSettingsStore();
		let emojis = null;      // validated BanterBox list, or null while not loaded
		let loadFailed = false; // last load failed and there was nothing cached
		let loading = null;
		let menu = null;
		let savedFor = null;    // editor whose selection we saved
		// The sb.smeris.me list only once the user has agreed to it.
		const useRemote = () => store.get().asked && store.get().remote;

		// ------------------------------------------------------- list

		function validate(data) {
			if (!data || data.version !== 1 || !Array.isArray(data.emojis)) return null;
			const out = [];
			const seen = new Set();
			for (const e of data.emojis.slice(0, EMOJI_MAX)) {
				if (!e || typeof e !== 'object') continue;
				const { name, url } = e;
				const w = Number(e.w), h = Number(e.h);
				if (typeof name !== 'string' || !NAME_RE.test(name) || seen.has(name)) continue;
				if (typeof url !== 'string' || !urlRe.test(url)) continue;
				if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 128 || h > 128) continue;
				seen.add(name);
				out.push({ name, url, w, h });
			}
			return out;
		}

		function readCache() {
			try {
				const c = JSON.parse(localStorage.getItem(EMOJI_CACHE_KEY) || 'null');
				if (c && c.source === source && typeof c.at === 'number') {
					const list = validate(c.data);
					if (list) return { list, fresh: Date.now() - c.at < EMOJI_CACHE_TTL };
				}
			} catch (err) { /* ignore broken cache */ }
			return null;
		}

		function forgetRemote() {
			emojis = null;
			loadFailed = false;
			loading = null;
			try { localStorage.removeItem(EMOJI_CACHE_KEY); } catch (err) { /* ignore */ }
		}

		/** The BanterBox list. With the setting off this never touches the network. */
		async function load() {
			await store.ready();
			if (!useRemote()) {
				forgetRemote();
				return [];
			}
			if (loading) return loading;
			const cached = readCache();
			if (cached) {
				emojis = cached.list;
				if (cached.fresh) return (loading = Promise.resolve(emojis));
			}
			loading = fetch(source + 'emojis.json', {
				credentials: 'omit',
				referrerPolicy: 'no-referrer',
				cache: 'no-cache',
			})
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
				.then((data) => {
					const list = validate(data);
					if (!list) throw new Error('bad emoji list');
					if (!useRemote()) return []; // switched off while loading
					emojis = list;
					loadFailed = false;
					try {
						localStorage.setItem(EMOJI_CACHE_KEY, JSON.stringify({ source, at: Date.now(), data }));
					} catch (err) { /* storage full or blocked */ }
					return emojis;
				})
				.catch((err) => {
					console.warn(TAG, 'could not load emojis:', err.message);
					if (!emojis) {
						loadFailed = true;
						throw err;
					}
					return emojis; // keep using the cached list
				})
				.finally(() => {
					setTimeout(() => { loading = null; }, 1000);
				});
			return loading;
		}

		// Recently used, remembered by image URL so own and BanterBox emojis can share it.
		function recent() {
			try {
				const r = JSON.parse(localStorage.getItem(EMOJI_RECENT_KEY) || '[]');
				return Array.isArray(r) ? r.filter((u) => typeof u === 'string' && u.length <= 500).slice(0, 16) : [];
			} catch (err) {
				return [];
			}
		}

		function remember(url) {
			try {
				localStorage.setItem(EMOJI_RECENT_KEY, JSON.stringify([url, ...recent().filter((u) => u !== url)].slice(0, 16)));
			} catch (err) { /* ignore */ }
		}

		// ----------------------------------------------------- editor

		function editorFor(btn) {
			const form = btn.closest('form') || chat;
			const ta = form.querySelector('textarea.js-editor, textarea[data-xf-init~="editor"]');
			const handler = ta && XF.Element.getHandler(ta, 'editor');
			return handler && handler.ed ? { handler, ed: handler.ed, ta } : null;
		}

		function insert(e, target) {
			const h = Math.min(e.h, EMOJI_INSERT_HEIGHT);
			const w = Math.max(1, Math.round(e.w * h / e.h));
			const bbView = target.handler.isBbCodeView && target.handler.isBbCodeView();

			if (bbView) {
				// Plain BB code mode: type the tag into the textarea.
				const ta = target.ta;
				const text = '[IMG width="' + w + 'px" alt=":' + e.name + ':"]' + e.url + '[/IMG]';
				const at = ta.selectionStart ?? ta.value.length;
				ta.setRangeText(text, at, ta.selectionEnd ?? at, 'end');
				ta.dispatchEvent(new Event('input', { bubbles: true }));
				ta.focus();
			} else {
				const img = document.createElement('img');
				img.src = e.url;
				img.alt = ':' + e.name + ':';
				img.style.width = w + 'px';
				const ed = target.ed;
				if (savedFor === ed) ed.selection.restore();
				else ed.events.focus();
				// outerHTML of an element we built ourselves: all values are escaped by the DOM.
				ed.html.insert(img.outerHTML + '&nbsp;');
				ed.undo && ed.undo.saveStep && ed.undo.saveStep();
				savedFor = null;
			}
			remember(e.url);
		}

		// ------------------------------------------------------- menu

		const make = (tag, props = {}, ...children) => {
			const el = document.createElement(tag);
			for (const [k, v] of Object.entries(props)) {
				if (k === 'class') el.className = v;
				else if (k === 'text') el.textContent = v;
				else if (k.startsWith('aria-') || k === 'role') el.setAttribute(k, v);
				else if (k === 'dataset') Object.assign(el.dataset, v);
				else el[k] = v;
			}
			el.append(...children);
			return el;
		};

		function close() {
			if (!menu) return;
			menu.el.remove();
			document.removeEventListener('mousedown', menu.outside, true);
			document.removeEventListener('keydown', menu.keys, true);
			window.removeEventListener('resize', menu.place);
			menu.btn.classList.remove('fr-active');
			menu.btn.setAttribute('aria-expanded', 'false');
			menu = null;
		}

		function emojiImg(e) {
			return make('img', {
				src: e.url, alt: '', loading: 'lazy', decoding: 'async',
				referrerPolicy: 'no-referrer', width: Math.min(e.w, 128), height: Math.min(e.h, 128),
			});
		}

		function tile(e, onPick, onHover) {
			const b = make('button', { type: 'button', class: 'menu-linkRow bb-emoji-tile', title: ':' + e.name + ':', 'aria-label': e.name }, emojiImg(e));
			b.addEventListener('click', () => onPick(e));
			b.addEventListener('mouseenter', () => onHover(e));
			return b;
		}

		function open(btn) {
			const target = editorFor(btn);
			if (!target) return;

			const search = make('input', {
				type: 'search', class: 'input bb-emoji-search', placeholder: 'Search emojis',
				autocomplete: 'off', spellcheck: false, 'aria-label': 'Search emojis',
			});
			const head = make('div', { class: 'menu-row bb-emoji-head' }, search);
			const body = make('div', { class: 'bb-emoji-body' });
			const hover = make('span', { class: 'bb-emoji-hover' });
			const foot = make('div', { class: 'menu-footer bb-emoji-foot' }, hover);
			const content = make('div', { class: 'menu-content bb-emoji-content' }, head, body, foot);
			const el = make('div', { class: 'menu is-active bb-emoji-menu', role: 'dialog', 'aria-label': 'Emojis' }, content);
			document.body.append(el);

			const pick = (e) => {
				insert(e, target);
				close();
			};
			const showName = (e) => { hover.textContent = ':' + e.name + ':'; };

			const message = (text) => body.append(make('div', { class: 'menu-row u-muted bb-emoji-empty', text }));

			const section = (title, list) => {
				if (!list.length) return;
				const grid = make('div', { class: 'bb-emoji-grid' });
				for (const e of list) grid.append(tile(e, pick, showName));
				body.append(make('h4', { class: 'menu-header bb-emoji-heading', text: title }), grid);
			};

			const renderFoot = () => {
				const links = foot.querySelectorAll('a');
				links.forEach((a) => a.remove());
				if (useRemote()) {
					foot.append(make('a', { href: source, target: '_blank', rel: 'noopener noreferrer', text: 'BanterBox emojis' }));
				}
			};

			const renderEmojis = () => {
				body.replaceChildren();
				const { custom } = store.get();
				const remote = useRemote();
				if (!store.get().asked && !search.value.trim()) consent();
				const remoteList = remote ? (emojis || []) : [];
				const all = [...custom, ...remoteList];
				const q = search.value.trim().toLowerCase().replace(/:/g, '');
				if (q) {
					const hits = all.filter((e) => e.name.includes(q))
						.sort((a, b) => (a.name.startsWith(q) ? 0 : 1) - (b.name.startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name));
					hits.length ? section('Results', hits) : message('No emojis match "' + q + '".');
					return;
				}
				const byUrl = new Map(all.map((e) => [e.url, e]));
				section('Recently used', recent().map((u) => byUrl.get(u)).filter(Boolean));
				section('My emojis', custom);
				if (remote) {
					if (emojis) section('BanterBox emojis', emojis);
					else if (loadFailed) message('Could not load BanterBox emojis. Try again later.');
					else message('Loading BanterBox emojis…');
				}
				if (!all.length && store.get().asked && (!remote || emojis)) {
					message(remote ? 'No emojis yet.' : 'No emojis yet. Add your own in the BanterBox extension menu.');
				}
			};

			// Asked once, before anything is requested from sb.smeris.me. Both boxes start
			// ticked. Saving is handled by storage-bridge.js (real clicks only); the new
			// settings then come back through the store and the menu redraws.
			const consent = () => {
				const box = (name, text) => make('label', { class: 'bb-consent-opt' },
					make('input', { type: 'checkbox', checked: true, dataset: { bbConsent: name } }), ' ' + text);
				const save = make('button', { type: 'button', class: 'button button--primary bb-consent-save', text: 'Save', dataset: { bbConsent: 'save' } });
				body.append(make('div', { class: 'menu-row bb-consent' },
					make('p', { text: 'BanterBox can load its emoji list from sb.smeris.me and check GitHub for new versions. No personal data is collected. ' },
						make('a', { href: source + 'privacy', target: '_blank', rel: 'noopener noreferrer', text: 'Privacy policy' })),
					box('remote', 'Load the BanterBox emojis'),
					box('updates', 'Tell me when a new version is out'),
					save,
					make('p', { class: 'u-muted', text: 'You can change this later in the BanterBox extension menu.' })));
			};

			const render = () => {
				renderFoot();
				renderEmojis();
			};

			const place = () => {
				const r = btn.getBoundingClientRect();
				const mw = el.offsetWidth, mh = el.offsetHeight;
				const left = Math.min(r.left, window.innerWidth - mw - 8);
				let top = r.bottom + 6;
				if (top + mh > window.innerHeight - 8 && r.top - mh - 6 > 8) top = r.top - mh - 6;
				el.style.left = Math.max(8, left) + 'px';
				el.style.top = Math.max(8, top) + 'px';
			};

			const outside = (ev) => {
				if (!el.contains(ev.target) && !btn.contains(ev.target)) close();
			};
			const keys = (ev) => {
				if (ev.key === 'Escape') {
					ev.preventDefault();
					close();
					target.ed.events.focus();
				} else if (ev.key === 'Enter' && document.activeElement === search) {
					ev.preventDefault();
					const first = body.querySelector('.bb-emoji-tile');
					if (first) first.click();
				}
			};

			search.addEventListener('input', render);
			document.addEventListener('mousedown', outside, true);
			document.addEventListener('keydown', keys, true);
			window.addEventListener('resize', place);

			menu = { el, btn, outside, keys, place, rerender: () => { render(); place(); } };
			btn.classList.add('fr-active');
			btn.setAttribute('aria-expanded', 'true');

			render();
			place();
			search.focus({ preventScroll: true });

			const refresh = () => { if (menu && menu.el === el) menu.rerender(); };
			load().then(refresh, refresh);
		}

		// Settings changed in the extension popup: apply them to an open menu right away.
		store.onChange((next) => {
			const remote = next.asked && next.remote;
			if (!remote) forgetRemote();
			showColor(next.color);
			if (menu && menu.kind === 'color') { close(); return; }
			if (!menu) return;
			menu.rerender();
			if (remote) load().then(() => menu && menu.rerender(), () => menu && menu.rerender());
		});


		// ------------------------------------------------ default colour

		// The two forum styles, measured from perpheads' own CSS (Core Dark and Core).
		const STYLES = [
			{ name: 'Dark style', bg: '#262626', text: '#929292', user: '#ececec', muted: '#6e6e6e' },
			{ name: 'Light style', bg: '#ffffff', text: '#1d1d1d', user: '#1d1d1d', muted: '#8a8a8a' },
		];

		function luminance(hex) {
			const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
				.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
			return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
		}
		const contrast = (a, b) => {
			const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
			return (x + 0.05) / (y + 0.05);
		};
		const myName = () => {
			const el = document.querySelector('.p-navgroup-link--user .p-navgroup-linkText');
			return (el && el.textContent.trim()) || 'You';
		};

		// Saving and clearing are handled by storage-bridge.js (real clicks only); the
		// new colour then comes back through the store and the menu closes.
		function openColor(btn) {
			const current = store.get().color;
			const picker = make('input', { type: 'color', class: 'bb-color-picker', value: current || '#e8622c', 'aria-label': 'Pick a colour' });
			const hex = make('input', {
				type: 'text', class: 'input bb-color-hex', value: current, placeholder: '#e8622c',
				maxLength: 7, spellcheck: false, autocomplete: 'off', 'aria-label': 'Hex code', dataset: { bbColor: 'value' },
			});
			const save = make('button', { type: 'button', class: 'button button--primary', text: 'Save', dataset: { bbColor: 'save' } });
			const clear = make('button', { type: 'button', class: 'button', text: 'No colour', dataset: { bbColor: 'clear' } });
			const error = make('div', { class: 'bb-color-error', role: 'status' });

			const previews = STYLES.map((st) => {
				const label = make('div', { class: 'bb-color-style', text: st.name });
				const user = make('b', { text: myName() });
				const time = make('span', { class: 'bb-color-time', text: 'just now' });
				const msg = make('div', { class: 'bb-color-msg', text: 'This is how your messages look.' });
				const warn = make('div', { class: 'bb-color-warn' });
				const box = make('div', { class: 'bb-color-preview' }, label, make('div', {}, user, ' ', time), msg, warn);
				box.style.background = st.bg;
				label.style.color = st.muted;
				user.style.color = st.user;
				time.style.color = st.muted;
				return { st, box, msg, warn };
			});

			// Accepts "e8622c", "#E8622C" and the short "#e62".
			const normalize = (v) => {
				v = v.trim().toLowerCase();
				if (/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(v)) v = '#' + v;
				if (/^#[0-9a-f]{3}$/.test(v)) v = '#' + v.slice(1).split('').map((c) => c + c).join('');
				return v;
			};
			const render = () => {
				const v = normalize(hex.value);
				const ok = v === '' || COLOR_RE.test(v);
				error.textContent = ok ? '' : 'Use a hex code like #e8622c.';
				save.disabled = !ok;
				if (ok && v && picker.value !== v) picker.value = v;
				for (const p of previews) {
					const color = ok && v ? v : p.st.text;
					p.msg.style.color = color;
					p.warn.textContent = ok && v && contrast(color, p.st.bg) < 3 ? 'Hard to read in this style.' : '';
				}
			};
			const tidy = () => {
				const v = normalize(hex.value);
				hex.value = v;
				if (COLOR_RE.test(v)) picker.value = v;
				render();
			};
			picker.addEventListener('input', () => { hex.value = picker.value; render(); });
			hex.addEventListener('input', render);
			hex.addEventListener('change', tidy);
			// Tidy the code before the bridge reads it (mousedown comes before click).
			save.addEventListener('mousedown', tidy);

			const body = make('div', { class: 'menu-row bb-color' },
				make('div', { class: 'bb-color-pick' }, picker, hex),
				error,
				...previews.map((p) => p.box),
				make('p', { class: 'u-muted', text: 'Every message you send gets this colour. Text you colour yourself keeps its own.' }),
				make('div', { class: 'bb-color-actions' }, save, clear));
			const el = make('div', { class: 'menu is-active bb-emoji-menu bb-color-menu', role: 'dialog', 'aria-label': 'Default text colour' },
				make('div', { class: 'menu-content' }, make('h3', { class: 'menu-header', text: 'Default text colour' }), body));
			document.body.append(el);

			const place = () => {
				const r = btn.getBoundingClientRect();
				const mw = el.offsetWidth, mh = el.offsetHeight;
				let top = r.bottom + 6;
				if (top + mh > window.innerHeight - 8 && r.top - mh - 6 > 8) top = r.top - mh - 6;
				el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - mw - 8)) + 'px';
				el.style.top = Math.max(8, top) + 'px';
			};
			const outside = (ev) => { if (!el.contains(ev.target) && !btn.contains(ev.target)) close(); };
			const keys = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); close(); } };
			document.addEventListener('mousedown', outside, true);
			document.addEventListener('keydown', keys, true);
			window.addEventListener('resize', place);
			menu = { kind: 'color', el, btn, outside, keys, place, rerender: () => {} };
			btn.classList.add('fr-active');
			btn.setAttribute('aria-expanded', 'true');
			render();
			place();
			hex.focus({ preventScroll: true });
		}

		// A thin bar under the paint button shows the colour that's on.
		function showColor(color) {
			document.querySelectorAll('.bb-color-btn').forEach((b) => {
				b.style.boxShadow = color ? 'inset 0 -3px 0 ' + color : '';
				b.title = color ? 'Default text colour: ' + color : 'Default text colour';
			});
		}

		/** Wraps the message in the colour, block by block, so XenForo turns it into [COLOR]. */
		function colorize(html, color) {
			const trimmed = html.trim();
			if (!trimmed) return html;
			if (trimmed[0] !== '<') {
				// BB code editor: the message is BB code already.
				return trimmed.startsWith('/') ? html : '[COLOR=' + color + ']' + html + '[/COLOR]';
			}
			const tpl = document.createElement('template');
			tpl.innerHTML = html;
			const root = tpl.content;
			if (root.textContent.trim().startsWith('/')) return html; // chat commands like /me
			const wrap = (nodes) => {
				if (!nodes.some((n) => n.nodeType === 1 || n.textContent.trim())) return;
				const span = document.createElement('span');
				span.setAttribute('style', 'color: ' + color);
				nodes[0].before(span);
				span.append(...nodes);
			};
			const walk = (parent) => {
				let run = [];
				for (const n of [...parent.childNodes]) {
					if (n.nodeType === 1 && /^(P|DIV|LI|UL|OL|H[1-6])$/.test(n.tagName)) {
						wrap(run);
						run = [];
						walk(n);
					} else if (n.nodeType === 1 && n.tagName === 'BLOCKQUOTE') {
						wrap(run); // quoted text keeps its own look
						run = [];
					} else {
						run.push(n);
					}
				}
				wrap(run);
			};
			walk(root);
			const out = document.createElement('div');
			out.append(root);
			return out.innerHTML;
		}

		// Siropu sends a new message with XF.ajax('POST', '.../chat/submit', { message_html, ... }).
		// The colour is added right there, so the editor itself is never touched.
		if (!XF.ajax.__banterboxColor) {
			const realAjax = XF.ajax;
			const ajax = function (method, url, data, ...rest) {
				const color = store.get().color;
				if (color && typeof url === 'string' && /[?/]chat\/submit(?:[&#]|$)/.test(url)
					&& data && typeof data === 'object' && typeof data.message_html === 'string') {
					try {
						data = { ...data, message_html: colorize(data.message_html, color) };
					} catch (err) {
						console.warn(TAG, 'could not apply the colour:', err);
					}
				}
				return realAjax.call(this, method, url, data, ...rest);
			};
			ajax.__banterboxColor = true;
			XF.ajax = ajax;
		}

		// ---------------------------------------------------- toolbar

		// Show every toolbar button instead of folding them under "more". XenForo
		// picks a smaller layout whenever the editor is under 900px wide, which in
		// the shoutbox is nearly always. Froala keeps references to these layout
		// objects, so they are changed in place; the toolbar wraps if it must.
		const widened = new WeakSet();
		function widenToolbar(toolbar) {
			const target = editorFor(toolbar);
			const ed = target && target.ed;
			if (!ed || widened.has(ed) || !ed.opts || !ed.helpers) return;
			widened.add(ed);
			try {
				for (const key of ['toolbarButtons', 'toolbarButtonsMD', 'toolbarButtonsSM', 'toolbarButtonsXS']) {
					const layout = ed.opts[key];
					if (!layout || typeof layout !== 'object') continue;
					for (const group of Object.values(layout)) {
						if (group && Array.isArray(group.buttons)) group.buttonsVisible = String(group.buttons.length);
					}
				}
				// Froala only rebuilds when the size class changes, so fake one change.
				const FE = window.FroalaEditor;
				const real = ed.helpers.screenSize;
				if (FE && typeof real === 'function') {
					const now = real.call(ed.helpers);
					ed.helpers.screenSize = () => (now === FE.LG ? FE.MD : FE.LG);
					try { window.dispatchEvent(new Event('resize')); }
					finally { ed.helpers.screenSize = real; }
					window.dispatchEvent(new Event('resize'));
				}
			} catch (err) {
				console.warn('[BanterBox] could not widen the toolbar', err);
			}
		}

		// Right after the image button if there is one, else at the end of the first group.
		// Froala also marks buttons it regroups with fr-hidden, ours included, so undo that.
		// The paint button goes right after the Kappa button.
		function placeButton(toolbar, btn, paint) {
			for (const b of [btn, paint]) if (b.classList.contains('fr-hidden')) b.classList.remove('fr-hidden');
			const after = toolbar.querySelector('[data-cmd="insertImage"]');
			if (after) {
				if (after.nextElementSibling !== btn) after.after(btn);
			} else {
				const group = toolbar.querySelector('.fr-btn-grp') || toolbar;
				if (btn.parentElement !== group) group.append(btn);
			}
			if (btn.nextElementSibling !== paint) btn.after(paint);
		}

		function addButton(toolbar) {
			widenToolbar(toolbar);
			const existing = toolbar.querySelector('.bb-emoji-btn');
			const existingPaint = toolbar.querySelector('.bb-color-btn');
			if (existing && existingPaint) { placeButton(toolbar, existing, existingPaint); return; }
			const icon = make('img', { src: KAPPA_ICON, alt: '', width: 20, height: 20 });
			const btn = make('button', {
				type: 'button', class: 'fr-command fr-btn bb-emoji-btn', title: 'BanterBox emojis',
				'aria-haspopup': 'dialog', 'aria-expanded': 'false',
			}, icon, make('span', { class: 'fr-sr-only', text: 'BanterBox emojis' }));

			// Keep the editor's caret where it is when the button is pressed.
			btn.addEventListener('mousedown', (ev) => {
				ev.preventDefault();
				const target = editorFor(btn);
				if (target && !(target.handler.isBbCodeView && target.handler.isBbCodeView())) {
					target.ed.selection.save();
					savedFor = target.ed;
				}
			});
			const toggle = (b, openFn) => (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				const wasOpen = menu && menu.btn === b;
				close();
				if (!wasOpen) openFn(b);
			};
			btn.addEventListener('click', toggle(btn, open));
			// Warm the list on hover (load() checks the privacy setting first).
			btn.addEventListener('mouseenter', () => { load().catch(() => {}); }, { once: true });

			const paint = make('button', {
				type: 'button', class: 'fr-command fr-btn bb-color-btn', title: 'Default text colour',
				'aria-haspopup': 'dialog', 'aria-expanded': 'false',
			}, make('img', { src: PAINT_ICON, alt: '', width: 20, height: 20 }), make('span', { class: 'fr-sr-only', text: 'Default text colour' }));
			paint.addEventListener('mousedown', (ev) => ev.preventDefault());
			paint.addEventListener('click', toggle(paint, openColor));

			placeButton(toolbar, btn, paint);
			showColor(store.get().color);

			// Froala regroups its own buttons on resize: it leaves ours behind or hides them.
			// Put them back straight away so they never flicker out.
			const keep = new MutationObserver(() => placeButton(toolbar, btn, paint));
			keep.observe(toolbar, { childList: true, subtree: true });
			keep.observe(btn, { attributes: true, attributeFilter: ['class'] });
			keep.observe(paint, { attributes: true, attributeFilter: ['class'] });
		}

		function addStyles() {
			if (document.getElementById('bb-emoji-style')) return;
			const s = document.createElement('style');
			s.id = 'bb-emoji-style';
			s.textContent = `
				.bb-emoji-btn img, .bb-color-btn img { display: block; margin: auto; width: 20px; height: 20px; object-fit: contain; }
				.bb-color-btn img { image-rendering: pixelated; }
				.bb-color-menu .menu-header { margin: 0; }
				.bb-color-menu .bb-color { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 12px; }
				.bb-color-menu .bb-color p { margin: 0; font-size: 12px; }
				.bb-color-menu .bb-color-pick { display: flex; gap: 8px; align-items: center; }
				.bb-color-menu .bb-color-picker { width: 40px; height: 32px; padding: 0; border: 0; background: none; cursor: pointer; }
				.bb-color-menu .bb-color-hex { flex: 1; font-family: monospace; }
				.bb-color-menu .bb-color-error, .bb-color-menu .bb-color-warn { font-size: 12px; color: #e5484d; }
				.bb-color-menu .bb-color-error:empty, .bb-color-menu .bb-color-warn:empty { display: none; }
				.bb-color-menu .bb-color-preview { border-radius: 4px; padding: 8px 10px; font-size: 13px; line-height: 1.4; border: 1px solid rgba(127, 127, 127, .35); }
				.bb-color-menu .bb-color-style { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px; }
				.bb-color-menu .bb-color-time { font-size: 11px; }
				.bb-color-menu .bb-color-actions { display: flex; gap: 8px; }
				.menu.bb-emoji-menu {
					position: fixed; display: block; width: 340px; max-width: calc(100vw - 16px);
					margin: 0; z-index: 1000;
				}
				.bb-emoji-menu .bb-emoji-content {
					display: flex; flex-direction: column; max-height: min(440px, calc(100vh - 16px)); overflow: hidden;
				}
				.bb-emoji-menu .bb-emoji-search { width: 100%; box-sizing: border-box; }
				.bb-emoji-menu .bb-emoji-body { overflow-y: auto; flex: 1; padding: 0 8px 6px; }
				.bb-emoji-menu .bb-emoji-heading { font-size: 12px; margin: 0; padding: 8px 4px 4px; background: none; border: 0; }
				.bb-emoji-menu .bb-emoji-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(40px, 1fr)); gap: 2px; }
				.bb-emoji-menu .bb-emoji-tile {
					display: flex; align-items: center; justify-content: center; height: 40px; padding: 4px;
					border: 0; border-radius: 4px; cursor: pointer; font: inherit;
				}
				.bb-emoji-menu .bb-emoji-tile:not(:hover):not(:focus-visible) { background: none; }
				.bb-emoji-menu .bb-emoji-tile img { max-width: 32px; max-height: 32px; width: auto; height: auto; }
				.bb-emoji-menu .bb-emoji-empty { text-align: center; padding: 16px 8px; }
				.bb-emoji-menu .bb-emoji-foot { display: flex; justify-content: space-between; gap: 8px; min-height: 18px; }
				.bb-emoji-menu .bb-emoji-hover { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
				.bb-emoji-menu .bb-emoji-foot a { white-space: nowrap; }
				.bb-emoji-menu .bb-consent { display: flex; flex-direction: column; gap: 6px; padding: 10px 4px; }
				.bb-emoji-menu .bb-consent p { margin: 0; }
				.bb-emoji-menu .bb-consent-opt { display: flex; align-items: center; gap: 6px; cursor: pointer; }
				.bb-emoji-menu .bb-consent-save { align-self: flex-start; }
			`;
			document.head.append(s);
		}

		addStyles();
		const scan = () => chat.querySelectorAll('.fr-toolbar').forEach(addButton);
		scan();
		// The chat can rebuild its editor (e.g. switching rooms); put the button back.
		let queued = false;
		new MutationObserver(() => {
			if (queued) return;
			queued = true;
			setTimeout(() => { queued = false; scan(); }, 250);
		}).observe(chat, { childList: true, subtree: true });
	}

	// ------------------------------------------------------- load more fix

	function installLoadMoreFix(chat) {
		function fixList(ul) {
			const btn = ul.querySelector(':scope > li.siropuChatLoadMoreMessages');
			if (!btn) return;

			const rows = ul.querySelectorAll(':scope > li[data-id]');
			if (rows.length < 2) return;

			// Work out the order from the message ids rather than trusting settings:
			// newest-first (inverse) means the oldest messages are at the bottom.
			const first = Number(rows[0].dataset.id);
			const last = Number(rows[rows.length - 1].dataset.id);
			const newestFirst = first > last;

			if (newestFirst) {
				if (ul.lastElementChild !== btn) ul.append(btn);
			} else {
				if (ul.firstElementChild !== btn) ul.prepend(btn);
			}
		}

		let scheduled = false;
		const run = () => {
			scheduled = false;
			chat.querySelectorAll('ul.siropuChatMessages').forEach(fixList);
		};

		new MutationObserver(() => {
			if (!scheduled) {
				scheduled = true;
				queueMicrotask(run);
			}
		}).observe(chat, { childList: true, subtree: true });

		run();
	}

	// ----------------------------------------------------------------- boot

	// ------------------------------------------------------- who liked

	// Next to a message's green "+N" (Siropu's link to its "Message likes" overlay),
	// shows the avatars of the people who liked it, and their names on hover. The
	// list comes from that same overlay, read from perpheads itself: one request per
	// liked message, again only when its like count changes.
	function installLikers(XF, chat) {
		const MAX_AVATARS = 6;
		const LIKES_RE = /^\/chat\/message\/(\d+)\/likes$/;
		const cache = new Map(); // message id -> { count, users: Promise<[{id, name, href, img, letter, bg, fg}]> }
		let queue = Promise.resolve();
		let pop = null;

		const el = (tag, cls, text) => {
			const e = document.createElement(tag);
			if (cls) e.className = cls;
			if (text !== undefined) e.textContent = text;
			return e;
		};

		/** Only the bits we need from the overlay HTML, checked; everything else is ignored. */
		function parseLikes(html) {
			const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
			const users = [];
			const seen = new Set();
			for (const row of doc.querySelectorAll('.block-row')) {
				const link = row.querySelector('a.username[data-user-id]');
				const id = link && Number(link.dataset.userId);
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const href = link.getAttribute('href') || '';
				const user = {
					id,
					name: link.textContent.trim().slice(0, 50),
					href: /^\/members\/[^/?#]+\/$/.test(href) ? href : '',
				};
				const img = row.querySelector('.avatar img');
				const src = img && img.getAttribute('src');
				if (src && (/^\/data\/avatars\//.test(src) || /^https:\/\//.test(src))) {
					user.img = src;
				} else {
					// Letter avatar: XenForo colours it with an inline style.
					const box = row.querySelector('.avatar');
					user.letter = (box ? box.textContent.trim() : user.name).slice(0, 1).toUpperCase();
					const st = box ? box.getAttribute('style') || '' : '';
					user.bg = (st.match(/background-color:\s*(#[0-9a-f]{3,6}|rgb\([\d,\s]+\))/i) || [])[1] || '';
					user.fg = (st.match(/(?:^|;)\s*color:\s*(#[0-9a-f]{3,6}|rgb\([\d,\s]+\))/i) || [])[1] || '';
				}
				users.push(user);
			}
			return users;
		}

		// One request at a time, so a page full of liked messages doesn't hit the forum at once.
		function fetchLikes(href) {
			const run = () => new Promise((resolve) => {
				XF.ajax('GET', href, {}, (data) => resolve(parseLikes(data && data.html && data.html.content)),
					{ skipDefault: true, global: false, error: () => resolve(null) });
			});
			const p = queue.then(run, run);
			queue = p.then(() => new Promise((r) => setTimeout(r, 150)));
			return p;
		}

		function avatar(u) {
			if (u.img) {
				const img = el('img', 'bb-liker');
				img.src = u.img;
				img.alt = '';
				img.loading = 'lazy';
				img.width = img.height = 16;
				return img;
			}
			const s = el('span', 'bb-liker bb-liker-letter', u.letter || '?');
			if (u.bg) s.style.backgroundColor = u.bg;
			if (u.fg) s.style.color = u.fg;
			return s;
		}

		function hidePop() {
			if (pop) {
				pop.el.remove();
				pop = null;
			}
		}

		function showPop(anchor, users) {
			hidePop();
			const list = el('ul', 'bb-likers-list');
			for (const u of users) {
				const li = el('li');
				li.append(avatar(u), el('span', null, u.name));
				list.append(li);
			}
			const box = el('div', 'menu is-active bb-likers-pop');
			const content = el('div', 'menu-content');
			content.append(el('div', 'menu-header', 'Liked by'), list);
			box.append(content);
			box.setAttribute('role', 'tooltip');
			document.body.append(box);
			const r = anchor.getBoundingClientRect();
			let top = r.bottom + 4;
			if (top + box.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - box.offsetHeight - 4);
			box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - box.offsetWidth - 8)) + 'px';
			box.style.top = top + 'px';
			pop = { el: box, anchor };
		}

		async function decorate(link) {
			const m = LIKES_RE.exec(link.getAttribute('href') || '');
			if (!m) return;
			const id = m[1];
			const count = link.textContent.trim();
			if (link.dataset.bbLikers === count) return;
			link.dataset.bbLikers = count;

			let entry = cache.get(id);
			if (!entry || entry.count !== count) {
				entry = { count, users: fetchLikes(link.getAttribute('href')) };
				cache.set(id, entry);
			}
			const users = await entry.users;
			if (!users || !users.length || !link.isConnected) return;

			let strip = link.nextElementSibling;
			if (!strip || !strip.classList.contains('bb-likers')) {
				strip = el('span', 'bb-likers');
				link.after(strip);
			}
			strip.replaceChildren(...users.slice(0, MAX_AVATARS).map(avatar));
			if (users.length > MAX_AVATARS) strip.append(el('span', 'bb-likers-more', '+' + (users.length - MAX_AVATARS)));

			if (!link.dataset.bbHover) {
				link.dataset.bbHover = '1';
				let timer = 0;
				const enter = async () => {
					clearTimeout(timer);
					const e = cache.get(id);
					const list = e && await e.users;
					if (list && list.length && link.isConnected) showPop(link, list);
				};
				const leave = () => { timer = setTimeout(() => { if (pop && pop.anchor === link) hidePop(); }, 120); };
				for (const t of [link, strip]) {
					t.addEventListener('mouseenter', enter);
					t.addEventListener('mouseleave', leave);
				}
			}
		}

		function scan() {
			chat.querySelectorAll('a.siropuChatMessageLikes').forEach((link) => { decorate(link); });
			// Avatars left behind when a message lost all its likes.
			chat.querySelectorAll('.bb-likers').forEach((s) => {
				const prev = s.previousElementSibling;
				if (!prev || !prev.classList.contains('siropuChatMessageLikes')) s.remove();
			});
			if (pop && !pop.anchor.isConnected) hidePop();
		}

		const style = document.createElement('style');
		style.textContent = `
			.bb-likers { display: inline-flex; align-items: center; gap: 2px; margin-left: 4px; vertical-align: middle; }
			.bb-liker { width: 16px; height: 16px; border-radius: 50%; object-fit: cover; flex: none; }
			.bb-liker-letter { display: inline-grid; place-items: center; font-size: 10px; font-weight: 700; background: #888; color: #fff; }
			.bb-likers-more { font-size: 11px; opacity: .8; margin-left: 2px; }
			.menu.bb-likers-pop { position: fixed; display: block; margin: 0; z-index: 1000; min-width: 140px; max-width: 260px; pointer-events: none; }
			.bb-likers-pop .menu-header { padding: 6px 10px; font-size: 12px; }
			.bb-likers-list { list-style: none; margin: 0; padding: 4px 10px 8px; max-height: 260px; overflow: hidden; font-size: 13px; }
			.bb-likers-list li { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
		`;
		document.head.append(style);

		scan();
		let queued = false;
		new MutationObserver(() => {
			if (queued) return;
			queued = true;
			setTimeout(() => { queued = false; scan(); }, 200);
		}).observe(chat, { childList: true, subtree: true, characterData: true });
	}

	function boot() {
		const XF = window.XF;
		if (!XF || !XF.Element || !XF.ajax) return false;

		const chat = document.getElementById('siropuChat');
		if (!chat) return true; // no shoutbox on this page

		if (window.__banterbox) return true;
		window.__banterbox = true;

		installEditFix(XF, chat);
		installLoadMoreFix(chat);
		installEmojiMenu(XF, chat, EMOJI_SOURCE);
		installLikers(XF, chat);
		console.info(TAG, 'active');
		return true;
	}

	if (!boot()) {
		let tries = 0;
		const t = setInterval(() => {
			if (boot() || ++tries > 50) clearInterval(t);
		}, 200);
	}
})();

# BanterBox

Browser extension (Chrome + Firefox, Manifest V3) that fixes the Siropu Chat
shoutbox on perpheads.com and adds a custom emoji menu.

- `extension/`: the extension itself (load this folder)
- `server/`: the emoji server and homepage for https://sb.smeris.me (see `server/README.md`)
- `scripts/`: `build-extension.mjs` (Chrome .zip + Firefox .xpi into `dist/`) and
  `check-secrets.sh` (blocks settings, data and secrets from git)

Packages are attached to each GitHub Release (push a `v<version>` tag).

## What it does

1. **Emoji menu.** A Kappa button in the shoutbox toolbar opens a searchable menu
   of custom emojis from https://sb.smeris.me. Picking one inserts it as an image
   (`[IMG width="32px" alt=":name:"]…[/IMG]`), so everyone sees it, even without the
   extension. Recently used emojis are listed first. New emojis are added on the
   server, with no extension update needed.

   The menu uses the forum's own menu styling, so it matches whichever style you
   picked on perpheads.

   **Settings** (click the BanterBox icon in the browser toolbar): switch off the
   sb.smeris.me list, and BanterBox makes no requests to sb.smeris.me at all. Add
   **your own emojis** (a name + an `https://` image link). They're kept only in
   your browser's extension storage and work whether the list is on or off.
2. **Edit button does nothing.** The server answers the edit request with
   `{"message_html": …}` instead of XenForo's standard `{"html": {"content": …}}`,
   so XenForo's overlay code silently ignores it. The edit form also refers to a
   JS handler (`siropu-chat-message-save`) that no longer exists in the add-on.
   BanterBox opens the edit overlay itself and adds the missing handler.
   Enter saves and Shift+Enter adds a new line.
3. **"Load more messages" ends up above the loaded messages.** In newest-on-top
   mode the add-on adds older messages *after* the button. BanterBox keeps the
   button at the bottom (or at the top, in oldest-on-top mode).

## Install

### Chrome / Edge / Brave
1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.

### Firefox (128+)
- Quick test: open `about:debugging#/runtime/this-firefox` → **Load Temporary
  Add-on…** → pick `extension/manifest.json`. This is removed when Firefox restarts.
- Permanent: sign it as an *unlisted* add-on at
  https://addons.mozilla.org/developers/ and install the signed `.xpi`.
  Firefox Developer Edition and Nightly can also install it unsigned after you
  set `xpinstall.signatures.required` to `false`.
- If the fix doesn't kick in, open `about:addons` → BanterBox → **Permissions**
  and make sure access to perpheads.com is allowed.

When it's running, the page console shows `[BanterBox] active`.

# BanterBox

A small browser add-on for the perpheads.com shoutbox. It gives you a proper
emoji menu and fixes a couple of things that have been broken for a while.

## What you get

**More emojis.** There's a Kappa button in the shoutbox toolbar. Click it, pick an
emoji, and it goes into your message. Other people see it too, even if they don't
have BanterBox. The emojis you used last show up at the top.

**Your own emojis.** Click the BanterBox icon in your browser's toolbar to add your
own: give it a name and paste a link to the image. They stay in your browser.

**No outside requests if you'd rather not.** The shared emoji list comes from
sb.smeris.me. You can turn it off in the same BanterBox menu, and the add-on won't
contact that site at all. Your own emojis keep working.

**Editing works again.** The Edit button on your messages opens the edit box like it
should. Enter saves, Shift+Enter starts a new line.

**"Load more messages" stays where it belongs.** Older messages now load above the
button instead of below it, so you don't have to hunt for it.

The emoji menu takes on the look of whatever forum style you've picked.

## Install

Download the latest version from the [Releases page](../../releases/latest).

### Chrome, Edge, Brave

1. Download the `chrome.zip` file and unzip it.
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the unzipped folder.

### Firefox

Download the `firefox-signed.xpi` file and open it in Firefox. Firefox will ask if
you want to add BanterBox; say yes.

If you only see a `firefox.xpi` without "signed" in the name, normal Firefox won't
accept it. You can load it for one session through `about:debugging` →
**This Firefox** → **Load Temporary Add-on…**.

### Then

Reload perpheads.com. The Kappa button shows up in the shoutbox toolbar.

If it doesn't show up in Firefox, go to `about:addons` → BanterBox →
**Permissions** and allow it on perpheads.com.

## Questions or problems

Open an issue on this page, or poke me in the shoutbox.

---

<sub>For developers: the add-on lives in `extension/`, the emoji site in `server/`
(see [server/README.md](server/README.md)), and build scripts in `scripts/`.</sub>

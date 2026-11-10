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

### Chrome, Edge, Brave

Get it from the [Chrome Web Store](https://chromewebstore.google.com/detail/banterbox/oekfncdjkojljcbheogkepfehpndpmim)
and click **Add to Chrome**. It updates by itself.

Had the `.zip` version from the Releases page? Remove it in `chrome://extensions`
first, otherwise that copy never updates.

### Firefox

Download `banterbox-firefox-signed.xpi` from the
[Releases page](../../releases/latest) and open it in Firefox (or drag it onto a
Firefox window), then click **Add**. It updates by itself.

### Then

Reload perpheads.com. The Kappa button shows up in the shoutbox toolbar.

If it doesn't show up in Firefox, go to `about:addons` → BanterBox →
**Permissions** and allow it on perpheads.com.

## Questions or problems

Open an issue on this page, or poke me in the shoutbox.

---

<sub>For developers: the add-on lives in `extension/`, the emoji site in `server/`
(see [server/README.md](server/README.md)), and build scripts in `scripts/`.</sub>

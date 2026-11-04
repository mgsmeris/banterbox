# BanterBox emoji server (sb.smeris.me)

Plain PHP 8.1+ on Apache. No framework, no Composer, no database server (SQLite),
no shell access needed. It serves:

| URL | What |
|---|---|
| `/` | Homepage for the extension, with an emoji gallery |
| `/emojis.json` | The emoji list the extension loads (CORS: perpheads.com only) |
| `/e/<id>.png` | Emoji images |
| `/admin/` | Admin tool: upload, rename, delete emojis; accounts (superuser) |

## Folder layout

```
server/
  public/        <- the ONLY folder the web server may serve (the document root)
    bb-root.php  <- says where the rest lives (edit only for layout B)
  src/           <- code, never served
  config.php     <- your settings (copy from config.example.php), never served
  data/          <- created automatically: database, emojis, sessions, logs
  tests/         <- local tests, don't upload
```

## Deploy

Needs PHP 8.1+ with **pdo_sqlite, gd, fileinfo, mbstring** (Imagick is optional:
without it animated emojis are refused). Apache needs **mod_rewrite** and
`AllowOverride All` (or at least `FileInfo Options Indexes AuthConfig`), so the
`.htaccess` files work. HTTPS is required.

(Deploying from GitHub instead? See [Deploying from GitHub](#deploying-from-github-automatic-deploys).)

**Upload everything except `tests/`.** Then pick one layout:

- **Layout A (best): the subdomain's document root is `public/`.** Upload the
  folder to e.g. `/home/you/banterbox-sb/`, and in the hosting panel set the
  document root of `sb.smeris.me` to `/home/you/banterbox-sb/public`. Nothing
  else to change.
- **Layout B: the panel forces its own document root** (e.g.
  `/home/you/sb.smeris.me/public_html`). Upload the folder next to it, *not*
  inside it (e.g. `/home/you/banterbox-sb/`), then copy the *contents* of
  `public/` (including the `.htaccess` files) into that `public_html/`. Edit
  `public_html/bb-root.php` to `return '/home/you/banterbox-sb';`.

Either way, `src/`, `config.php` and `data/` must **not** be inside the web root.
The app refuses to start if `data/` is.

Then:

1. Copy `config.example.php` to `banterbox-private/config.php`, in the folder
   above the site (see the layout under *Deploying from GitHub*). Check `base_url`
   (`https://sb.smeris.me`), and set
   `setup_token` to a long random string (32+ characters, e.g. from a password
   manager).
2. Make the server folder writable for the web server user (so it can create
   `data/`), or create `data/` yourself and make that writable.
3. Open `https://sb.smeris.me/admin/?a=setup`, enter the setup token and your
   username. You get to the invite page: choose a password and scan the QR code
   with an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…).
4. **Clear `setup_token` in `config.php`** again. The *System* page in the admin
   tool warns you while it's still set.
5. From your PC, run the deploy check (see below). It confirms the `.htaccess`
   rules really block `src/`, `config.php` and `data/`.

## Deploying from GitHub (automatic deploys)

Settings and data must live **outside** the folder git deploys into. Then no
deploy can overwrite or delete them, however the host does it (pull, reset or a
fresh clone), and they're never part of the repository.

```
/var/www/<id>/
  banterbox-private/       <- yours, never in git, never touched by deploys
    config.php
    data/                  <- database, emojis, sessions, logs
  sb.smeris.me/            <- the "deploy" branch is checked out here
    public/                <- the document root of sb.smeris.me (as now)
    src/
```

**Use the `deploy` branch, not `main`.** After every push to `main`, the *CI and
deploy* workflow runs the secret scan and all tests. If everything passes, it copies
`server/` (without `tests/`) onto the `deploy` branch. That branch holds only the
server code, laid out exactly like your current `sb.smeris.me/` folder, so the
document root stays `public/`. Nothing else in the repository (extension, tests,
docs) ever reaches the web server, and a commit that fails the tests is never
deployed. (A tag wouldn't work for this: tags don't move, so the panel wouldn't
pick up new code.)

**Before you connect GitHub** (your current files are inside the site folder):

1. Back up `sb.smeris.me/config.php` and `sb.smeris.me/data/` (download them).
2. Create `/var/www/<id>/banterbox-private/` and move `config.php` and the whole
   `data/` folder into it. If your `config.php` has a `data_dir` line, delete it
   (the default is the `data/` next to `config.php`).
3. Open the admin tool's *System* page: "config.php is outside the code folder"
   and "Data folder is outside the code folder" should both say OK.

**Then** push to GitHub once (so the workflow creates the `deploy` branch) and
connect the hosting panel's git integration to the **`deploy`** branch, deploying
into `sb.smeris.me/`. The app finds `banterbox-private/` by itself: it looks next
to the code folder and one level above it, and only accepts files owned by the
same system user as the code.

**What keeps secrets out of git** (each one alone is enough):

- `.gitignore` excludes `config.php`, `banterbox-private/`, `data/`, databases,
  sessions, logs, `.env` and key files.
- The pre-commit hook (`.githooks/pre-commit` → `scripts/check-secrets.sh`) refuses
  a commit with any of those files, even when forced past `.gitignore`. It also
  refuses anything that looks like a secret: a filled-in `setup_token`, password
  hashes, authenticator secrets, private keys, GitHub or AWS tokens. It's switched
  on per clone, once: `git config core.hooksPath .githooks`
- The *CI and deploy* workflow runs the same check on every push (which also covers
  commits made in GitHub's web editor), and again on the exact files it's about
  to put on the `deploy` branch.
- On GitHub, turn on *Settings → Code security → Secret scanning* and *Push
  protection* too. Then GitHub itself rejects pushes with known token formats.

## Releases (browser packages)

`node scripts/build-extension.mjs` builds `dist/banterbox-<version>-chrome.zip` and
`dist/banterbox-<version>-firefox.xpi`, each with a manifest tuned for that browser.
To publish them, bump `version` in `extension/manifest.json`, commit, and push a
matching tag:

```bash
git tag v1.3.0 && git push origin v1.3.0
```

The *Release* workflow then creates a GitHub Release with both files attached. If
you add the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (an API key
from addons.mozilla.org → Developer Hub → *Manage API Keys*), it also attaches a
Mozilla-signed `.xpi` that installs permanently in normal Firefox. Set
`download_url` in `config.php` to `https://github.com/<you>/<repo>/releases/latest`
to show a Download button on the homepage.

## Accounts

- There is **one superuser** (you). Only the superuser sees *Accounts* and *System*.
- **Add an admin:** *Accounts* → enter a username → *Create invite*. Send them the
  link privately. It works once, for 48 hours. They pick their own password and
  set up their authenticator app. You never know their password.
- **Forgot password / lost phone:** *Reset login* gives them a new invite link and
  signs them out everywhere. *Disable* blocks them straight away.
- **You lost your own login:** set `setup_token` and
  `'allow_superuser_reset' => true` in `config.php`, open `?a=setup`, enter the
  token and follow the new invite. Then undo both settings.

## Security, in short

- **Uploads can't become code.** Files are checked by their bytes (not name or
  browser type), size-limited, and fully decoded and re-encoded, so anything
  hidden in them is dropped. They're stored outside the web root under random names
  with a fixed extension, and served by `e.php` as plain bytes with
  `Content-Security-Policy: sandbox` and `nosniff`. Nothing user supplied ever
  reaches a file path, `include`, `eval`, a shell or `unserialize`. SVG is refused.
- **Logins:** username + password (Argon2id or bcrypt) + TOTP code, with one
  generic error message. 5 failures per account or 20 per IP within 15 minutes
  lock logins. TOTP codes can't be reused.
- **Sessions:** `__Host-` cookie, `Secure`, `HttpOnly`, `SameSite=Strict`, new id at
  login, 30 min idle / 12 h maximum. Changing a password, resetting or disabling
  an account signs it out everywhere.
- **Every form** needs a CSRF token and a same-origin request. All SQL uses
  prepared statements, and all output is escaped. Pages send a strict CSP (no
  inline script, no third parties), HSTS and `frame-ancestors 'none'`.
- **Audit log** (*Activity*): logins, failures, uploads, renames, deletes and
  account changes, with IP addresses.

## Tests (on your PC)

The tests run the real PHP code in **php-wasm** (PHP 8.3 compiled to WebAssembly,
with GD, Imagick and SQLite) and drive it with **Playwright** in Microsoft Edge.
There's nothing to install besides Node.

```bash
cd server/tests
npm install
npm test               # 33 tests: server + extension menu, including attack cases
npm run test:shots     # same, and saves screenshots to tests/screenshots/
npm run dev            # local server at http://localhost:8090/sb/ (setup token: see dev-server.mjs)
npm run deploy-check   # read-only checks against https://sb.smeris.me once it's live
```

The local server copies the `.htaccess` routing rules. The real Apache rules are
only checked by `npm run deploy-check`.

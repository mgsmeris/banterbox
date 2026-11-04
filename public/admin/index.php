<?php
/*
 * Admin tool: /sb/admin/
 *
 * Actions come from a fixed list with fixed HTTP methods. Every POST passes
 * Http::requireValidPost() (CSRF token + same-origin check). Everything except
 * login, first-run setup and invite acceptance needs a logged-in admin; account
 * management needs the superuser.
 */
declare(strict_types=1);

define('BANTERBOX_PUBLIC', dirname(__DIR__));
require (require BANTERBOX_PUBLIC . '/bb-root.php') . '/src/bootstrap.php';

use BanterBox\Accounts;
use BanterBox\App;
use BanterBox\Auth;
use BanterBox\Db;
use BanterBox\Emojis;
use BanterBox\Http;
use BanterBox\Images;
use BanterBox\Totp;
use BanterBox\UserError;
use BanterBox\View;

Http::requireHttps();
Http::startSession();

$action = $_GET['a'] ?? 'home';
//           action            methods     who may use it
$routes = [
	'home'            => ['GET',      'admin'],
	'login'           => ['POST',     'guest'],
	'logout'          => ['POST',     'admin'],
	'setup'           => ['GET|POST', 'guest'],
	'invite'          => ['GET|POST', 'guest'],
	'upload'          => ['POST',     'admin'],
	'rename'          => ['POST',     'admin'],
	'delete'          => ['POST',     'admin'],
	'password'        => ['GET|POST', 'admin'],
	'audit'           => ['GET',      'admin'],
	'accounts'        => ['GET',      'super'],
	'account_create'  => ['POST',     'super'],
	'account_reset'   => ['POST',     'super'],
	'account_disable' => ['POST',     'super'],
	'account_enable'  => ['POST',     'super'],
	'account_delete'  => ['POST',     'super'],
	'system'          => ['GET',      'super'],
];
if (!is_string($action) || !isset($routes[$action])) {
	Http::deny(404, 'Not found.');
}
[$methods, $who] = $routes[$action];
if (!in_array(Http::method(), explode('|', $methods), true)) {
	Http::deny(405, 'Method not allowed.');
}
if (Http::method() === 'POST') {
	Http::requireValidPost();
}

$user = Auth::user();

// ===================================================== pages without login

if ($action === 'login') {
	if (!$user) {
		$ok = Auth::attempt(Http::post('username', 64), Http::post('password', Auth::MAX_PASSWORD + 1), Http::post('code', 16));
		if (!$ok) {
			// One message for every failure, including rate limiting.
			Http::flash('error', 'Login failed. Check your username, password and code, or wait a while if you tried too often.');
		}
	}
	Http::redirect('admin/');
}

if ($action === 'setup') {
	if (!Accounts::setupOpen()) {
		Http::deny(404, 'Not found.');
	}
	if (Http::method() === 'POST') {
		// Setup tries count against the same per-IP limit as logins.
		if (!Auth::allowAttempt('setup')) {
			Http::flash('error', 'Too many attempts. Wait a while and try again.');
			Http::redirect('admin/?a=setup');
		}
		if (!Accounts::setupTokenValid(Http::post('token', 512))) {
			Auth::recordFailure('setup');
			Db::audit(null, 'setup_failed');
			Http::flash('error', 'That setup token is wrong.');
			Http::redirect('admin/?a=setup');
		}
		try {
			$token = Accounts::setupSuperuser(Http::post('username', 64));
		} catch (UserError $e) {
			Http::flash('error', $e->getMessage());
			Http::redirect('admin/?a=setup');
		}
		Auth::logout();
		$_SESSION['invite_token'] = $token;
		Http::redirect('admin/?a=invite');
	}
	$reset = Accounts::superExists();
	guestPage('Setup', static function () use ($reset): void {
		?>
		<h1><?= kappa() ?> <?= $reset ? 'Reset superuser' : 'Set up BanterBox' ?></h1>
		<?php View::flashes() ?>
		<p class="muted"><?= $reset
			? 'This gives the existing superuser a new password and authenticator. Their current ones stop working.'
			: 'Create the superuser account. You can add the other admins afterwards.' ?></p>
		<form method="post" action="?a=setup">
			<?= View::csrfField() ?>
			<label>Setup token <span class="muted">(from config.php)</span>
				<input type="password" name="token" required autocomplete="off"></label>
			<?php if (!$reset): ?>
				<label>Superuser username
					<input name="username" required pattern="[A-Za-z0-9_.\-]{3,32}" maxlength="32" autocomplete="username"></label>
			<?php endif ?>
			<button class="btn btn-primary" type="submit">Continue</button>
		</form>
		<?php
	});
	exit;
}

if ($action === 'invite') {
	// Move the token from the URL into the session straight away, so it doesn't
	// stay in the address bar or browser history.
	if (Http::method() === 'GET' && isset($_GET['t'])) {
		$t = $_GET['t'];
		$_SESSION['invite_token'] = is_string($t) ? substr($t, 0, 64) : '';
		Http::redirect('admin/?a=invite');
	}
	$token = (string) ($_SESSION['invite_token'] ?? '');

	if (Http::method() === 'POST') {
		if (!Auth::allowAttempt('invite')) {
			Http::flash('error', 'Too many attempts. Wait a while and try again.');
			Http::redirect('admin/?a=invite');
		}
		try {
			$new = Accounts::acceptInvite(
				$token,
				Http::post('password', Auth::MAX_PASSWORD + 1),
				Http::post('confirm', Auth::MAX_PASSWORD + 1),
				Http::post('code', 16)
			);
		} catch (UserError $e) {
			Auth::recordFailure('invite');
			Http::flash('error', $e->getMessage());
			Http::redirect('admin/?a=invite');
		}
		Auth::beginSession($new);
		Http::flash('ok', 'Welcome, ' . $new['username'] . '. Your account is ready.');
		Http::redirect('admin/');
	}

	$invite = Accounts::findInvite($token);
	guestPage('Activate account', static function () use ($invite): void {
		if (!$invite || $invite['disabled']) {
			?>
			<h1><?= kappa() ?> Invite link not valid</h1>
			<?php View::flashes() ?>
			<p>This invite link is invalid, already used or expired (links work for 48 hours). Ask the superuser for a new one.</p>
			<?php
			return;
		}
		$secret = $invite['totp_secret'];
		?>
		<h1><?= kappa() ?> Activate your account</h1>
		<?php View::flashes() ?>
		<p>You're setting up <strong><?= View::e($invite['username']) ?></strong>.</p>
		<form method="post" action="?a=invite">
			<?= View::csrfField() ?>
			<label>Choose a password <span class="muted">(at least <?= Auth::MIN_PASSWORD ?> characters)</span>
				<input type="password" name="password" required minlength="<?= Auth::MIN_PASSWORD ?>" maxlength="<?= Auth::MAX_PASSWORD ?>" autocomplete="new-password"></label>
			<label>Repeat password
				<input type="password" name="confirm" required minlength="<?= Auth::MIN_PASSWORD ?>" maxlength="<?= Auth::MAX_PASSWORD ?>" autocomplete="new-password"></label>

			<div class="totp-setup">
				<div class="qr" data-qr="<?= View::e(Totp::uri($secret, $invite['username'])) ?>" aria-hidden="true"></div>
				<div>
					<p><strong>Two-factor login.</strong> Scan the code with an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password, …), or type in this key:</p>
					<code class="secret"><?= View::e(trim(chunk_split($secret, 4, ' '))) ?></code>
				</div>
			</div>
			<label>Code from the app
				<input name="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code"></label>
			<button class="btn btn-primary" type="submit">Activate account</button>
		</form>
		<?php
	}, true);
	exit;
}

// ======================================================= everything else

if (!$user) {
	if ($action !== 'home') {
		Http::redirect('admin/');
	}
	guestPage('Log in', static function (): void {
		?>
		<h1><?= kappa() ?> BanterBox admin</h1>
		<?php View::flashes() ?>
		<form method="post" action="?a=login" autocomplete="on">
			<?= View::csrfField() ?>
			<label>Username <input name="username" required maxlength="32" autocomplete="username" autofocus></label>
			<label>Password <input type="password" name="password" required maxlength="<?= Auth::MAX_PASSWORD ?>" autocomplete="current-password"></label>
			<label>Authenticator code <input name="code" required inputmode="numeric" pattern="[0-9 ]{6,7}" maxlength="7" autocomplete="one-time-code"></label>
			<button class="btn btn-primary" type="submit">Log in</button>
		</form>
		<?php
	});
	exit;
}

if ($who === 'super' && !Auth::isSuper($user)) {
	Http::deny(403, 'Only the superuser can do that.');
}

$uid = (int) $user['id'];
$postId = static fn (): int => (int) Http::post('id', 12);

switch ($action) {
	case 'logout':
		Db::audit($uid, 'logout');
		Auth::logout();
		Http::redirect('admin/');

	// ------------------------------------------------------------ emojis
	case 'upload':
		$files = normalizeFiles($_FILES['files'] ?? null);
		if (!$files) {
			Http::flash('error', 'Choose at least one image.');
			Http::redirect('admin/');
		}
		if (count($files) > 50) {
			Http::flash('error', 'Upload at most 50 images at a time.');
			Http::redirect('admin/');
		}
		$single = count($files) === 1;
		$given = Emojis::normalizeName(Http::post('name', 64));
		foreach ($files as $f) {
			$label = mb_substr($f['name'], 0, 80);
			$name = ($single && $given !== '') ? $given : Emojis::nameFromFilename($f['name']);
			try {
				if ($f['error'] === UPLOAD_ERR_INI_SIZE || $f['error'] === UPLOAD_ERR_FORM_SIZE) {
					throw new UserError('The file is larger than ' . (Images::MAX_BYTES / 1024) . ' KB.');
				}
				if ($f['error'] !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) {
					throw new UserError('The upload did not arrive. Try again.');
				}
				if ($f['size'] > Images::MAX_BYTES || filesize($f['tmp_name']) > Images::MAX_BYTES) {
					throw new UserError('The file is larger than ' . (Images::MAX_BYTES / 1024) . ' KB.');
				}
				$e = Emojis::create($name, (string) file_get_contents($f['tmp_name']), $uid);
				Http::flash('ok', 'Added :' . $e['name'] . ':');
			} catch (UserError $err) {
				Http::flash('error', $label . ': ' . $err->getMessage());
			} finally {
				if (is_string($f['tmp_name']) && is_uploaded_file($f['tmp_name'])) {
					@unlink($f['tmp_name']);
				}
			}
		}
		Http::redirect('admin/');

	case 'rename':
		try {
			Emojis::rename($postId(), Emojis::normalizeName(Http::post('name', 64)), $uid);
			Http::flash('ok', 'Renamed.');
		} catch (UserError $err) {
			Http::flash('error', $err->getMessage());
		}
		Http::redirect('admin/');

	case 'delete':
		$name = Emojis::delete($postId(), $uid);
		Http::flash($name ? 'ok' : 'error', $name ? 'Deleted :' . $name . ':' : 'That emoji no longer exists.');
		Http::redirect('admin/');

	// ---------------------------------------------------------- accounts
	case 'account_create':
	case 'account_reset':
		try {
			if ($action === 'account_create') {
				$name = Http::post('username', 64);
				$token = Accounts::create($name, $uid);
			} else {
				$row = Db::one('SELECT username FROM users WHERE id = ?', [$postId()]);
				$name = $row['username'] ?? '';
				$token = Accounts::reset($postId(), $uid);
			}
			// Shown once on the next page, never stored in plain text.
			$_SESSION['show_invite'] = ['username' => $name, 'url' => Accounts::inviteUrl($token)];
		} catch (UserError $err) {
			Http::flash('error', $err->getMessage());
		}
		Http::redirect('admin/?a=accounts');

	case 'account_disable':
	case 'account_enable':
		try {
			$name = Accounts::setDisabled($postId(), $action === 'account_disable', $uid);
			Http::flash('ok', ($action === 'account_disable' ? 'Disabled ' : 'Enabled ') . $name . '.');
		} catch (UserError $err) {
			Http::flash('error', $err->getMessage());
		}
		Http::redirect('admin/?a=accounts');

	case 'account_delete':
		try {
			Http::flash('ok', 'Deleted ' . Accounts::delete($postId(), $uid) . '.');
		} catch (UserError $err) {
			Http::flash('error', $err->getMessage());
		}
		Http::redirect('admin/?a=accounts');

	case 'accounts':
		$invite = $_SESSION['show_invite'] ?? null;
		unset($_SESSION['show_invite']);
		$accounts = Accounts::all();
		page('Accounts', $user, static function () use ($accounts, $invite): void {
			if (is_array($invite)) {
				?>
				<div class="card invite-card">
					<h2>Invite link for <?= View::e($invite['username']) ?></h2>
					<p>Send this link to them privately. It works once, for 48 hours. It's only shown now.</p>
					<div class="copy-row">
						<input readonly value="<?= View::e($invite['url']) ?>" data-copy-src aria-label="Invite link">
						<button class="btn" type="button" data-copy>Copy</button>
					</div>
				</div>
				<?php
			}
			?>
			<div class="card">
				<h2>Add an admin</h2>
				<form method="post" action="?a=account_create" class="inline-form">
					<?= View::csrfField() ?>
					<input name="username" required pattern="[A-Za-z0-9_.\-]{3,32}" maxlength="32" placeholder="username" aria-label="Username">
					<button class="btn btn-primary" type="submit">Create invite</button>
				</form>
				<p class="muted">They choose their own password and set up two-factor login from the invite link.</p>
			</div>
			<div class="card">
				<h2>Accounts <span class="count"><?= count($accounts) ?></span></h2>
				<ul class="account-list">
					<?php foreach ($accounts as $a): ?>
						<?php
						$status = $a['disabled'] ? ['disabled', 'Disabled']
							: ($a['active'] ? ['active', 'Active']
							: ($a['invite_expires'] ? ['pending', 'Invite pending'] : ['pending', 'Invite expired']));
						?>
						<li>
							<span class="who"><strong><?= View::e($a['username']) ?></strong><?= $a['role'] === 'super' ? ' <span class="badge">superuser</span>' : '' ?></span>
							<span class="status status-<?= $status[0] ?>"><?= $status[1] ?></span>
							<span class="row-actions">
								<?php if ($a['role'] !== 'super'): ?>
									<?= postButton('account_reset', (int) $a['id'], $a['active'] ? 'Reset login' : 'New invite', 'Reset ' . $a['username'] . '? Their password and authenticator stop working and they get a new invite link.') ?>
									<?= $a['disabled']
										? postButton('account_enable', (int) $a['id'], 'Enable')
										: postButton('account_disable', (int) $a['id'], 'Disable') ?>
									<?= postButton('account_delete', (int) $a['id'], 'Delete', 'Delete ' . $a['username'] . '? Their uploads stay.', true) ?>
								<?php endif ?>
							</span>
						</li>
					<?php endforeach ?>
				</ul>
			</div>
			<?php
		});
		exit;

	case 'system':
		page('System', $user, static function (): void {
			?>
			<div class="card">
				<h2>Server check</h2>
				<ul class="checks">
					<?php foreach (systemChecks() as [$status, $label, $note]): ?>
						<li class="check-<?= $status ?>"><span class="check-status"><?= strtoupper($status) ?></span> <?= View::e($label) ?><?= $note !== '' ? ' <span class="muted">· ' . View::e($note) . '</span>' : '' ?></li>
					<?php endforeach ?>
				</ul>
			</div>
			<?php
		});
		exit;

	// ----------------------------------------------------------- self
	case 'password':
		if (Http::method() === 'POST') {
			$row = Db::one('SELECT password_hash FROM users WHERE id = ?', [$uid]);
			$new = Http::post('new', Auth::MAX_PASSWORD + 1);
			$problem = Auth::passwordProblem($new);
			if (!$row || !password_verify(Http::post('current', Auth::MAX_PASSWORD + 1), (string) $row['password_hash'])) {
				Http::flash('error', 'Your current password is wrong.');
			} elseif (!hash_equals($new, Http::post('confirm', Auth::MAX_PASSWORD + 1))) {
				Http::flash('error', 'The new passwords don\'t match.');
			} elseif ($problem !== null) {
				Http::flash('error', $problem);
			} else {
				Auth::changePassword($uid, $new);
				Db::audit($uid, 'password_changed');
				Http::flash('ok', 'Password changed. Your other sessions were signed out.');
				Http::redirect('admin/');
			}
			Http::redirect('admin/?a=password');
		}
		page('Change password', $user, static function (): void {
			?>
			<div class="card narrow-card">
				<h2>Change password</h2>
				<form method="post" action="?a=password">
					<?= View::csrfField() ?>
					<label>Current password <input type="password" name="current" required autocomplete="current-password"></label>
					<label>New password <input type="password" name="new" required minlength="<?= Auth::MIN_PASSWORD ?>" maxlength="<?= Auth::MAX_PASSWORD ?>" autocomplete="new-password"></label>
					<label>Repeat new password <input type="password" name="confirm" required minlength="<?= Auth::MIN_PASSWORD ?>" maxlength="<?= Auth::MAX_PASSWORD ?>" autocomplete="new-password"></label>
					<button class="btn btn-primary" type="submit">Change password</button>
				</form>
			</div>
			<?php
		});
		exit;

	case 'audit':
		$rows = Db::all('SELECT a.*, u.username FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200');
		page('Activity', $user, static function () use ($rows): void {
			?>
			<div class="card">
				<h2>Activity <span class="muted">(last 200)</span></h2>
				<div class="table-wrap">
					<table class="audit">
						<thead><tr><th>When (UTC)</th><th>Who</th><th>What</th><th>Details</th><th>IP</th></tr></thead>
						<tbody>
						<?php foreach ($rows as $r): ?>
							<tr>
								<td><?= View::e(gmdate('Y-m-d H:i', (int) $r['at'])) ?></td>
								<td><?= View::e($r['username'] ?? '-') ?></td>
								<td><?= View::e($r['action']) ?></td>
								<td><?= View::e($r['detail']) ?></td>
								<td><?= View::e($r['ip']) ?></td>
							</tr>
						<?php endforeach ?>
						</tbody>
					</table>
				</div>
			</div>
			<?php
		});
		exit;
}

// ============================================================ dashboard
$emojis = Emojis::all();
page('Emojis', $user, static function () use ($emojis): void {
	$animatedNote = Images::imagickAvailable()
		? 'Animated GIF and WebP stay animated.'
		: 'Animated images are rejected: this server has no Imagick extension.';
	?>
	<div class="card">
		<h2>Upload</h2>
		<form method="post" action="?a=upload" enctype="multipart/form-data" class="upload">
			<?= View::csrfField() ?>
			<input type="hidden" name="MAX_FILE_SIZE" value="<?= Images::MAX_BYTES ?>">
			<label class="drop" data-drop>
				<input type="file" name="files[]" accept="image/png,image/jpeg,image/gif,image/webp" multiple required data-files>
				<span data-drop-label>Drop images here or click to choose</span>
			</label>
			<label>Name <span class="muted">(single upload only, otherwise taken from the file names)</span>
				<input name="name" maxlength="34" pattern=":?[a-z0-9_]{2,32}:?" placeholder="pog_champ" data-name-input></label>
			<p class="muted">PNG, JPEG, GIF or WebP, up to <?= Images::MAX_BYTES / 1024 ?> KB and <?= Images::MAX_INPUT_SIDE ?> px. Every emoji is saved at <?= Images::SIZE ?>×<?= Images::SIZE ?> px (scaled to fit, never stretched). <?= View::e($animatedNote) ?></p>
			<button class="btn btn-primary" type="submit">Upload</button>
		</form>
	</div>

	<div class="card">
		<div class="section-head">
			<h2>Emojis <span class="count"><?= count($emojis) ?></span></h2>
			<input type="search" placeholder="Filter" class="filter" data-filter aria-label="Filter emojis">
		</div>
		<p class="muted">Deleting an emoji breaks it in messages that already use it.</p>
		<ul class="admin-list" data-list>
			<?php foreach ($emojis as $e): ?>
				<li data-name="<?= View::e($e['name']) ?>">
					<img src="<?= View::e(Emojis::publicUrl($e)) ?>" width="<?= (int) $e['width'] ?>" height="<?= (int) $e['height'] ?>" alt="" loading="lazy">
					<form method="post" action="?a=rename" class="rename">
						<?= View::csrfField() ?>
						<input type="hidden" name="id" value="<?= (int) $e['id'] ?>">
						<input name="name" value="<?= View::e($e['name']) ?>" maxlength="32" pattern="[a-z0-9_]{2,32}" aria-label="Name" required>
						<button class="btn btn-small" type="submit">Rename</button>
					</form>
					<span class="meta muted"><?= (int) $e['width'] ?>×<?= (int) $e['height'] ?> · <?= View::e(round($e['bytes'] / 1024, 1)) ?> KB<?= $e['animated'] ? ' · animated' : '' ?> · <?= View::e($e['uploader'] ?? 'deleted user') ?></span>
					<?= postButton('delete', (int) $e['id'], 'Delete', 'Delete :' . $e['name'] . ':? It will break in messages that already use it.', true) ?>
				</li>
			<?php endforeach ?>
		</ul>
	</div>
	<?php
});

// ============================================================== helpers

function kappa(): string
{
	return '<img src="' . View::e(View::asset('kappa-32.png')) . '" width="32" height="32" alt="">';
}

/** A one-button POST form. All arguments are ours; the label and confirm text are escaped anyway. */
function postButton(string $action, int $id, string $label, string $confirm = '', bool $danger = false): string
{
	return '<form method="post" action="?a=' . View::e($action) . '"' . ($confirm !== '' ? ' data-confirm="' . View::e($confirm) . '"' : '') . '>'
		. View::csrfField()
		. '<input type="hidden" name="id" value="' . $id . '">'
		. '<button class="btn btn-small' . ($danger ? ' btn-danger' : '') . '" type="submit">' . View::e($label) . '</button>'
		. '</form>';
}

function guestPage(string $title, callable $body, bool $qr = false): void
{
	Http::pageHeaders(true);
	View::head($title . ' · BanterBox admin', true, $qr);
	echo '<main class="wrap narrow"><div class="card login">';
	$body();
	echo '</div></main>';
	View::foot();
}

function page(string $title, array $user, callable $body): void
{
	Http::pageHeaders(true);
	View::head($title . ' · BanterBox admin', true);
	?>
	<header class="admin-bar">
		<div class="wrap admin-bar-inner">
			<a class="brand" href="./"><img src="<?= View::e(View::asset('kappa-32.png')) ?>" width="24" height="24" alt=""> BanterBox admin</a>
			<nav>
				<a href="./">Emojis</a>
				<?php if (Auth::isSuper($user)): ?>
					<a href="?a=accounts">Accounts</a>
					<a href="?a=system">System</a>
				<?php endif ?>
				<a href="?a=audit">Activity</a>
				<a href="?a=password">Password</a>
				<a href="../">Homepage</a>
			</nav>
			<form method="post" action="?a=logout">
				<?= View::csrfField() ?>
				<span class="muted"><?= View::e($user['username']) ?></span>
				<button class="btn btn-small" type="submit">Log out</button>
			</form>
		</div>
	</header>
	<main class="wrap">
		<?php View::flashes() ?>
		<?php $body() ?>
	</main>
	<?php
	View::foot();
}

/** Turns PHP's $_FILES['x'] (single or multiple) into a list of clean entries. */
function normalizeFiles(mixed $f): array
{
	if (!is_array($f) || !isset($f['name'], $f['tmp_name'], $f['error'], $f['size'])) {
		return [];
	}
	$out = [];
	$names = (array) $f['name'];
	foreach (array_keys($names) as $i) {
		$tmp = ((array) $f['tmp_name'])[$i] ?? '';
		$err = ((array) $f['error'])[$i] ?? UPLOAD_ERR_NO_FILE;
		if (!is_string($tmp) || !is_int($err) || $err === UPLOAD_ERR_NO_FILE) {
			continue;
		}
		$out[] = [
			'name' => is_string($names[$i]) ? basename($names[$i]) : 'upload',
			'tmp_name' => $tmp,
			'error' => $err,
			'size' => (int) (((array) $f['size'])[$i] ?? 0),
		];
	}
	return $out;
}

/** What the old command-line check did, for the superuser's System page. */
function systemChecks(): array
{
	$c = [];
	$add = static function (bool $ok, string $label, string $note = '', bool $required = true) use (&$c): void {
		$c[] = [$ok ? 'ok' : ($required ? 'fail' : 'warn'), $label, $note];
	};
	$bytes = static function (string $v): int {
		$n = (int) $v;
		return match (strtolower(substr(trim($v), -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
	};

	$add(version_compare(PHP_VERSION, '8.1.0', '>='), 'PHP ' . PHP_VERSION, 'needs 8.1 or newer');
	foreach (['pdo_sqlite' => 'database', 'gd' => 'image re-encoding', 'fileinfo' => 'file type detection', 'mbstring' => 'text'] as $ext => $why) {
		$add(extension_loaded($ext), 'Extension ' . $ext, $why);
	}
	if (function_exists('gd_info')) {
		$gd = gd_info();
		foreach (['PNG Support' => 'PNG', 'JPEG Support' => 'JPEG', 'GIF Read Support' => 'GIF', 'WebP Support' => 'WebP'] as $k => $label) {
			$add(!empty($gd[$k]), 'GD reads ' . $label, '', false);
		}
	}
	$add(Images::imagickAvailable(), 'Extension imagick', Images::imagickAvailable() ? 'animated emojis supported' : 'optional; without it animated uploads are rejected', false);
	$add(defined('PASSWORD_ARGON2ID'), 'Argon2id password hashing', defined('PASSWORD_ARGON2ID') ? '' : 'using bcrypt instead (fine)', false);
	$add($bytes((string) ini_get('upload_max_filesize')) >= Images::MAX_BYTES, 'upload_max_filesize = ' . ini_get('upload_max_filesize'), 'needs 512K or more');
	$add($bytes((string) ini_get('post_max_size')) >= 2 << 20, 'post_max_size = ' . ini_get('post_max_size'), '2M or more for multi-file uploads', false);
	$add(Http::isHttps(), 'Served over HTTPS');
	$add(is_writable(App::dataDir()), 'Data directory writable');
	$add(strlen((string) App::config('setup_token')) === 0, 'setup_token cleared in config.php', 'remove it once setup is done', false);
	$add(App::config('allow_superuser_reset') !== true, 'allow_superuser_reset is off', 'turn it off after a recovery');
	$add(!App::insideCode(App::configFile()), 'config.php is outside the code folder',
		App::insideCode(App::configFile()) ? 'move it to ' . App::PRIVATE_DIR . '/ next to the site so deploys can never touch it' : '', false);
	$add(!App::insideCode(App::dataDir()), 'Data folder is outside the code folder',
		App::insideCode(App::dataDir()) ? 'move data/ into ' . App::PRIVATE_DIR . '/ as well' : '', false);	$add(!ini_get('display_errors'), 'display_errors off');
	return $c;
}

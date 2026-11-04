<?php
declare(strict_types=1);

namespace BanterBox;

/**
 * Accounts and invites.
 *
 * There is one superuser. They create the other accounts in the admin tool.
 * Every account, the superuser's included, is activated through a one-time
 * invite link: the invitee chooses their own password and enrolls an
 * authenticator app there, so nobody else ever knows their credentials.
 * Only a SHA-256 hash of an invite token is stored.
 */
final class Accounts
{
	public const INVITE_TTL = 48 * 3600;
	public const MIN_SETUP_TOKEN = 32;

	public static function all(): array
	{
		return Db::all(
			'SELECT u.id, u.username, u.role, u.disabled, u.created_at,
			        (u.password_hash IS NOT NULL AND u.totp_secret IS NOT NULL) AS active,
			        i.expires_at AS invite_expires
			 FROM users u LEFT JOIN invites i ON i.user_id = u.id
			 ORDER BY u.role = \'super\' DESC, u.username'
		);
	}

	public static function superExists(): bool
	{
		return Db::one("SELECT 1 FROM users WHERE role = 'super'") !== null;
	}

	/** Is the first-run / recovery setup page usable right now? */
	public static function setupOpen(): bool
	{
		$token = (string) App::config('setup_token');
		if (strlen($token) < self::MIN_SETUP_TOKEN) {
			return false;
		}
		return !self::superExists() || App::config('allow_superuser_reset') === true;
	}

	public static function setupTokenValid(string $given): bool
	{
		$token = (string) App::config('setup_token');
		return strlen($token) >= self::MIN_SETUP_TOKEN && hash_equals($token, $given);
	}

	/**
	 * Creates the superuser (first run) or resets them (recovery). Returns an invite token.
	 * @throws UserError
	 */
	public static function setupSuperuser(string $username): string
	{
		$super = Db::one("SELECT * FROM users WHERE role = 'super'");
		if ($super) {
			if (App::config('allow_superuser_reset') !== true) {
				throw new UserError('Setup is closed.');
			}
			self::clearCredentials((int) $super['id']);
			Db::audit((int) $super['id'], 'superuser_reset');
			return self::issueInvite((int) $super['id']);
		}
		if (!preg_match(Auth::USERNAME_RE, $username)) {
			throw new UserError('Usernames are 3 to 32 characters: letters, digits, _ . and -');
		}
		Db::run("INSERT INTO users (username, role, created_at) VALUES (?, 'super', ?)", [$username, time()]);
		$id = Db::lastId();
		Db::audit($id, 'superuser_created', $username);
		return self::issueInvite($id);
	}

	/** @throws UserError */
	public static function create(string $username, int $byUserId): string
	{
		if (!preg_match(Auth::USERNAME_RE, $username)) {
			throw new UserError('Usernames are 3 to 32 characters: letters, digits, _ . and -');
		}
		if (Db::one('SELECT 1 FROM users WHERE username = ?', [$username])) {
			throw new UserError('That username is taken.');
		}
		Db::run("INSERT INTO users (username, role, created_by, created_at) VALUES (?, 'admin', ?, ?)", [$username, $byUserId, time()]);
		$id = Db::lastId();
		Db::audit($byUserId, 'account_created', $username);
		return self::issueInvite($id);
	}

	/**
	 * Wipes an admin's password and 2FA and gives them a fresh invite link
	 * (forgotten password, lost phone). Signs them out everywhere.
	 * @throws UserError
	 */
	public static function reset(int $id, int $byUserId): string
	{
		$u = self::editable($id, $byUserId);
		self::clearCredentials($id);
		Db::audit($byUserId, 'account_reset', $u['username']);
		return self::issueInvite($id);
	}

	/** @throws UserError */
	public static function setDisabled(int $id, bool $disabled, int $byUserId): string
	{
		$u = self::editable($id, $byUserId);
		Db::run('UPDATE users SET disabled = ?, session_epoch = session_epoch + 1 WHERE id = ?', [(int) $disabled, $id]);
		Db::audit($byUserId, $disabled ? 'account_disabled' : 'account_enabled', $u['username']);
		return $u['username'];
	}

	/** @throws UserError */
	public static function delete(int $id, int $byUserId): string
	{
		$u = self::editable($id, $byUserId);
		Db::run('DELETE FROM users WHERE id = ?', [$id]);
		Db::audit($byUserId, 'account_deleted', $u['username']);
		return $u['username'];
	}

	/** The superuser can manage other admins, never themselves or another superuser. */
	private static function editable(int $id, int $byUserId): array
	{
		$u = Db::one('SELECT * FROM users WHERE id = ?', [$id]);
		if (!$u) {
			throw new UserError('That account no longer exists.');
		}
		if ($u['role'] === 'super' || $id === $byUserId) {
			throw new UserError('The superuser account can\'t be changed here.');
		}
		return $u;
	}

	private static function clearCredentials(int $id): void
	{
		Db::run(
			'UPDATE users SET password_hash = NULL, totp_secret = NULL, totp_last_step = 0,
			 session_epoch = session_epoch + 1 WHERE id = ?',
			[$id]
		);
	}

	private static function issueInvite(int $userId): string
	{
		$token = bin2hex(random_bytes(32));
		Db::run('DELETE FROM invites WHERE user_id = ?', [$userId]);
		Db::run(
			'INSERT INTO invites (user_id, token_hash, totp_secret, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
			[$userId, hash('sha256', $token), Totp::newSecret(), time() + self::INVITE_TTL, time()]
		);
		return $token;
	}

	public static function inviteUrl(string $token): string
	{
		return App::url('admin/?a=invite&t=' . $token);
	}

	/** The pending invite for a token, joined with its user, or null if invalid / expired. */
	public static function findInvite(string $token): ?array
	{
		if (!preg_match('/^[a-f0-9]{64}$/', $token)) {
			return null;
		}
		Db::run('DELETE FROM invites WHERE expires_at < ?', [time()]);
		return Db::one(
			'SELECT i.*, u.username, u.disabled FROM invites i JOIN users u ON u.id = i.user_id WHERE i.token_hash = ?',
			[hash('sha256', $token)]
		);
	}

	/**
	 * Activates an account. The code proves the authenticator app was set up.
	 * @throws UserError
	 */
	public static function acceptInvite(string $token, string $password, string $confirm, string $code): array
	{
		$invite = self::findInvite($token);
		if (!$invite || $invite['disabled']) {
			throw new UserError('This invite link is invalid or has expired. Ask for a new one.');
		}
		$problem = Auth::passwordProblem($password);
		if ($problem !== null) {
			throw new UserError($problem);
		}
		if (!hash_equals($password, $confirm)) {
			throw new UserError('The passwords don\'t match.');
		}
		$step = Totp::verify($invite['totp_secret'], $code);
		if ($step === null) {
			throw new UserError('That authenticator code is wrong. Check the app shows "BanterBox" and try the current code.');
		}

		$pdo = Db::pdo();
		$pdo->beginTransaction();
		try {
			// Delete first: if two requests race, only one gets rowCount 1.
			if (Db::run('DELETE FROM invites WHERE id = ?', [$invite['id']]) !== 1) {
				throw new UserError('This invite link was already used.');
			}
			Db::run(
				'UPDATE users SET password_hash = ?, totp_secret = ?, totp_last_step = ?, session_epoch = session_epoch + 1 WHERE id = ?',
				[Auth::hashPassword($password), $invite['totp_secret'], $step, $invite['user_id']]
			);
			$pdo->commit();
		} catch (\Throwable $e) {
			$pdo->rollBack();
			throw $e;
		}
		Db::audit((int) $invite['user_id'], 'invite_accepted', $invite['username']);
		return Db::one('SELECT * FROM users WHERE id = ?', [$invite['user_id']]);
	}
}

<?php
declare(strict_types=1);

namespace BanterBox;

/**
 * Admin login: username + password + TOTP code, all checked together and
 * answered with one generic error so nothing leaks about which part was wrong.
 */
final class Auth
{
	public const MIN_PASSWORD = 12;
	public const MAX_PASSWORD = 256;
	public const USERNAME_RE = '/^[A-Za-z0-9_.-]{3,32}$/';

	private static ?array $user = null;

	public static function hashPassword(string $password): string
	{
		if (defined('PASSWORD_ARGON2ID')) {
			return password_hash($password, PASSWORD_ARGON2ID);
		}
		return password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
	}

	/** Returns an error message, or null if the password is acceptable. */
	public static function passwordProblem(string $password): ?string
	{
		$len = mb_strlen($password);
		if ($len < self::MIN_PASSWORD) {
			return 'Use at least ' . self::MIN_PASSWORD . ' characters.';
		}
		if ($len > self::MAX_PASSWORD) {
			return 'That password is too long.';
		}
		if (!defined('PASSWORD_ARGON2ID') && strlen($password) > 72) {
			return 'This server uses bcrypt, which only reads 72 bytes. Use a shorter password.';
		}
		return null;
	}

	/** Checks all three factors. Returns the user row on success, null otherwise. */
	public static function attempt(string $username, string $password, string $code): ?array
	{
		$window = (int) App::config('login_window');
		$since = time() - $window;
		$ipKey = 'ip:' . Http::clientIp();
		$userKey = 'user:' . strtolower($username);

		Db::run('DELETE FROM login_failures WHERE at < ?', [$since]);
		$ipFails = (int) Db::one('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at >= ?', [$ipKey, $since])['n'];
		$userFails = (int) Db::one('SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at >= ?', [$userKey, $since])['n'];
		if ($ipFails >= (int) App::config('login_max_failures_per_ip')
			|| $userFails >= (int) App::config('login_max_failures_per_user')) {
			Db::audit(null, 'login_blocked', $username);
			return null;
		}

		$user = null;
		if (preg_match(self::USERNAME_RE, $username) && mb_strlen($password) <= self::MAX_PASSWORD) {
			$user = Db::one('SELECT * FROM users WHERE username = ?', [$username]);
		}

		// Always run one real password check so response time doesn't reveal which
		// usernames exist. (Valid bcrypt hash of a random string, not a secret.)
		$hash = $user['password_hash'] ?? '$2y$12$LTRuLVcnXj9Ao/Dy58sn7OmXTSQSIXIA4JqYEZTv.c1NLx.BOF0dK'; // banterbox-allow-secret
		$passOk = password_verify($password, $hash);

		$step = null;
		if ($user && $passOk && !$user['disabled'] && $user['totp_secret'] !== null) {
			$step = Totp::verify($user['totp_secret'], $code);
			if ($step !== null && $step <= (int) $user['totp_last_step']) {
				$step = null; // code already used: replay
			}
		}

		if ($step === null) {
			$now = time();
			Db::run('INSERT INTO login_failures (key, at) VALUES (?, ?), (?, ?)', [$ipKey, $now, $userKey, $now]);
			Db::audit($user ? (int) $user['id'] : null, 'login_failed', $username);
			return null;
		}

		Db::run('UPDATE users SET totp_last_step = ? WHERE id = ?', [$step, $user['id']]);
		if (password_needs_rehash($user['password_hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_BCRYPT)) {
			Db::run('UPDATE users SET password_hash = ? WHERE id = ?', [self::hashPassword($password), $user['id']]);
		}
		Db::run('DELETE FROM login_failures WHERE key = ?', [$userKey]);
		Db::audit((int) $user['id'], 'login', '');
		self::beginSession($user);
		return $user;
	}

	/** Per-IP limit for setup and invite forms, sharing the login limit and window. */
	public static function allowAttempt(string $kind): bool
	{
		$since = time() - (int) App::config('login_window');
		Db::run('DELETE FROM login_failures WHERE at < ?', [$since]);
		$n = (int) Db::one(
			'SELECT COUNT(*) AS n FROM login_failures WHERE key = ? AND at >= ?',
			[$kind . ':ip:' . Http::clientIp(), $since]
		)['n'];
		return $n < (int) App::config('login_max_failures_per_user');
	}

	public static function recordFailure(string $kind): void
	{
		Db::run('INSERT INTO login_failures (key, at) VALUES (?, ?)', [$kind . ':ip:' . Http::clientIp(), time()]);
	}

	public static function beginSession(array $user): void
	{
		// New session id on login stops session fixation.
		session_regenerate_id(true);
		$_SESSION = [
			'csrf' => bin2hex(random_bytes(32)),
			'uid' => (int) $user['id'],
			'epoch' => (int) $user['session_epoch'],
			'login_at' => time(),
			'seen_at' => time(),
		];
	}

	public static function isSuper(?array $user): bool
	{
		return $user !== null && ($user['role'] ?? '') === 'super';
	}

	/** The logged-in user, or null. Enforces timeouts and revocation on every request. */
	public static function user(): ?array
	{
		if (self::$user !== null) {
			return self::$user;
		}
		$uid = $_SESSION['uid'] ?? null;
		if (!is_int($uid)) {
			return null;
		}
		$now = time();
		$idle = $now - (int) ($_SESSION['seen_at'] ?? 0);
		$age = $now - (int) ($_SESSION['login_at'] ?? 0);
		$user = Db::one('SELECT id, username, role, disabled, session_epoch, password_hash IS NOT NULL AS active FROM users WHERE id = ?', [$uid]);

		if (!$user || $user['disabled'] || !$user['active']
			|| (int) $user['session_epoch'] !== (int) ($_SESSION['epoch'] ?? -1)
			|| $idle > (int) App::config('session_idle_timeout')
			|| $age > (int) App::config('session_absolute_timeout')) {
			self::logout();
			return null;
		}
		$_SESSION['seen_at'] = $now;
		return self::$user = $user;
	}

	public static function logout(): void
	{
		self::$user = null;
		$_SESSION = ['csrf' => bin2hex(random_bytes(32))];
		session_regenerate_id(true);
	}

	/** Changing a password signs out every other session of that user. */
	public static function changePassword(int $userId, string $new): void
	{
		Db::run(
			'UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?',
			[self::hashPassword($new), $userId]
		);
		$_SESSION['epoch'] = (int) Db::one('SELECT session_epoch FROM users WHERE id = ?', [$userId])['session_epoch'];
		session_regenerate_id(true);
	}
}

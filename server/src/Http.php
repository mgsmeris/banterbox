<?php
declare(strict_types=1);

namespace BanterBox;

/** Response headers, sessions, CSRF and request checks. */
final class Http
{
	private const SESSION_NAME_SECURE = '__Host-bbsess';
	private const SESSION_NAME_DEV = 'bbsess';

	/** Headers for HTML pages. Strict CSP: no inline script or style, nothing third-party. */
	public static function pageHeaders(bool $private): void
	{
		header('Content-Type: text/html; charset=utf-8');
		// Admin pages may play blob: videos: the WebM to GIF converter decodes them locally.
		header("Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
			. ($private ? "media-src blob:; " : '')
			. "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
		self::commonHeaders();
		header('X-Frame-Options: DENY');
		header('Cross-Origin-Opener-Policy: same-origin');
		header('Cross-Origin-Resource-Policy: same-origin');
		header('Cache-Control: ' . ($private ? 'no-store' : 'public, max-age=60'));
	}

	public static function commonHeaders(): void
	{
		header('X-Content-Type-Options: nosniff');
		header('Referrer-Policy: same-origin');
		header('Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()');
		if (App::config('https_only')) {
			header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
		}
		header_remove('X-Powered-By');
	}

	public static function method(): string
	{
		return strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
	}

	public static function isHttps(): bool
	{
		if (!empty($_SERVER['HTTPS']) && strtolower((string) $_SERVER['HTTPS']) !== 'off') {
			return true;
		}
		return App::config('trust_proxy')
			&& strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
	}

	/** Admin pages refuse plain http in production instead of leaking a session over it. */
	public static function requireHttps(): void
	{
		if (App::config('https_only') && !self::isHttps()) {
			http_response_code(403);
			header('Content-Type: text/plain; charset=utf-8');
			exit("HTTPS is required.\n");
		}
	}

	public static function clientIp(): string
	{
		$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
		if (App::config('trust_proxy') && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
			$parts = explode(',', (string) $_SERVER['HTTP_X_FORWARDED_FOR']);
			$ip = trim(end($parts));
		}
		return filter_var($ip, FILTER_VALIDATE_IP) ? $ip : '0.0.0.0';
	}

	public static function startSession(): void
	{
		if (session_status() === PHP_SESSION_ACTIVE) {
			return;
		}
		$secure = (bool) App::config('https_only');

		ini_set('session.use_strict_mode', '1');
		ini_set('session.use_only_cookies', '1');
		ini_set('session.use_trans_sid', '0');
		ini_set('session.cookie_httponly', '1');
		if (PHP_VERSION_ID < 80400) {
			// Longer ids. PHP 8.4 deprecated these settings and already defaults to strong ids.
			ini_set('session.sid_length', '48');
			ini_set('session.sid_bits_per_character', '6');
		}
		ini_set('session.gc_maxlifetime', (string) App::config('session_absolute_timeout'));
		// Own session directory, so other sites on a shared host can't read our sessions.
		session_save_path(App::dataDir('sessions'));

		session_name($secure ? self::SESSION_NAME_SECURE : self::SESSION_NAME_DEV);
		session_set_cookie_params([
			'lifetime' => 0,
			// __Host- cookies must use Path=/ and no Domain. The cookie is still
			// HttpOnly + SameSite=Strict, so other paths on the host can't use it from JS.
			'path' => '/',
			'secure' => $secure,
			'httponly' => true,
			'samesite' => 'Strict',
		]);
		session_start();

		if (empty($_SESSION['csrf'])) {
			$_SESSION['csrf'] = bin2hex(random_bytes(32));
		}
	}

	public static function csrfToken(): string
	{
		return (string) ($_SESSION['csrf'] ?? '');
	}

	/**
	 * Every state-changing request must be a POST from our own pages:
	 * matching CSRF token, and Origin / Sec-Fetch-Site saying it came from us.
	 */
	public static function requireValidPost(): void
	{
		if (self::method() !== 'POST') {
			self::deny(405, 'Method not allowed.');
		}

		$site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? null;
		if ($site !== null && $site !== 'same-origin' && $site !== 'none') {
			self::deny(403, 'Cross-site request blocked.');
		}
		$origin = $_SERVER['HTTP_ORIGIN'] ?? null;
		if ($origin !== null && $origin !== App::origin()) {
			self::deny(403, 'Cross-site request blocked.');
		}

		$sent = $_POST['csrf'] ?? '';
		$expected = self::csrfToken();
		if (!is_string($sent) || $expected === '' || !hash_equals($expected, $sent)) {
			self::deny(403, 'Your form expired. Go back, reload the page and try again.');
		}
	}

	public static function deny(int $status, string $message): never
	{
		http_response_code($status);
		header('Content-Type: text/plain; charset=utf-8');
		header('Cache-Control: no-store');
		self::commonHeaders();
		exit($message . "\n");
	}

	/** Redirect to one of our own admin URLs. Never to anything user supplied. */
	public static function redirect(string $path): never
	{
		header('Location: ' . App::basePath() . '/' . ltrim($path, '/'), true, 303);
		exit;
	}

	public static function flash(string $type, string $message): void
	{
		$_SESSION['flash'][] = ['type' => $type === 'error' ? 'error' : 'ok', 'message' => $message];
	}

	public static function takeFlashes(): array
	{
		$f = $_SESSION['flash'] ?? [];
		unset($_SESSION['flash']);
		return is_array($f) ? $f : [];
	}

	/** A string field from $_POST, or '' if missing or not a string. */
	public static function post(string $key, int $maxLen = 200): string
	{
		$v = $_POST[$key] ?? '';
		if (!is_string($v)) {
			return '';
		}
		return mb_substr(trim($v), 0, $maxLen);
	}
}

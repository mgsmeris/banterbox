<?php
declare(strict_types=1);

namespace BanterBox;

use RuntimeException;
use Throwable;

final class App
{
	/** Used for anything config.php leaves out. config.example.php documents each one. */
	private const DEFAULTS = [
		'base_url' => '',
		'data_dir' => null, // null = <server folder>/data
		'cors_origins' => ['https://perpheads.com', 'https://www.perpheads.com'],
		'setup_token' => '',
		'allow_superuser_reset' => false,
		'https_only' => true,
		'download_url' => '',
		'login_max_failures_per_user' => 5,
		'login_max_failures_per_ip' => 20,
		'login_window' => 900,
		'session_idle_timeout' => 1800,
		'session_absolute_timeout' => 43200,
		'trust_proxy' => false,
	];

	private static array $config = [];
	private static string $root = '';
	private static string $configFile = '';

	public const PRIVATE_DIR = 'banterbox-private';

	/**
	 * Finds config.php, in this order:
	 *  1. BANTERBOX_CONFIG (process environment, used by the local test server;
	 *     web visitors can't set it).
	 *  2. banterbox-private/config.php next to the code folder, or one level higher.
	 *     That's outside anything a git deployment writes, so deploys can never
	 *     overwrite or delete it. Because config.php is PHP that gets executed, a
	 *     file there only counts if it belongs to the same system user as the code
	 *     (so another account on the server can't plant one).
	 *  3. config.php in the code folder itself (older setups; ignored by git).
	 */
	private static function locateConfig(string $root): ?string
	{
		$env = getenv('BANTERBOX_CONFIG');
		if (is_string($env) && $env !== '') {
			return is_file($env) ? $env : null;
		}
		$owner = @fileowner($root);
		$dir = dirname($root);
		for ($i = 0; $i < 2; $i++) {
			$candidate = $dir . '/' . self::PRIVATE_DIR . '/config.php';
			if (is_file($candidate) && @fileowner($candidate) === $owner) {
				return $candidate;
			}
			$parent = dirname($dir);
			if ($parent === $dir) {
				break;
			}
			$dir = $parent;
		}
		return is_file($root . '/config.php') ? $root . '/config.php' : null;
	}

	public static function configFile(): string
	{
		return self::$configFile;
	}

	/** Is $path inside the code folder (the part a git deployment manages)? */
	public static function insideCode(string $path): bool
	{
		$real = realpath($path);
		$code = realpath(self::$root);
		return $real !== false && $code !== false && self::isInside($real, $code);
	}

	public static function boot(string $root): void
	{
		self::$root = $root;
		// Never show PHP errors to visitors, even before logging is set up.
		ini_set('display_errors', '0');

		$file = self::locateConfig($root);
		if ($file === null) {
			self::fatal('config.php is missing. Put it in a banterbox-private/ folder next to the site (see config.example.php).');
		}
		self::$configFile = $file;
		$config = require $file;
		if (!is_array($config)) {
			self::fatal('config.php must return an array.');
		}
		self::$config = $config + self::DEFAULTS;
		// Data lives next to whichever config.php is used, unless config.php says otherwise.
		self::$config['data_dir'] ??= dirname($file) . '/data';

		self::$config['base_url'] = rtrim((string) self::$config['base_url'], '/');
		if (!preg_match('#^https?://[a-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$#i', self::$config['base_url'])) {
			self::fatal('base_url in config.php is not a valid URL.');
		}

		self::prepareDataDir();
		self::setupErrors();
	}

	public static function config(string $key): mixed
	{
		if (!array_key_exists($key, self::$config)) {
			throw new RuntimeException('Unknown config key: ' . $key);
		}
		return self::$config[$key];
	}

	/** The folder the web server serves (public/, wherever it was put). */
	public static function publicDir(): string
	{
		return defined('BANTERBOX_PUBLIC') ? (string) BANTERBOX_PUBLIC : self::$root . '/public';
	}

	public static function root(): string
	{
		return self::$root;
	}

	public static function dataDir(string $sub = ''): string
	{
		$dir = rtrim((string) self::$config['data_dir'], '/\\');
		return $sub === '' ? $dir : $dir . '/' . $sub;
	}

	/** Origin (scheme://host[:port]) of base_url. */
	public static function origin(): string
	{
		$p = parse_url(self::$config['base_url']);
		return $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
	}

	/** Path part of base_url, e.g. "/sb". */
	public static function basePath(): string
	{
		return rtrim((string) (parse_url(self::$config['base_url'], PHP_URL_PATH) ?? ''), '/');
	}

	public static function url(string $path = ''): string
	{
		return self::$config['base_url'] . '/' . ltrim($path, '/');
	}

	private static function prepareDataDir(): void
	{
		$data = self::dataDir();
		foreach (['', 'emojis', 'sessions', 'logs'] as $sub) {
			$dir = $sub === '' ? $data : $data . '/' . $sub;
			if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
				self::fatal('Cannot create data directory. Check data_dir in config.php and its permissions.');
			}
		}

		// Refuse to run if the data directory is reachable from the web.
		$public = realpath(self::publicDir());
		$real = realpath($data);
		$docRoot = isset($_SERVER['DOCUMENT_ROOT']) ? realpath((string) $_SERVER['DOCUMENT_ROOT']) : false;
		foreach ([$public, $docRoot] as $webRoot) {
			if ($webRoot && $real && self::isInside($real, $webRoot)) {
				self::fatal('data_dir is inside the web root. Move it outside public/ and the document root.');
			}
		}

		// Belt and braces in case the directory is ever exposed by mistake.
		$ht = $data . '/.htaccess';
		if (!is_file($ht)) {
			@file_put_contents($ht, "Require all denied\n");
		}
	}

	private static function isInside(string $path, string $dir): bool
	{
		$path = rtrim(str_replace('\\', '/', $path), '/') . '/';
		$dir = rtrim(str_replace('\\', '/', $dir), '/') . '/';
		return strncasecmp($path, $dir, strlen($dir)) === 0;
	}

	private static function setupErrors(): void
	{
		ini_set('display_errors', '0');
		ini_set('log_errors', '1');
		ini_set('error_log', self::dataDir('logs') . '/php-error.log');
		error_reporting(E_ALL);

		set_error_handler(static function (int $no, string $msg, string $file, int $line): bool {
			if (!(error_reporting() & $no)) {
				return false;
			}
			// Deprecation notices only get logged: a newer PHP version on the host
			// must never take the site down. Real warnings still stop the request.
			if ($no === E_DEPRECATED || $no === E_USER_DEPRECATED) {
				error_log('[BanterBox] Deprecated: ' . $msg . ' at ' . $file . ':' . $line);
				return true;
			}
			throw new \ErrorException($msg, 0, $no, $file, $line);
		});

		set_exception_handler(static function (Throwable $e): void {
			error_log('[BanterBox] ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
			if (!headers_sent()) {
				http_response_code(500);
				header('Content-Type: text/plain; charset=utf-8');
				header('Cache-Control: no-store');
			}
			echo "Something went wrong. The error has been logged.\n";
		});
	}

	/** Stop before anything else can run. Messages here never contain user input. */
	public static function fatal(string $message): never
	{
		if (!headers_sent()) {
			http_response_code(500);
			header('Content-Type: text/plain; charset=utf-8');
			header('Cache-Control: no-store');
		}
		if (PHP_SAPI === 'cli') {
			fwrite(STDERR, $message . "\n");
			exit(1);
		}
		error_log('[BanterBox] ' . $message);
		exit("Server misconfigured. See the error log.\n");
	}
}

<?php
declare(strict_types=1);

namespace BanterBox;

/** RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 s), as used by authenticator apps. */
final class Totp
{
	private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	private const PERIOD = 30;
	private const DIGITS = 6;

	public static function newSecret(): string
	{
		return self::base32Encode(random_bytes(20)); // 160 bits, as RFC 4226 recommends
	}

	/**
	 * Returns the matched time step, or null. Accepts one step of clock drift either
	 * way. The caller must reject steps it has already accepted (replay protection).
	 */
	public static function verify(string $secret, string $code, ?int $now = null): ?int
	{
		$code = preg_replace('/\s+/', '', $code) ?? '';
		if (!preg_match('/^\d{' . self::DIGITS . '}$/', $code)) {
			return null;
		}
		$key = self::base32Decode($secret);
		if ($key === '') {
			return null;
		}
		$step = intdiv($now ?? time(), self::PERIOD);
		$match = null;
		foreach ([-1, 0, 1] as $offset) {
			// Check every window so timing doesn't reveal which one matched.
			if (hash_equals(self::code($key, $step + $offset), $code)) {
				$match = $step + $offset;
			}
		}
		return $match;
	}

	public static function code(string $key, int $step): string
	{
		$counter = pack('J', $step);
		$hash = hash_hmac('sha1', $counter, $key, true);
		$offset = ord($hash[19]) & 0x0f;
		$bin = ((ord($hash[$offset]) & 0x7f) << 24)
			| (ord($hash[$offset + 1]) << 16)
			| (ord($hash[$offset + 2]) << 8)
			| ord($hash[$offset + 3]);
		return str_pad((string) ($bin % (10 ** self::DIGITS)), self::DIGITS, '0', STR_PAD_LEFT);
	}

	public static function uri(string $secret, string $username, string $issuer = 'BanterBox'): string
	{
		return 'otpauth://totp/' . rawurlencode($issuer . ':' . $username)
			. '?secret=' . $secret . '&issuer=' . rawurlencode($issuer)
			. '&algorithm=SHA1&digits=' . self::DIGITS . '&period=' . self::PERIOD;
	}

	public static function base32Encode(string $bin): string
	{
		$bits = '';
		foreach (str_split($bin) as $c) {
			$bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
		}
		$out = '';
		foreach (str_split($bits, 5) as $chunk) {
			$out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0'))];
		}
		return $out;
	}

	public static function base32Decode(string $b32): string
	{
		$b32 = strtoupper(rtrim($b32, '='));
		if ($b32 === '' || strspn($b32, self::ALPHABET) !== strlen($b32)) {
			return '';
		}
		$bits = '';
		foreach (str_split($b32) as $c) {
			$bits .= str_pad(decbin(strpos(self::ALPHABET, $c)), 5, '0', STR_PAD_LEFT);
		}
		$out = '';
		foreach (str_split($bits, 8) as $byte) {
			if (strlen($byte) === 8) {
				$out .= chr(bindec($byte));
			}
		}
		return $out;
	}
}

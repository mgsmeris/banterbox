<?php
declare(strict_types=1);

namespace BanterBox;

use Imagick;
use RuntimeException;

/**
 * Turns an untrusted upload into a clean emoji image.
 *
 * Safety model:
 *  - Only PNG, JPEG, GIF and WebP are accepted, detected from the bytes
 *    (finfo + magic numbers), never from the name or the browser's MIME type.
 *  - Size and pixel count are checked BEFORE decoding (no decompression bombs).
 *  - Every image is fully decoded and re-encoded. The stored file is pixels
 *    we produced ourselves, so metadata, trailing data and polyglot payloads
 *    (PHP/HTML/JS hidden in an image) are gone.
 *  - The stored file name is random hex chosen by us, with an extension picked
 *    from a fixed list. It is written outside the web root and only ever read
 *    back by e.php as bytes, never included or executed.
 */
final class Images
{
	public const MAX_BYTES = 512 * 1024;
	public const MAX_INPUT_SIDE = 1024;
	/** Every emoji is saved as exactly SIZE×SIZE pixels. */
	public const SIZE = 32;
	public const MAX_FRAMES = 150;
	public const EXTENSIONS = ['png' => 'image/png', 'gif' => 'image/gif', 'webp' => 'image/webp'];

	/**
	 * @return array{bytes:string, ext:string, width:int, height:int, animated:bool}
	 * @throws UserError with a message that is safe to show to the admin
	 */
	public static function process(string $bytes): array
	{
		$len = strlen($bytes);
		if ($len === 0) {
			throw new UserError('The file is empty.');
		}
		if ($len > self::MAX_BYTES) {
			throw new UserError('The file is larger than ' . (self::MAX_BYTES / 1024) . ' KB.');
		}

		$type = self::sniff($bytes);
		if ($type === null) {
			throw new UserError('Only PNG, JPEG, GIF and WebP images are allowed.');
		}

		$info = @getimagesizefromstring($bytes);
		if ($info === false || $info[0] < 1 || $info[1] < 1) {
			throw new UserError('That image could not be read.');
		}
		[$w, $h] = $info;
		$expected = ['png' => IMAGETYPE_PNG, 'jpeg' => IMAGETYPE_JPEG, 'gif' => IMAGETYPE_GIF, 'webp' => IMAGETYPE_WEBP][$type];
		if ($info[2] !== $expected) {
			throw new UserError('The image type does not match its contents.');
		}
		if ($w > self::MAX_INPUT_SIDE || $h > self::MAX_INPUT_SIDE) {
			throw new UserError('The image is larger than ' . self::MAX_INPUT_SIDE . '×' . self::MAX_INPUT_SIDE . ' pixels.');
		}

		$animated = ($type === 'gif' && self::gifIsAnimated($bytes))
			|| ($type === 'webp' && self::webpIsAnimated($bytes));

		return $animated ? self::reencodeAnimated($bytes, $type) : self::reencodeStatic($bytes, $type);
	}

	/** Detects the format from the bytes. Returns png|jpeg|gif|webp or null. */
	public static function sniff(string $bytes): ?string
	{
		$magic = match (true) {
			str_starts_with($bytes, "\x89PNG\r\n\x1a\n") => 'png',
			str_starts_with($bytes, "\xFF\xD8\xFF") => 'jpeg',
			str_starts_with($bytes, 'GIF87a'), str_starts_with($bytes, 'GIF89a') => 'gif',
			strlen($bytes) >= 12 && str_starts_with($bytes, 'RIFF') && substr($bytes, 8, 4) === 'WEBP' => 'webp',
			default => null,
		};
		if ($magic === null) {
			return null;
		}
		$mime = (new \finfo(FILEINFO_MIME_TYPE))->buffer($bytes);
		$expected = ['png' => 'image/png', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp'][$magic];
		return $mime === $expected ? $magic : null;
	}

	public static function imagickAvailable(): bool
	{
		return extension_loaded('imagick') && class_exists(Imagick::class);
	}

	private static function reencodeStatic(string $bytes, string $type): array
	{
		if (!function_exists('imagecreatefromstring')) {
			throw new RuntimeException('The GD extension is not installed.');
		}
		$src = @imagecreatefromstring($bytes);
		if ($src === false) {
			throw new UserError('That image could not be decoded.');
		}
		try {
			$sw = imagesx($src);
			$sh = imagesy($src);
			[$dw, $dh, $ox, $oy] = self::fit($sw, $sh);

			// A transparent SIZE×SIZE canvas with the image scaled to fit, centred.
			$dst = imagecreatetruecolor(self::SIZE, self::SIZE);
			imagealphablending($dst, false);
			imagesavealpha($dst, true);
			imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
			if (!imageistruecolor($src)) {
				imagepalettetotruecolor($src);
			}
			imagecopyresampled($dst, $src, $ox, $oy, 0, 0, $dw, $dh, $sw, $sh);

			ob_start();
			$ok = imagepng($dst, null, 9);
			$out = (string) ob_get_clean();
			unset($dst); // GD images are objects since PHP 8; imagedestroy() is deprecated in 8.5
			if (!$ok || $out === '') {
				throw new RuntimeException('PNG encoding failed.');
			}
		} finally {
			unset($src);
		}

		return ['bytes' => $out, 'ext' => 'png', 'width' => self::SIZE, 'height' => self::SIZE, 'animated' => false];
	}

	private static function reencodeAnimated(string $bytes, string $type): array
	{
		if (!self::imagickAvailable()) {
			throw new UserError('Animated images need the Imagick PHP extension on the server. Upload a still image, or ask the server admin to install Imagick.');
		}

		$format = $type === 'gif' ? 'GIF' : 'WEBP';
		if (!in_array($format, Imagick::queryFormats($format), true)) {
			throw new UserError('This server\'s Imagick cannot read ' . $format . ' images.');
		}

		Imagick::setResourceLimit(Imagick::RESOURCETYPE_MEMORY, 128 * 1024 * 1024);
		Imagick::setResourceLimit(Imagick::RESOURCETYPE_MAP, 128 * 1024 * 1024);
		Imagick::setResourceLimit(Imagick::RESOURCETYPE_AREA, 16 * 1024 * 1024);
		if (defined('Imagick::RESOURCETYPE_TIME')) {
			Imagick::setResourceLimit(Imagick::RESOURCETYPE_TIME, 20);
		}

		$im = new Imagick();
		try {
			// Force the decoder so ImageMagick never guesses the format from the content
			// (that guessing is what made "ImageTragick"-style attacks possible).
			$im->setFormat($format);
			$im->readImageBlob($bytes, 'upload.' . strtolower($format));
			if (strtoupper($im->getImageFormat()) !== $format) {
				throw new UserError('The image type does not match its contents.');
			}
			$frames = $im->getNumberImages();
			if ($frames > self::MAX_FRAMES) {
				throw new UserError('Animations can have at most ' . self::MAX_FRAMES . ' frames.');
			}

			$im = $im->coalesceImages();
			[$dw, $dh, $ox, $oy] = self::fit($im->getImageWidth(), $im->getImageHeight());
			foreach ($im as $frame) {
				// Scale to fit, then centre on a transparent SIZE×SIZE canvas.
				$frame->setImageAlphaChannel(Imagick::ALPHACHANNEL_SET);
				$frame->resizeImage($dw, $dh, Imagick::FILTER_LANCZOS, 1);
				$frame->setImageBackgroundColor(new \ImagickPixel('transparent'));
				$frame->extentImage(self::SIZE, self::SIZE, -$ox, -$oy);
				$frame->setImagePage(self::SIZE, self::SIZE, 0, 0);
				$frame->stripImage();
			}
			$out = $im->deconstructImages();
			$out->setFormat($format);
			$out->setImageFormat($format);
			$out->stripImage();
			$blob = $out->getImagesBlob();
			$out->clear();
		} catch (UserError $e) {
			throw $e;
		} catch (\ImagickException $e) {
			throw new UserError('That animation could not be decoded.');
		} finally {
			$im->clear();
		}

		if ($blob === '' || strlen($blob) > 4 * self::MAX_BYTES) {
			throw new UserError('The resized animation is too large.');
		}
		return ['bytes' => $blob, 'ext' => strtolower($format), 'width' => self::SIZE, 'height' => self::SIZE, 'animated' => true];
	}

	/**
	 * Size and offset that fit a w×h image inside the SIZE×SIZE canvas, keeping its
	 * shape (scaled up or down; never stretched). Returns [width, height, x, y].
	 */
	private static function fit(int $w, int $h): array
	{
		$scale = min(self::SIZE / $w, self::SIZE / $h);
		$dw = max(1, min(self::SIZE, (int) round($w * $scale)));
		$dh = max(1, min(self::SIZE, (int) round($h * $scale)));
		return [$dw, $dh, intdiv(self::SIZE - $dw, 2), intdiv(self::SIZE - $dh, 2)];
	}

	/** More than one graphic control extension = more than one frame. */
	private static function gifIsAnimated(string $bytes): bool
	{
		return preg_match_all('/\x21\xF9\x04.{4}\x00[\x2C\x21]/s', $bytes) > 1;
	}

	/** VP8X header with the animation flag, or an ANIM chunk. */
	private static function webpIsAnimated(string $bytes): bool
	{
		if (substr($bytes, 12, 4) === 'VP8X' && strlen($bytes) > 20 && (ord($bytes[20]) & 0x02)) {
			return true;
		}
		return str_contains(substr($bytes, 12, 64), 'ANIM');
	}
}

/** A problem caused by user input, with a message that is safe to show. */
final class UserError extends \Exception
{
}

<?php
declare(strict_types=1);

namespace BanterBox;

/** HTML output. Everything dynamic goes through e(), which escapes for HTML text and attributes. */
final class View
{
	public static function e(mixed $value): string
	{
		return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
	}

	public static function asset(string $file): string
	{
		$path = App::publicDir() . '/assets/' . $file;
		$v = is_file($path) ? substr(md5((string) filemtime($path)), 0, 8) : '0';
		return App::basePath() . '/assets/' . $file . '?v=' . $v;
	}

	public static function csrfField(): string
	{
		return '<input type="hidden" name="csrf" value="' . self::e(Http::csrfToken()) . '">';
	}

	public static function head(string $title, bool $admin = false, bool $qr = false): void
	{
		?><!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta name="referrer" content="same-origin">
	<title><?= self::e($title) ?></title>
	<link rel="icon" href="<?= self::e(self::asset('kappa-32.png')) ?>">
	<link rel="stylesheet" href="<?= self::e(self::asset('site.css')) ?>">
	<?php if ($qr): ?><script src="<?= self::e(self::asset('vendor/qrcode.js')) ?>" defer></script><?php endif ?>
	<?php if ($admin): ?><script src="<?= self::e(self::asset('admin.js')) ?>" defer></script><?php endif ?>
</head>
<body class="<?= $admin ? 'is-admin' : 'is-public' ?>">
<?php
	}

	public static function foot(): void
	{
		?>
<footer class="site-footer">
	<span>BanterBox · not affiliated with Perpheads or Siropu</span>
</footer>
</body>
</html>
<?php
	}

	public static function flashes(): void
	{
		foreach (Http::takeFlashes() as $f) {
			echo '<div class="flash flash-' . self::e($f['type']) . '" role="status">' . self::e($f['message']) . '</div>';
		}
	}
}

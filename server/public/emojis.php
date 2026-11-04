<?php
/*
 * The emoji list the extension loads: /sb/emojis.json (rewritten to emojis.php).
 * Read-only, no cookies used. CORS is limited to the origins in config.php.
 */
declare(strict_types=1);

define('BANTERBOX_PUBLIC', __DIR__);
require (require BANTERBOX_PUBLIC . '/bb-root.php') . '/src/bootstrap.php';

use BanterBox\App;
use BanterBox\Emojis;
use BanterBox\Http;

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (is_string($origin) && in_array($origin, App::config('cors_origins'), true)) {
	header('Access-Control-Allow-Origin: ' . $origin);
	header('Access-Control-Allow-Methods: GET');
}
header('Vary: Origin');

if (Http::method() === 'OPTIONS') {
	http_response_code(204);
	exit;
}
if (!in_array(Http::method(), ['GET', 'HEAD'], true)) {
	Http::deny(405, 'Method not allowed.');
}

$list = [];
foreach (Emojis::all() as $e) {
	$list[] = [
		'name' => $e['name'],
		'url' => Emojis::publicUrl($e),
		'w' => (int) $e['width'],
		'h' => (int) $e['height'],
		'animated' => (bool) $e['animated'],
	];
}
$body = json_encode(['version' => 1, 'emojis' => $list], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
$etag = '"' . substr(hash('sha256', $body), 0, 32) . '"';

Http::commonHeaders();
header('Content-Type: application/json; charset=utf-8');
header("Content-Security-Policy: default-src 'none'; sandbox");
header('Cross-Origin-Resource-Policy: cross-origin');
header('Cache-Control: public, max-age=300');
header('ETag: ' . $etag);

if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
	http_response_code(304);
	exit;
}
if (Http::method() !== 'HEAD') {
	echo $body;
}

<?php
/*
 * Serves one stored emoji: /sb/e/<32 hex>.<png|gif|webp>  (rewritten to e.php?id=..&ext=..)
 * The id and extension are validated against strict patterns, so the path can't be steered.
 */
declare(strict_types=1);

define('BANTERBOX_PUBLIC', __DIR__);
require (require BANTERBOX_PUBLIC . '/bb-root.php') . '/src/bootstrap.php';

use BanterBox\Emojis;
use BanterBox\Http;
use BanterBox\Images;

$id = $_GET['id'] ?? '';
$ext = $_GET['ext'] ?? '';
$path = is_string($id) && is_string($ext) ? Emojis::filePath($id, $ext) : null;

if (!in_array(Http::method(), ['GET', 'HEAD'], true)) {
	Http::deny(405, 'Method not allowed.');
}
if ($path === null || !is_file($path)) {
	Http::deny(404, 'Not found.');
}

Http::commonHeaders();
header('Content-Type: ' . Images::EXTENSIONS[$ext]);
header('Content-Length: ' . filesize($path));
// Even if a browser were tricked into rendering this as a document, nothing could run.
header("Content-Security-Policy: default-src 'none'; sandbox");
header('Content-Disposition: inline; filename="' . $id . '.' . $ext . '"');
// Perpheads (and anyone) may embed the image.
header('Cross-Origin-Resource-Policy: cross-origin');
header('Access-Control-Allow-Origin: *');
// File ids are random and contents never change, so cache forever.
header('Cache-Control: public, max-age=31536000, immutable');
$etag = '"' . $id . '"';
header('ETag: ' . $etag);

if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
	http_response_code(304);
	exit;
}
if (Http::method() === 'HEAD') {
	exit;
}
readfile($path);

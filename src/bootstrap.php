<?php
/*
 * Shared setup for every request: config, error handling, security headers.
 * Everything in src/ lives outside the web root and is only ever loaded by
 * require from the fixed entry points in public/.
 */
declare(strict_types=1);

namespace BanterBox;

const MIN_PHP = '8.1.0';

if (version_compare(PHP_VERSION, MIN_PHP, '<')) {
	http_response_code(500);
	exit('PHP ' . MIN_PHP . ' or newer is required.');
}

require __DIR__ . '/App.php';
require __DIR__ . '/Db.php';
require __DIR__ . '/Http.php';
require __DIR__ . '/Totp.php';
require __DIR__ . '/Auth.php';
require __DIR__ . '/Images.php';
require __DIR__ . '/Emojis.php';
require __DIR__ . '/Accounts.php';
require __DIR__ . '/View.php';

App::boot(dirname(__DIR__));

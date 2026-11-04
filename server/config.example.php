<?php
/*
 * BanterBox emoji server configuration.
 *
 * Copy this file to banterbox-private/config.php, in the folder ABOVE the site's
 * code (e.g. /var/www/<id>/banterbox-private/config.php next to sb.smeris.me/).
 * There it's outside the web root and outside anything a git deploy writes.
 * The database and emojis then live in banterbox-private/data/ automatically.
 *
 * Never commit a real config.php: .gitignore, the pre-commit hook and the
 * CI workflow all refuse it.
 */
return [
	// Public URL of the public/ directory, without a trailing slash.
	'base_url' => 'https://sb.smeris.me',

	// Where the SQLite database, uploaded emojis, sessions and logs live.
	// Must be outside the web root. The web server user needs write access.
	// Default: a data/ folder next to this config.php.
	// 'data_dir' => '/var/www/<id>/banterbox-private/data',

	// Sites allowed to fetch emojis.json from a browser (CORS).
	'cors_origins' => [
		'https://perpheads.com',
		'https://www.perpheads.com',
	],

	// First-run setup. Put a long random string here (at least 32 characters,
	// e.g. from a password manager), then open https://sb.smeris.me/admin/?a=setup
	// and enter it to create the superuser. Setup only works while no superuser
	// exists. Clear it again afterwards. Empty = setup disabled.
	'setup_token' => '',

	// Lost the superuser's password or phone? Set this to true together with a
	// setup_token: the setup page will then issue a new invite link for the
	// existing superuser. Set it back to false straight after.
	'allow_superuser_reset' => false,

	// Leave true in production. Only set false for local testing over plain http.
	'https_only' => true,

	// Login protection.
	'login_max_failures_per_user' => 5,   // within login_window seconds
	'login_max_failures_per_ip'   => 20,  // within login_window seconds
	'login_window'                => 900, // 15 minutes

	// Session lifetime.
	'session_idle_timeout'     => 1800,   // 30 minutes without activity
	'session_absolute_timeout' => 43200,  // 12 hours after login

	// Set true only if PHP runs behind a reverse proxy you control that sets
	// X-Forwarded-For. Otherwise attackers could fake their IP to dodge the
	// login rate limit.
	'trust_proxy' => false,
];

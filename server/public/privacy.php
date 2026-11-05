<?php
/* BanterBox privacy policy (linked from the extension and the store listings). */
declare(strict_types=1);

define('BANTERBOX_PUBLIC', __DIR__);
require (require BANTERBOX_PUBLIC . '/bb-root.php') . '/src/bootstrap.php';

use BanterBox\Http;
use BanterBox\View;

if (!in_array(Http::method(), ['GET', 'HEAD'], true)) {
	Http::deny(405, 'Method not allowed.');
}

Http::pageHeaders(false);
View::head('Privacy policy · BanterBox');
?>
<main class="wrap prose">
	<p><a href="./">← BanterBox</a></p>
	<h1>Privacy policy</h1>
	<p class="muted">Last updated 5 November 2026</p>

	<p>The BanterBox browser extension does not collect, store, sell or share personal data. It has no accounts, analytics, ads or tracking.</p>

	<h2>Stored in your browser only</h2>
	<ul>
		<li>Your settings: whether the BanterBox emoji list and update notices are on.</li>
		<li>Emojis you add yourself: a name and an image link.</li>
		<li>Emojis you used recently, and a copy of the BanterBox emoji list so it isn't downloaded every time.</li>
	</ul>
	<p>This never leaves your browser. Removing the extension removes it.</p>

	<h2>On Perpheads</h2>
	<p>The extension only runs on perpheads.com. It adds the emoji menu to the shoutbox and fixes some shoutbox bugs. It does not read, store or send your messages or account details. What you post goes only to Perpheads, as it would without the extension.</p>

	<h2>Requests to sb.smeris.me and GitHub</h2>
	<p>The first time you open the emoji menu, BanterBox asks whether it may:</p>
	<ul>
		<li>load the BanterBox emoji list and its images from sb.smeris.me, and</li>
		<li>check GitHub (raw.githubusercontent.com) twice a day for a new version.</li>
	</ul>
	<p>Until you answer, it makes neither request. You can change both later in the extension's menu. Firefox itself also checks GitHub for updates of the add-on, as it does for every add-on.</p>
	<p>These requests carry no cookies or identifiers. Your IP address is used by the web server only to answer the request, as any website needs to. It is not stored or used for anything else.</p>

	<h2>Other sites</h2>
	<p>Emojis you add yourself load from the link you gave, so that site receives the request. Emojis posted in the shoutbox are images, and everyone who views them loads them like any other image on the forum.</p>

	<h2>Questions</h2>
	<p>Open an issue on <a href="https://github.com/mgsmeris/banterbox/issues" rel="noopener">GitHub</a>, where the source code is too.</p>
</main>
<?php
View::foot();

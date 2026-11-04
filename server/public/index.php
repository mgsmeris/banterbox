<?php
/* BanterBox homepage and public emoji gallery. */
declare(strict_types=1);

define('BANTERBOX_PUBLIC', __DIR__);
require (require BANTERBOX_PUBLIC . '/bb-root.php') . '/src/bootstrap.php';

use BanterBox\App;
use BanterBox\Emojis;
use BanterBox\Http;
use BanterBox\View;

if (!in_array(Http::method(), ['GET', 'HEAD'], true)) {
	Http::deny(405, 'Method not allowed.');
}

$emojis = Emojis::all();
$https = static fn (string $u): string => preg_match('~^https://[^\s"<>]+$~i', $u) ? $u : '';
$firefox = $https((string) App::config('firefox_url'));
$chrome = $https((string) (App::config('download_url') ?: App::config('chrome_url')));

// Screenshots are shown only once their files are in public/assets/.
$shots = array_filter([
	['screen-menu.png', "The emoji menu in the shoutbox, in the forum's own style"],
	['screen-popup.png', 'Settings in the extension: the emoji list switch and your own emojis'],
], static fn (array $s): bool => is_file(App::publicDir() . '/assets/' . $s[0]));

Http::pageHeaders(false);
View::head('BanterBox: a better Perpheads shoutbox');
?>
<header class="hero">
	<div class="wrap hero-inner">
		<img class="hero-logo" src="<?= View::e(View::asset('kappa-128.png')) ?>" width="96" height="96" alt="">
		<div>
			<h1>BanterBox</h1>
			<p class="lead">A small browser extension that fixes the Perpheads shoutbox and gives it better emojis.</p>
			<div class="actions">
				<?php if ($firefox !== ''): ?>
					<a class="btn btn-primary" href="<?= View::e($firefox) ?>" rel="noopener">Get it for Firefox</a>
				<?php endif ?>
				<?php if ($chrome !== ''): ?>
					<a class="btn btn-primary" href="<?= View::e($chrome) ?>" rel="noopener">Get it for Chrome</a>
				<?php endif ?>
				<?php if ($shots): ?><a class="btn" href="#screenshots">Screenshots</a><?php endif ?>
				<a class="btn" href="#install">How to install</a>
				<a class="btn" href="#emojis">Browse emojis</a>
			</div>
		</div>
	</div>
</header>

<main class="wrap">
	<section class="features">
		<article class="card">
			<h2>Emoji menu</h2>
			<p>A Kappa button in the shoutbox toolbar opens a searchable menu of custom emojis, with your recently used ones first. Pick one and it goes straight into your message.</p>
		</article>
		<article class="card">
			<h2>Your own emojis</h2>
			<p>Add any image link as an emoji under a name you choose. Your list is saved in your browser and sits right next to the BanterBox emojis.</p>
		</article>
		<article class="card">
			<h2>Your choice what loads</h2>
			<p>Switch off the BanterBox emoji list and the extension makes no requests to this site at all. Your own emojis keep working.</p>
		</article>
		<article class="card">
			<h2>Fits your forum style</h2>
			<p>The menu uses the forum's own look, so it matches Core, Core Dark, every colour variant and the default style.</p>
		</article>
		<article class="card">
			<h2>Edit actually works</h2>
			<p>The shoutbox's Edit button opens the editor again, and saving updates your message without reloading the page.</p>
		</article>
		<article class="card">
			<h2>"Load more" stays put</h2>
			<p>Loading older messages no longer pushes the button into the middle of the chat.</p>
		</article>
	</section>

	<?php if ($shots): ?>
		<section id="screenshots" class="shots">
			<?php foreach ($shots as [$file, $caption]): ?>
				<figure class="card shot">
					<img src="<?= View::e(View::asset($file)) ?>" alt="<?= View::e($caption) ?>" loading="lazy">
					<figcaption><?= View::e($caption) ?></figcaption>
				</figure>
			<?php endforeach ?>
		</section>
	<?php endif ?>

	<section id="install" class="card install">
		<h2>Install</h2>
		<ol>
			<li><strong>Firefox:</strong> <?php if ($firefox !== ''): ?><a href="<?= View::e($firefox) ?>" rel="noopener">download the signed add-on</a><?php else: ?>download the signed add-on<?php endif ?> and open it in Firefox (or drag it onto a Firefox window), then click <em>Add</em>. It updates by itself.</li>
			<li><strong>Chrome, Edge, Brave:</strong> download the <code>chrome.zip</code> file<?php if ($chrome !== ''): ?> from <a href="<?= View::e($chrome) ?>" rel="noopener">the latest release</a><?php endif ?> and unzip it. Open <code>chrome://extensions</code>, turn on <em>Developer mode</em>, click <em>Load unpacked</em> and pick the unzipped folder.</li>
			<li>Reload Perpheads. The Kappa button appears in the shoutbox toolbar.</li>
			<li>Click the BanterBox icon in your browser's toolbar for the settings: the emoji list switch and your own emojis.</li>
		</ol>
		<p class="muted">Emojis are posted as normal images, so everyone sees them, even without the extension.</p>
	</section>

	<section id="emojis">
		<div class="section-head">
			<h2>Emojis <span class="count"><?= count($emojis) ?></span></h2>
		</div>
		<?php if (!$emojis): ?>
			<p class="muted">No emojis yet.</p>
		<?php else: ?>
			<ul class="emoji-grid">
				<?php foreach ($emojis as $e): ?>
					<li>
						<img src="<?= View::e(Emojis::publicUrl($e)) ?>" width="<?= (int) $e['width'] ?>" height="<?= (int) $e['height'] ?>" alt=":<?= View::e($e['name']) ?>:" loading="lazy">
						<span>:<?= View::e($e['name']) ?>:</span>
					</li>
				<?php endforeach ?>
			</ul>
		<?php endif ?>
	</section>
</main>
<?php
View::foot();

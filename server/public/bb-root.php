<?php
/*
 * Where the BanterBox server folder (the one with src/ and config.php) lives.
 *
 * Default: one level up from this public/ folder. If you copied public/ into your
 * web root (e.g. public_html/sb/) and put the rest outside it, change this to that
 * folder's absolute path, e.g. return '/home/you/banterbox-sb';
 *
 * This file is never served: .htaccess refuses every .php file except the entry points.
 */
return dirname(__DIR__);

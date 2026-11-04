<?php
declare(strict_types=1);

namespace BanterBox;

use PDO;

/** SQLite access. Every query goes through prepared statements. */
final class Db
{
	private static ?PDO $pdo = null;

	public static function pdo(): PDO
	{
		if (self::$pdo === null) {
			$file = App::dataDir() . '/banterbox.sqlite';
			$pdo = new PDO('sqlite:' . $file, null, null, [
				PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
				PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
				PDO::ATTR_EMULATE_PREPARES => false,
			]);
			$pdo->exec('PRAGMA foreign_keys = ON');
			$pdo->exec('PRAGMA journal_mode = WAL');
			$pdo->exec('PRAGMA busy_timeout = 5000');
			self::migrate($pdo);
			self::$pdo = $pdo;
		}
		return self::$pdo;
	}

	public static function all(string $sql, array $params = []): array
	{
		$st = self::pdo()->prepare($sql);
		$st->execute($params);
		return $st->fetchAll();
	}

	public static function one(string $sql, array $params = []): ?array
	{
		$st = self::pdo()->prepare($sql);
		$st->execute($params);
		$row = $st->fetch();
		return $row === false ? null : $row;
	}

	public static function run(string $sql, array $params = []): int
	{
		$st = self::pdo()->prepare($sql);
		$st->execute($params);
		return $st->rowCount();
	}

	public static function lastId(): int
	{
		return (int) self::pdo()->lastInsertId();
	}

	private static function migrate(PDO $pdo): void
	{
		$version = (int) $pdo->query('PRAGMA user_version')->fetchColumn();
		if ($version < 1) {
			$pdo->exec(<<<'SQL'
				CREATE TABLE IF NOT EXISTS users (
					id            INTEGER PRIMARY KEY,
					username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
					role          TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super', 'admin')),
					password_hash TEXT,            -- NULL until the invite is accepted
					totp_secret   TEXT,            -- NULL until the invite is accepted
					totp_last_step INTEGER NOT NULL DEFAULT 0,
					disabled      INTEGER NOT NULL DEFAULT 0,
					session_epoch INTEGER NOT NULL DEFAULT 0,
					created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
					created_at    INTEGER NOT NULL
				);
				-- At most one superuser.
				CREATE UNIQUE INDEX IF NOT EXISTS users_one_super ON users(role) WHERE role = 'super';
				CREATE TABLE IF NOT EXISTS invites (
					id          INTEGER PRIMARY KEY,
					user_id     INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
					token_hash  TEXT NOT NULL UNIQUE, -- sha256 of the token; the token itself is never stored
					totp_secret TEXT NOT NULL,
					expires_at  INTEGER NOT NULL,
					created_at  INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS emojis (
					id         INTEGER PRIMARY KEY,
					name       TEXT NOT NULL UNIQUE,
					file_id    TEXT NOT NULL UNIQUE,
					ext        TEXT NOT NULL,
					width      INTEGER NOT NULL,
					height     INTEGER NOT NULL,
					animated   INTEGER NOT NULL DEFAULT 0,
					bytes      INTEGER NOT NULL,
					sha256     TEXT NOT NULL UNIQUE,
					created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
					created_at INTEGER NOT NULL
				);
				CREATE TABLE IF NOT EXISTS login_failures (
					id  INTEGER PRIMARY KEY,
					key TEXT NOT NULL,
					at  INTEGER NOT NULL
				);
				CREATE INDEX IF NOT EXISTS login_failures_key_at ON login_failures(key, at);
				CREATE TABLE IF NOT EXISTS audit (
					id      INTEGER PRIMARY KEY,
					user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
					action  TEXT NOT NULL,
					detail  TEXT NOT NULL DEFAULT '',
					ip      TEXT NOT NULL DEFAULT '',
					at      INTEGER NOT NULL
				);
				PRAGMA user_version = 1;
				SQL);
		}
	}

	public static function audit(?int $userId, string $action, string $detail = ''): void
	{
		self::run(
			'INSERT INTO audit (user_id, action, detail, ip, at) VALUES (?, ?, ?, ?, ?)',
			[$userId, $action, mb_substr($detail, 0, 500), Http::clientIp(), time()]
		);
	}
}

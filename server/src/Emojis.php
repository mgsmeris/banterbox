<?php
declare(strict_types=1);

namespace BanterBox;

/** Emoji records and their files. */
final class Emojis
{
	public const NAME_RE = '/^[a-z0-9_]{2,32}$/';
	public const FILE_ID_RE = '/^[a-f0-9]{32}$/';

	public static function all(): array
	{
		return Db::all('SELECT e.*, u.username AS uploader FROM emojis e LEFT JOIN users u ON u.id = e.created_by ORDER BY e.name');
	}

	public static function normalizeName(string $name): string
	{
		$name = strtolower(trim($name, " \t\n\r\0\x0B:"));
		return (string) preg_replace('/[^a-z0-9_]+/', '_', $name);
	}

	/** Suggest a name from an uploaded file name, e.g. "Pog Champ.png" -> "pog_champ". */
	public static function nameFromFilename(string $filename): string
	{
		$base = pathinfo($filename, PATHINFO_FILENAME);
		return mb_substr(trim(self::normalizeName($base), '_'), 0, 32);
	}

	public static function validName(string $name): bool
	{
		return (bool) preg_match(self::NAME_RE, $name);
	}

	public static function publicUrl(array $e): string
	{
		return App::url('e/' . $e['file_id'] . '.' . $e['ext']);
	}

	/** Absolute path for a stored file. Both parts are re-validated so no input can steer the path. */
	public static function filePath(string $fileId, string $ext): ?string
	{
		if (!preg_match(self::FILE_ID_RE, $fileId) || !array_key_exists($ext, Images::EXTENSIONS)) {
			return null;
		}
		return App::dataDir('emojis') . '/' . $fileId . '.' . $ext;
	}

	/** @throws UserError */
	public static function create(string $name, string $uploadBytes, int $userId): array
	{
		if (!self::validName($name)) {
			throw new UserError('Names can only use a-z, 0-9 and _, and must be 2 to 32 characters.');
		}
		if (Db::one('SELECT 1 FROM emojis WHERE name = ?', [$name])) {
			throw new UserError('An emoji called :' . $name . ': already exists.');
		}

		$img = Images::process($uploadBytes);
		$sha = hash('sha256', $img['bytes']);
		$dupe = Db::one('SELECT name FROM emojis WHERE sha256 = ?', [$sha]);
		if ($dupe) {
			throw new UserError('That image is already uploaded as :' . $dupe['name'] . ':.');
		}

		$fileId = bin2hex(random_bytes(16));
		$path = self::filePath($fileId, $img['ext']);
		$tmp = $path . '.tmp';
		if (file_put_contents($tmp, $img['bytes'], LOCK_EX) !== strlen($img['bytes']) || !rename($tmp, $path)) {
			@unlink($tmp);
			throw new \RuntimeException('Could not write emoji file.');
		}
		@chmod($path, 0640);

		try {
			Db::run(
				'INSERT INTO emojis (name, file_id, ext, width, height, animated, bytes, sha256, created_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
				[$name, $fileId, $img['ext'], $img['width'], $img['height'], (int) $img['animated'],
				 strlen($img['bytes']), $sha, $userId, time()]
			);
		} catch (\PDOException $e) {
			@unlink($path);
			throw new UserError('That name or image was just added by someone else.');
		}
		Db::audit($userId, 'upload', ':' . $name . ': ' . $fileId . '.' . $img['ext']);
		return Db::one('SELECT * FROM emojis WHERE file_id = ?', [$fileId]);
	}

	/** @throws UserError */
	public static function rename(int $id, string $name, int $userId): void
	{
		$e = Db::one('SELECT * FROM emojis WHERE id = ?', [$id]);
		if (!$e) {
			throw new UserError('That emoji no longer exists.');
		}
		if (!self::validName($name)) {
			throw new UserError('Names can only use a-z, 0-9 and _, and must be 2 to 32 characters.');
		}
		if ($name === $e['name']) {
			return;
		}
		if (Db::one('SELECT 1 FROM emojis WHERE name = ?', [$name])) {
			throw new UserError('An emoji called :' . $name . ': already exists.');
		}
		Db::run('UPDATE emojis SET name = ? WHERE id = ?', [$name, $id]);
		Db::audit($userId, 'rename', ':' . $e['name'] . ': -> :' . $name . ':');
	}

	public static function delete(int $id, int $userId): ?string
	{
		$e = Db::one('SELECT * FROM emojis WHERE id = ?', [$id]);
		if (!$e) {
			return null;
		}
		Db::run('DELETE FROM emojis WHERE id = ?', [$id]);
		$path = self::filePath($e['file_id'], $e['ext']);
		if ($path !== null && is_file($path)) {
			@unlink($path);
		}
		Db::audit($userId, 'delete', ':' . $e['name'] . ':');
		return $e['name'];
	}
}

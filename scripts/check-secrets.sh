#!/usr/bin/env bash
# Refuses settings, data and secrets in git.
#
#   scripts/check-secrets.sh            check what's staged (used by the pre-commit hook)
#   scripts/check-secrets.sh --all      check every tracked file (used by the GitHub Action)
#
# A line that must contain something secret-looking on purpose (e.g. a dummy
# hash in the code) can be allowed with the marker: banterbox-allow-secret
set -u

mode="${1:-staged}"
fail=0
say() { printf '  %s\n' "$*" >&2; }

if [ "$mode" = "--all" ]; then
	files=$(git ls-files)
else
	files=$(git diff --cached --name-only --diff-filter=ACMR)
fi
[ -z "$files" ] && exit 0

# 1. Files that must never be in git, whatever they contain.
forbidden='(^|/)config\.php$|(^|/)banterbox-private/|(^|/)data/|\.sqlite($|-)|\.db$|(^|/)sess_|\.log$|(^|/)\.env($|\.)|\.(pem|key|p12|pfx|secret)$|(^|/)tests/\.data/'
bad_files=$(printf '%s\n' "$files" | grep -E "$forbidden" || true)
if [ -n "$bad_files" ]; then
	echo "BLOCKED: these files hold settings or data and must never be committed:" >&2
	printf '%s\n' "$bad_files" | while read -r f; do say "$f"; done
	fail=1
fi

# 2. Contents that look like secrets.
patterns=(
	"'setup_token'[[:space:]]*=>[[:space:]]*'[^']+'"   # a filled-in setup token
	"\\\$2[aby]\\\$[0-9]{2}\\\$[./A-Za-z0-9]{53}"          # bcrypt password hash
	"\\\$argon2(id|i|d)\\\$"                                # argon2 password hash
	"otpauth://totp/[^\"' ]*secret=[A-Z2-7]{16,}"          # authenticator secret
	"-----BEGIN [A-Z ]*PRIVATE KEY-----"                    # private keys
	"(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}"        # GitHub tokens
	"AKIA[0-9A-Z]{16}"                                      # AWS keys
	"SQLite format 3"                                       # a database file  banterbox-allow-secret
)

# File contents, from the staging area or the working tree.
read_file() {
	if [ "$mode" = "--all" ]; then cat -- "$1" 2>/dev/null; else git show ":$1" 2>/dev/null; fi
}

while IFS= read -r f; do
	[ -n "$f" ] || continue
	for p in "${patterns[@]}"; do
		hits=$(read_file "$f" | grep -nEa -- "$p" | tr -d '\000' | grep -v 'banterbox-allow-secret' || true)
		if [ -n "$hits" ]; then
			echo "BLOCKED: $f looks like it contains a secret:" >&2
			printf '%s\n' "$hits" | cut -c1-160 | while read -r h; do say "$h"; done
			fail=1
		fi
	done
done <<< "$files"

if [ "$fail" -ne 0 ]; then
	echo "" >&2
	echo "Nothing was committed. Remove these from the commit (git rm --cached <file>)." >&2
	echo "Settings belong in banterbox-private/config.php on the server, never in git." >&2
	exit 1
fi
exit 0

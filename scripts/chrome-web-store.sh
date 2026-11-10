#!/usr/bin/env bash
# Uploads dist/banterbox-chrome.zip to the Chrome Web Store and submits it for
# review, with automatic publishing as soon as Google approves it.
# Run by CI; uses the Chrome Web Store API V2 with a service account.
#
# Needs these environment variables (GitHub secrets):
#   CWS_PUBLISHER_ID         Chrome Web Store Developer Dashboard > Account: Publisher ID
#   CWS_EXTENSION_ID         the 32-letter item ID of BanterBox
#   CWS_SERVICE_ACCOUNT_KEY  the service account's JSON key file, pasted whole
#
# Signs in the way Google documents for service accounts: a JWT signed with the key,
# exchanged for an access token
# (https://developers.google.com/identity/protocols/oauth2/service-account).
#
# Does nothing if the store already has this version (published or in review). If an
# older version is still waiting for review, that submission is replaced by this one.
set -euo pipefail

clean() { printf %s "$1" | tr -d '[:space:]'; }
PUB=$(clean "$CWS_PUBLISHER_ID")
ITEM=$(clean "$CWS_EXTENSION_ID")
ZIP=dist/banterbox-chrome.zip
VERSION=$(node -p "require('./extension/manifest.json').version")
API=https://chromewebstore.googleapis.com
NAME="publishers/$PUB/items/$ITEM"
SCOPE=https://www.googleapis.com/auth/chromewebstore

if ! [[ "$ITEM" =~ ^[a-p]{32}$ ]]; then
	echo "::error::CWS_EXTENSION_ID should be the 32-letter extension ID (letters a to p) from the Chrome Web Store."
	exit 1
fi

# ---------------------------------------------------------------- access token
email=$(jq -r '.client_email // empty' <<<"$CWS_SERVICE_ACCOUNT_KEY" 2>/dev/null || true)
if [ -z "$email" ]; then
	echo "::error::CWS_SERVICE_ACCOUNT_KEY should be the whole JSON key file of the service account (it contains client_email and private_key)."
	exit 1
fi
keyfile=$(mktemp)
trap 'rm -f "$keyfile"' EXIT
jq -r '.private_key' <<<"$CWS_SERVICE_ACCOUNT_KEY" > "$keyfile"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s)
header=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
claims=$(jq -cn --arg iss "$email" --arg scope "$SCOPE" --argjson iat "$now" --argjson exp "$((now + 3600))" \
	'{iss: $iss, scope: $scope, aud: "https://oauth2.googleapis.com/token", iat: $iat, exp: $exp}' | b64url)
signature=$(printf '%s.%s' "$header" "$claims" | openssl dgst -sha256 -sign "$keyfile" | b64url)

token=$(curl -sS https://oauth2.googleapis.com/token \
	--data-urlencode grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer \
	--data-urlencode "assertion=$header.$claims.$signature" | jq -r '.access_token // empty')
if [ -z "$token" ]; then
	echo "::error::Google refused the service account key. Check CWS_SERVICE_ACCOUNT_KEY (paste the whole JSON file)."
	exit 1
fi
echo "::add-mask::$token"
call() { curl -fsS -H "Authorization: Bearer $token" "$@"; }
status() { call "$API/v2/$NAME:fetchStatus"; }

# ---------------------------------------------------------------- what the store has
if ! st=$(status); then
	echo "::error::The Chrome Web Store refused access. Check CWS_PUBLISHER_ID and CWS_EXTENSION_ID, and that $email is added under Account in the Developer Dashboard."
	exit 1
fi
versions() { jq -r --arg k "$1" '.[$k].distributionChannels[]?.crxVersion // empty' <<<"$st"; }
published=$(versions publishedItemRevisionStatus | head -1)
submitted=$(versions submittedItemRevisionStatus | head -1)
submitted_state=$(jq -r '.submittedItemRevisionStatus.state // empty' <<<"$st")
echo "Store: published ${published:-none}, submitted ${submitted:-none} (${submitted_state:-no submission}), this build $VERSION"

if [ "$published" = "$VERSION" ] || [ "$submitted" = "$VERSION" ]; then
	echo "Version $VERSION is already in the Chrome Web Store, nothing to do."
	exit 0
fi

# The store only accepts a version higher than the one it has.
newest=$(printf '%s\n' "$published" "$submitted" | sed '/^$/d' | sort -V | tail -1)
if [ -n "$newest" ] && [ "$(printf '%s\n%s\n' "$newest" "$VERSION" | sort -V | tail -1)" != "$VERSION" ]; then
	echo "::error::The Chrome Web Store already has version $newest. Give extension/manifest.json a higher version than that (now $VERSION)."
	exit 1
fi

# Only one submission can wait for review; the newest one wins.
if [ "$submitted_state" = PENDING_REVIEW ] || [ "$submitted_state" = STAGED ]; then
	echo "Replacing the waiting submission of $submitted with $VERSION."
	call -X POST -H 'Content-Length: 0' "$API/v2/$NAME:cancelSubmission" >/dev/null
fi

# ---------------------------------------------------------------- upload and submit
up=$(call -X POST -H 'Content-Type: application/zip' --data-binary "@$ZIP" "$API/upload/v2/$NAME:upload")
state=$(jq -r '.uploadState // empty' <<<"$up")
for _ in $(seq 1 30); do
	case "$state" in
		*PROGRESS*) sleep 5; state=$(status | jq -r '.lastAsyncUploadState // empty') ;;
		*) break ;;
	esac
done
case "$state" in
	*SUCC*) echo "Uploaded $VERSION." ;;
	*)
		echo "::error::Chrome Web Store upload ended in state '$state'."
		echo "$up"
		exit 1
		;;
esac

# No body: by default the item is published as soon as the review passes.
pub=$(curl -sS -w '\n%{http_code}' -X POST -H "Authorization: Bearer $token" -H 'Content-Length: 0' "$API/v2/$NAME:publish")
code=${pub##*$'\n'}
pub=${pub%$'\n'*}
if [ "$code" != 200 ]; then
	echo "::error::The Chrome Web Store did not accept the submission (HTTP $code); Google's answer is below. $VERSION is uploaded as a draft: fix what Google says and re-run this job, or press 'Submit for review' in the Developer Dashboard."
	echo "$pub"
	exit 1
fi
echo "$pub" | jq '{state, warnings: .warningInfo.warnings}'
echo "Submitted $VERSION for review; it goes live automatically once Google approves it."

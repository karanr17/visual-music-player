#!/usr/bin/env bash
# Fails if tracked files contain API keys, email addresses, or personal listening-history exports.
#
#   scripts/check-secrets.sh            scan the files tracked at HEAD (plus the index)
#   scripts/check-secrets.sh --history  scan every commit reachable from any ref
#
# Uses only git + POSIX ERE so it runs the same on macOS and the CI runner without installs.
set -uo pipefail

mode="${1:-tree}"
fail=0

KEY_PATTERNS=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                  # Anthropic
  'sk-(proj-)?[A-Za-z0-9_-]{32,}'              # OpenAI
  'AIza[0-9A-Za-z_-]{35}'                      # Google
  'gh[pousr]_[A-Za-z0-9]{36}'                  # GitHub tokens
  'github_pat_[A-Za-z0-9_]{40,}'
  'AKIA[0-9A-Z]{16}'                           # AWS access key id
  'xox[abprs]-[A-Za-z0-9-]{10,}'               # Slack
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
)
EMAIL_PATTERN='[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'
# Placeholder domains are fine; anything else is treated as personal data.
EMAIL_ALLOW='@(example\.(com|org|net)|users\.noreply\.github\.com)'
# Google Takeout / Spotify / YouTube history exports, and committed env files.
PATH_PATTERN='(^|[/:])(Takeout|takeout)(/|$)|(^|[/:])(watch-history|search-history|MyActivity|StreamingHistory[^/]*|endsong[^/]*|Streaming_History[^/]*)\.(json|html|csv)$|(^|[/:])\.env($|\.)'
PATH_ALLOW='(^|[/:])\.env\.example$'

# This file necessarily contains the patterns it looks for.
SELF='scripts/check-secrets.sh'

if [[ "$mode" == "--history" ]]; then
  revs=$(git rev-list --all)
else
  revs=""
fi

grep_content() {
  local pattern="$1" only="${2:-}"
  if [[ -n "$revs" ]]; then
    # shellcheck disable=SC2086
    git grep -nIE $only -e "$pattern" $revs -- . ":(exclude)$SELF"
  else
    git grep -nIE $only --cached -e "$pattern" -- . ":(exclude)$SELF"
  fi
}

report() {
  echo "::error::$1"
  sed 's/^/    /' <<<"$2"
  fail=1
}

for p in "${KEY_PATTERNS[@]}"; do
  hits=$(grep_content "$p")
  [[ -n "$hits" ]] && report "Possible API key or private key ($p)" "$hits"
done

# -o so an allowed address on the same line cannot hide a real one.
emails=$(grep_content "$EMAIL_PATTERN" -o | grep -vE "$EMAIL_ALLOW")
[[ -n "$emails" ]] && report "Email address committed" "$emails"

if [[ -n "$revs" ]]; then
  # shellcheck disable=SC2086
  paths=$(for r in $revs; do git ls-tree -r --name-only "$r" | sed "s|^|$r:|"; done)
else
  paths=$(git ls-files --cached)
fi
bad_paths=$(grep -E "$PATH_PATTERN" <<<"$paths" | grep -vE "$PATH_ALLOW")
[[ -n "$bad_paths" ]] && report "Env file or listening-history export committed" "$bad_paths"

if [[ $fail -eq 0 ]]; then
  echo "check-secrets: no keys, emails or history exports found ($mode)."
fi
exit $fail

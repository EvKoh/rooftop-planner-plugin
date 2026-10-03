#!/bin/bash
# Refuses (exit 1) when the git history contains anything that looks personal or names the
# real trip the plugin was first built for. Run before every push:  scripts/check-history.sh && git push
# Patterns come from the environment (PRIVATE_PATTERNS) so the list itself stays out of the repo.
set -euo pipefail
PAT="${PRIVATE_PATTERNS:?set PRIVATE_PATTERNS to an extended regex}"
# Accepted, already-public commits (never rewritten: main is protected, history stays as is).
#  b56b101 — a comment quoted a real farm's public business name as an example. Not personal
#            data, and that trip is published elsewhere by its owner; reviewed 2026-10-03.
ALLOW_COMMITS="b56b101"
hits=$(git log -p --all --format='@@commit %h' -- . ':!package-lock.json' ':!scripts/check-history.sh' \
  | awk -v allow=" $ALLOW_COMMITS " '/^@@commit /{skip = index(allow, " " $2 " ") > 0; next} !skip' \
  | grep -E '^\+' | grep -vE '^\+\+\+' | grep -E "$PAT" | grep -vE '@vitest|@media|@param|@deprecated|noreply|@clack' || true)
lock=$(git log -p --all --format= -- package-lock.json | grep -E '/home/|file:' || true)
trailers=$(git log --all --format=%B | grep -i 'co-authored' || true)
authors=$(git log --all --format='%ae %ce' | sort -u)
if [ -n "$hits$lock$trailers" ] || [ "$authors" != "1309463+EvKoh@users.noreply.github.com 1309463+EvKoh@users.noreply.github.com" ]; then
  printf '%s\n%s\n%s\n%s\n' "$hits" "$lock" "$trailers" "$authors" | sed '/^$/d' | cut -c1-160
  echo "history check FAILED"; exit 1
fi
echo "history check ok"

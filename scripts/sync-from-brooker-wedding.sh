#!/usr/bin/env bash
# Ports Maple commits that landed in brooker-wedding since the last sync, until the family
# moves to maplebaby.app and Maple's code leaves brooker-wedding. Delete this script then.
set -euo pipefail
BW="${BW:-$HOME/dev/brooker-wedding}"
MARK="$(dirname "$0")/../.brooker-wedding-sync"
FROM="$(cat "$MARK")"
git -C "$BW" fetch -q origin
TO="$(git -C "$BW" rev-parse origin/main)"
[ "$FROM" = "$TO" ] && { echo "Up to date at $TO"; exit 0; }
PATCHES="$(mktemp -d)"
git -C "$BW" format-patch -q -o "$PATCHES" "$FROM..$TO" -- \
  src/lib/maple src/components/maple src/app/maple src/app/api/maple \
  docs/maple.md scripts/maple-care-check.ts scripts/maple-feed-check.ts \
  'public/maple*'
if ls "$PATCHES"/*.patch >/dev/null 2>&1; then git am -3 "$PATCHES"/*.patch; fi
echo "$TO" > "$MARK"
git add "$MARK"
git commit -qm "Sync Maple from brooker-wedding through ${TO:0:7}"
echo "Ported $(ls "$PATCHES" | wc -l | tr -d ' ') commit(s). Check brooker-wedding's CLAUDE.md Maple section by hand:"
git -C "$BW" diff --stat "$FROM" "$TO" -- CLAUDE.md src/lib/migrate.ts

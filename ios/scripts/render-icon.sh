#!/usr/bin/env bash
# Quick Look renders the SVG with WebKit; ImageMagick's built-in SVG reader drops the leaf's gradient.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
svg="$here/../public/maple-icon.svg"
out="$here/Maple/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sed -e '/<style>/d' -e '/<!--/d' -e 's/ rx="22"//' \
  -e 's/viewBox="0 0 100 100"/viewBox="0 0 100 100" width="1024" height="1024"/' \
  "$svg" > "$work/icon.svg"
qlmanage -t -s 1024 -o "$work" "$work/icon.svg" > /dev/null
magick "$work/icon.svg.png" -background '#FDF8F0' -alpha remove -alpha off -resize 1024x1024! "$out"
echo "Wrote $out"

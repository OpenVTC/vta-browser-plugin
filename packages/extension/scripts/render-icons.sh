#!/usr/bin/env sh
# Render the extension's icon.svg to the PNG sizes Chrome/Brave MV3
# expects. SVG is the source of truth — Chrome's MV3 toolbar icon
# (`action.default_icon`) requires PNG; the extensions-page card also
# falls back to the puzzle-piece placeholder when fed only SVG.
#
# Requires `rsvg-convert` from librsvg (Homebrew: `brew install librsvg`).
# Not auto-run from `npm run build` — librsvg isn't part of the
# extension's npm dep graph, and the PNGs are committed alongside the
# SVG so a fresh checkout doesn't need the tool. Re-run this only when
# `icon.svg` actually changes.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PUBLIC_DIR=$(cd "$SCRIPT_DIR/../public" && pwd)
SRC="$PUBLIC_DIR/icon.svg"

if [ ! -f "$SRC" ]; then
  echo "render-icons: $SRC not found" >&2
  exit 1
fi

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "render-icons: rsvg-convert not on PATH. Install with 'brew install librsvg' (macOS) or your package manager's libsvg/librsvg2-bin." >&2
  exit 1
fi

for size in 16 32 48 128; do
  out="$PUBLIC_DIR/icon-${size}.png"
  rsvg-convert -w "$size" -h "$size" "$SRC" -o "$out"
  echo "rendered $out"
done

#!/usr/bin/env bash
# Regenerates the Scan app icons, the web icons and the launch screens from the
# Scan mark in public/icon-512.png. Run it after changing the mark; it writes the
# files in place. macOS only: it uses sips, which ships with the OS.
#
# The mark sits on the icon's own background (#061A24), so a framed mark has no
# visible edge. The Android foreground and the maskable web icons keep the mark
# inside their safe zones; the launch screens centre it at 22% of the shorter side.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/public/icon-512.png"
BG=061A24
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# mark_on_canvas OUT MARK_PX WIDTH HEIGHT: the mark, centred on a WIDTH x HEIGHT canvas.
mark_on_canvas() {
  sips -z "$2" "$2" "$SRC" --out "$TMP/mark.png" >/dev/null
  sips -p "$4" "$3" --padColor "$BG" "$TMP/mark.png" --out "$1" >/dev/null
}

ios="$ROOT/mobile/ios/App/App"
android="$ROOT/mobile/android/app/src/main/res"

# iOS: one 1024 px marketing icon, no alpha (the source is RGB).
sips -z 1024 1024 "$SRC" --out "$ios/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png" >/dev/null

# iOS launch screen: three scales of the same 2732 px square.
for f in splash-2732x2732.png splash-2732x2732-1.png splash-2732x2732-2.png; do
  mark_on_canvas "$ios/Assets.xcassets/Splash.imageset/$f" 601 2732 2732
done

# Android legacy launcher icons, square and round, per density.
for pair in mdpi:48 hdpi:72 xhdpi:96 xxhdpi:144 xxxhdpi:192; do
  dir=${pair%%:*}; px=${pair##*:}
  for name in ic_launcher.png ic_launcher_round.png; do
    sips -z "$px" "$px" "$SRC" --out "$android/mipmap-$dir/$name" >/dev/null
  done
done

# Android adaptive foreground: 108 dp per density, mark at 84 dp (inside the 72 dp safe zone).
for pair in mdpi:108 hdpi:162 xhdpi:216 xxhdpi:324 xxxhdpi:432; do
  dir=${pair%%:*}; dp_px=${pair##*:}
  mark_on_canvas "$android/mipmap-$dir/ic_launcher_foreground.png" $(( dp_px * 7 / 9 )) "$dp_px" "$dp_px"
done

# Android launch screens: the mark at 22% of the shorter side, centred.
while read -r path w h; do
  short=$(( w < h ? w : h ))
  mark_on_canvas "$android/$path" $(( short * 22 / 100 )) "$w" "$h"
done <<'EOF'
drawable/splash.png 480 320
drawable-port-mdpi/splash.png 320 480
drawable-port-hdpi/splash.png 480 800
drawable-port-xhdpi/splash.png 720 1280
drawable-port-xxhdpi/splash.png 960 1600
drawable-port-xxxhdpi/splash.png 1280 1920
drawable-land-mdpi/splash.png 480 320
drawable-land-hdpi/splash.png 800 480
drawable-land-xhdpi/splash.png 1280 720
drawable-land-xxhdpi/splash.png 1600 960
drawable-land-xxxhdpi/splash.png 1920 1280
EOF

# Web: the apple-touch icon, and maskable icons with the mark in the 80% safe zone.
sips -z 180 180 "$SRC" --out "$ROOT/public/apple-touch-icon.png" >/dev/null
mark_on_canvas "$ROOT/public/icon-maskable-512.png" 410 512 512
mark_on_canvas "$ROOT/public/icon-maskable-192.png" 154 192 192

echo "native and web art written from public/icon-512.png"

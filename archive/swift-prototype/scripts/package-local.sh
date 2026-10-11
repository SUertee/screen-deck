#!/bin/zsh
set -euo pipefail

# Fresh, isolated output each time; no deletion or overwrite of installed apps.
screen_deck_root="${0:A:h:h}"
screen_deck_build="$(mktemp -d /tmp/screendeck-package-build.XXXXXX)"
screen_deck_output="$(mktemp -d /tmp/screendeck-package.XXXXXX)"
cd "$screen_deck_root"
swift build -c release --scratch-path "$screen_deck_build"
screen_deck_binary_dir="$(swift build -c release --scratch-path "$screen_deck_build" --show-bin-path)"
screen_deck_app="$screen_deck_output/ScreenDeck.app"
mkdir -p "$screen_deck_app/Contents/MacOS"
mkdir -p "$screen_deck_app/Contents/Resources"
cp "$screen_deck_binary_dir/ScreenDeck" "$screen_deck_app/Contents/MacOS/ScreenDeck"
cp "$screen_deck_root/Resources/Info.plist" "$screen_deck_app/Contents/Info.plist"
cp "$screen_deck_root/Resources/ThirdPartyNotices.md" "$screen_deck_app/Contents/Resources/ThirdPartyNotices.md"
cp -R "$screen_deck_root/Resources/Schemas" "$screen_deck_app/Contents/Resources/Schemas"
codesign --force --sign - "$screen_deck_app"
codesign --verify --strict "$screen_deck_app"
printf '\nLocal preview: %s\n' "$screen_deck_app"
printf 'Build files: %s\n' "$screen_deck_build"
printf 'Quit the previous ScreenDeck instance before opening this preview.\n'

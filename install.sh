#!/bin/bash
# Installs Beam.app on a Mac from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/DhananjaySarathe/beam-file-transfer/main/install.sh | bash
#
# Why a script: Beam is not signed with a paid Apple developer certificate, so a copy
# downloaded in a browser is blocked by macOS until you allow it in System Settings.
# A copy fetched here with curl is not marked that way, so it opens normally.
# This script only downloads Beam's own release file and copies Beam.app into place;
# read it before you run it.
set -euo pipefail

REPO="DhananjaySarathe/beam-file-transfer"
DEST="${BEAM_INSTALL_DIR:-/Applications}"

[ "$(uname -s)" = "Darwin" ] || { echo "This installer is for macOS. On other systems, run Beam from the source: https://github.com/$REPO"; exit 1; }
case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "Unknown Mac type: $(uname -m)"; exit 1 ;;
esac

echo "Finding the latest Beam release..."
TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$TAG" ] || { echo "Could not read the latest release from GitHub. Try again in a minute."; exit 1; }
VERSION="${TAG#v}"
URL="https://github.com/$REPO/releases/download/$TAG/Beam-$VERSION-$ARCH.dmg"

WORK="$(mktemp -d)"
MOUNT="$WORK/mount"
cleanup() {
  hdiutil detach -quiet "$MOUNT" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Downloading Beam $VERSION for $ARCH (about 120 MB)..."
curl -fL --progress-bar -o "$WORK/Beam.dmg" "$URL"

mkdir -p "$MOUNT"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$MOUNT" "$WORK/Beam.dmg"
[ -d "$MOUNT/Beam.app" ] || { echo "The download did not contain Beam.app."; exit 1; }

if pgrep -xq Beam; then
  echo "Beam is open. Quit it and run this again."
  exit 1
fi

mkdir -p "$DEST"
if [ ! -w "$DEST" ]; then
  echo "No permission to write to $DEST. Run again with:  BEAM_INSTALL_DIR=\"\$HOME/Applications\" bash"
  exit 1
fi
rm -rf "$DEST/Beam.app"
ditto "$MOUNT/Beam.app" "$DEST/Beam.app"
# In case an earlier browser download left its mark on this copy.
xattr -dr com.apple.quarantine "$DEST/Beam.app" 2>/dev/null || true

echo
echo "Beam $VERSION is in $DEST."
echo "macOS will ask once whether Beam may accept incoming connections: choose Allow."
if [ -z "${BEAM_NO_OPEN:-}" ]; then
  open "$DEST/Beam.app"
fi

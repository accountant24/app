#!/bin/sh
# Fetches the default plugin's skills (the desktop installs accountant24/skills
# on first launch) at a pinned commit, so every eval run loads the same ones.
set -eu
REPO=https://github.com/accountant24/skills
COMMIT=51039551e4eff46efb2404ca17a6e4b56fcf4ead
DEST="$(dirname "$0")/../.cache/skills"
rm -rf "$DEST"
git clone -q "$REPO" "$DEST"
git -C "$DEST" checkout -q "$COMMIT"
echo "skills at $COMMIT in $DEST"

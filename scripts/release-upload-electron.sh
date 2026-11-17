#!/usr/bin/env bash
# Adds electron-builder's output (dist/) to the GitHub release for TAG, making a draft if there is none yet.
# electron-builder's own publishing (--publish always) skips every file when the release isn't a plain draft, e.g.
# when the Windows job already made it a pre-release draft for a test version, and still reports success: so the
# builds run with --publish never and this uploads. Spaces become dashes, the names latest-*.yml point to.
# Usage: TAG=v1.2.3 GH_TOKEN=... GH_REPO=owner/repo scripts/release-upload-electron.sh
set -euo pipefail
: "${TAG:?TAG is not set}"
version="${TAG#v}"
out="$(mktemp -d)"
shopt -s nullglob
files=(dist/*.dmg dist/*.zip dist/*.AppImage dist/*.blockmap dist/latest*.yml dist/beta*.yml dist/alpha*.yml)
if [ ${#files[@]} -eq 0 ]; then echo "nothing in dist/ to upload"; exit 1; fi
for f in "${files[@]}"; do b="$(basename "$f")"; cp "$f" "$out/${b// /-}"; done
ls -la "$out"
pre=""; case "$TAG" in *-*) pre="--prerelease";; esac
for i in 1 2 3; do
  gh release view "$TAG" > /dev/null 2>&1 || gh release create "$TAG" --draft $pre --title "$version" --notes "" || true
  gh release upload "$TAG" "$out"/* --clobber && exit 0
  echo "upload failed (try $i of 3), trying again in 20 seconds"; sleep 20
done
exit 1

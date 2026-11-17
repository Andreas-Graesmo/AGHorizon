#!/bin/bash
# The complete corresponding source of the ffmpeg the Windows app ships (MIGRATION_PLAN.md 5.9, Option B):
# BtbN/FFmpeg-Builds' ffmpeg 8.1 win64 GPL build from autobuild-2026-10-31-12-59. Everything in it is pinned in
# BtbN's scripts at that commit, so this fetches exactly those sources:
#   ffmpeg-builds-<commit>.tar.xz   BtbN's scripts, patches and Dockerfiles at that commit (how it was built)
#   ffmpeg-<commit>.tar.xz          FFmpeg itself (release/8.1 at that commit)
#   <stage>.tar.xz                  each library enabled for win64 / gpl / 8.1, fetched by BtbN's own download step
#   SHA256SUMS, README.txt
# Needs: Linux, git, docker, xz. Usage: scripts/ffmpeg-source.sh <out dir>
# The pins must match FFMPEG in scripts/tauri-prep.js.
set -euo pipefail

BTBN_COMMIT=5031c6f1082414e53688d39e521849905071070d
FFMPEG_REF=8dca1586f4                 # n8.1.3-27-g8dca1586f4, on release/8.1
FFMPEG_BRANCH=release/8.1
TARGET=win64; VARIANT=gpl; ADDIN=8.1

OUT="$(realpath -m "${1:?usage: scripts/ffmpeg-source.sh <out dir>}")"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$OUT"

echo "== BtbN/FFmpeg-Builds at $BTBN_COMMIT"
git init -q "$WORK/btbn"
git -C "$WORK/btbn" fetch -q --depth 1 https://github.com/BtbN/FFmpeg-Builds.git "$BTBN_COMMIT"
git -C "$WORK/btbn" checkout -q FETCH_HEAD
git -C "$WORK/btbn" archive --format=tar --prefix="ffmpeg-builds-$BTBN_COMMIT/" HEAD | xz -T0 -9 > "$OUT/ffmpeg-builds-$BTBN_COMMIT.tar.xz"

echo "== the stages enabled for $TARGET $VARIANT $ADDIN"
cd "$WORK/btbn"
bash -c "
  source util/vars.sh $TARGET $VARIANT $ADDIN >/dev/null
  for STAGE in scripts.d/*.sh scripts.d/*/*.sh; do
    ( SELF=\"\$STAGE\"; source util/dl_functions.sh; source \"\$STAGE\"; ffbuild_enabled && echo \"\$STAGE\" ) || true
  done" > "$WORK/stages.txt"
echo "$(wc -l < "$WORK/stages.txt") stages"

echo "== their sources, through BtbN's own download step (only those stages)"
# download.sh fetches every stage; give it just this build's
sed -i 's#for STAGE in scripts.d/\*.sh scripts.d/\*/\*.sh; do#for STAGE in $(cat "'"$WORK"'/stages.txt"); do#' download.sh
grep -q 'stages.txt' download.sh || { echo "download.sh has changed: cannot limit it to this build's stages"; exit 1; }
# its Docker image is BtbN's: util/vars.sh names it after GITHUB_REPOSITORY, which in our CI is this repository
GITHUB_REPOSITORY=btbn/ffmpeg-builds ./download.sh
for f in .cache/downloads/*_*.tar.xz; do
  name="$(basename "$f" | sed -E 's/_[0-9a-f]{64}\.tar\.xz$//')"
  cp "$f" "$OUT/$name.tar.xz"
done

echo "== FFmpeg $FFMPEG_REF"
git init -q "$WORK/ffmpeg"
git -C "$WORK/ffmpeg" fetch -q --depth 300 https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_BRANCH"
FULL="$(git -C "$WORK/ffmpeg" rev-parse "$FFMPEG_REF")"
git -C "$WORK/ffmpeg" archive --format=tar --prefix="ffmpeg-$FULL/" "$FULL" | xz -T0 -9 > "$OUT/ffmpeg-$FULL.tar.xz"

cat > "$OUT/README.txt" <<EOF
Source code of the ffmpeg program shipped with AG Horizon for Windows (the Tauri app, from 3.x).

The program is ffmpeg n8.1.3-27-g8dca1586f4, win64 GPL, as built by BtbN/FFmpeg-Builds
(https://github.com/BtbN/FFmpeg-Builds) in autobuild-2026-10-31-12-59:
  ffmpeg-n8.1.3-27-g8dca1586f4-win64-gpl-8.1.zip
  sha256 401dffcf14c301082e1fc03b0bc876b92ea676bfc521fc56e80a1537d137034f
  ffmpeg.exe sha256 c46215f8889634396f0ac0acac738ef2145175e5b6caf28b3daa8ac9a9980c5f
It is licensed under the GNU General Public License version 3 (see LICENSE in ffmpeg-$FULL.tar.xz).

Contents:
  ffmpeg-$FULL.tar.xz                     FFmpeg ($FFMPEG_BRANCH at $FULL)
  ffmpeg-builds-$BTBN_COMMIT.tar.xz       the build scripts, patches and Dockerfiles used, at that commit
                                          (./build.sh $TARGET $VARIANT $ADDIN builds the same program)
  <stage>.tar.xz                          the source of each library in this build, one per build stage, as
                                          fetched by that commit's download.sh (scripts.d/<stage>.sh names the
                                          upstream repository and the exact commit)
  SHA256SUMS                              checksums of all of the above

Made by scripts/ffmpeg-source.sh in https://github.com/Andreas-Graesmo/AGHorizon.
EOF

cd "$OUT"
sha256sum -- *.tar.xz README.txt > SHA256SUMS
ls -la "$OUT"
du -sh "$OUT"

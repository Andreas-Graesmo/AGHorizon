#!/bin/bash
# ffmpeg for the macOS app (one universal program: Apple silicon and Intel), built from pinned sources (MIGRATION_PLAN.md 9.8, owner's decision
# 2026-11-18: BtbN/FFmpeg-Builds has no macOS builds). The same FFmpeg commit as the Windows and Linux builds, and
# the libraries the app needs at the exact versions BtbN pins at the same commit (scripts.d/<stage>.sh):
#   x264    H.264 encoding (compatibility mode converts to H.264)      GPL v2+
#   dav1d   AV1 decoding                                                BSD-2-Clause
#   OpenSSL https inputs (ffmpeg opens the provider's URL itself)       Apache-2.0 (GPL v3 compatible)
# plus macOS's own VideoToolbox, AudioToolbox, zlib, bzip2 and iconv (system libraries). Everything is linked
# statically except those, so the program runs on any Mac with macOS 12 or later; the build stops if it links
# anything else. The licence is GPL v3 (--enable-gpl --enable-version3, as BtbN's).
# Built once on each kind of Mac, natively (ffmpeg-macos.yml), then the two joined into one program with lipo:
#   scripts/ffmpeg-macos.sh <out dir>        on this Mac's processor (arm64 or x86_64), writing:
#     ffmpeg-<ffmpeg version>-macos-<arch>.tar.xz   ffmpeg, LICENSE (GPL v3), BUILD-INFO.txt (versions, configure line)
#     source/                                       the complete corresponding source: each package as fetched, and
#                                                   this script; SHA256SUMS (the same for both: the same pins)
#   scripts/ffmpeg-macos.sh --combine <arm64 .tar.xz> <x86_64 .tar.xz> <out dir>
#     ffmpeg-<ffmpeg version>-macos-universal.tar.xz   both in one program, with both BUILD-INFO texts
# Needs: macOS, Xcode command line tools, git, meson, ninja, pkg-config; on Intel also nasm (x264 and dav1d).
set -euo pipefail

FFMPEG_COMMIT=8dca1586f4                     # n8.1.3-27-g8dca1586f4, on release/8.1 (= scripts/tauri-prep.js)
FFMPEG_VERSION=n8.1.3-27-g8dca1586f4        # what `git describe` gives with the tags (a shallow checkout has none)
FFMPEG_BRANCH=release/8.1
BTBN_COMMIT=5031c6f1082414e53688d39e521849905071070d
X264_COMMIT=0480cb05fa188d37ae87e8f4fd8f1aea3711f7ee   # BtbN scripts.d/50-x264.sh
DAV1D_COMMIT=b8b2d726b4b78a2fb174cb45baff441b5969672c  # BtbN scripts.d/50-dav1d.sh
OPENSSL_TAG=openssl-3.6.5                              # BtbN scripts.d/25-openssl.sh
export MACOSX_DEPLOYMENT_TARGET=12.0

[ "$(uname -s)" = Darwin ] || { echo "run this on macOS"; exit 1; }

# the two builds joined into one universal program
if [ "${1:-}" = --combine ]; then
  A="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; X="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"
  mkdir -p "$4"; OUT="$(cd "$4" && pwd)"
  WORK="$(mktemp -d)"; trap 'rm -rf -- "$WORK"' EXIT
  tar -C "$WORK" -xJf "$A"; tar -C "$WORK" -xJf "$X"
  DA="$(basename "$A" .tar.xz)"; DX="$(basename "$X" .tar.xz)"
  NAME="${DA%-arm64}-universal"
  mkdir -p "$WORK/$NAME"
  lipo -create "$WORK/$DA/ffmpeg" "$WORK/$DX/ffmpeg" -output "$WORK/$NAME/ffmpeg"
  lipo -info "$WORK/$NAME/ffmpeg"
  cmp -s "$WORK/$DA/LICENSE" "$WORK/$DX/LICENSE" || { echo "the two builds have different licences"; exit 1; }
  cp "$WORK/$DA/LICENSE" "$WORK/$NAME/LICENSE"
  { echo "One program for Apple silicon (arm64) and Intel (x86_64): the two builds below, joined with lipo."; echo
    echo "== arm64"; cat "$WORK/$DA/BUILD-INFO.txt"; echo; echo "== x86_64"; cat "$WORK/$DX/BUILD-INFO.txt"; } > "$WORK/$NAME/BUILD-INFO.txt"
  tar -C "$WORK" -cJf "$OUT/$NAME.tar.xz" "$NAME"
  (cd "$OUT" && shasum -a 256 "$NAME.tar.xz")
  shasum -a 256 "$WORK/$NAME/ffmpeg"
  exit 0
fi
ARCH="$(uname -m)"   # arm64 or x86_64
OUT="$(cd "$(dirname "${1:?usage: scripts/ffmpeg-macos.sh <out dir>}")" && pwd)/$(basename "$1")"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
PREFIX="$WORK/prefix"
SRC="$OUT/source"
mkdir -p "$OUT" "$SRC" "$PREFIX"
JOBS="$(sysctl -n hw.ncpu)"

echo "== the pins are BtbN's at $BTBN_COMMIT"
git init -q "$WORK/btbn"
git -C "$WORK/btbn" fetch -q --depth 1 https://github.com/BtbN/FFmpeg-Builds.git "$BTBN_COMMIT"
git -C "$WORK/btbn" checkout -q FETCH_HEAD
grep -q "SCRIPT_COMMIT=\"$X264_COMMIT\"" "$WORK/btbn/scripts.d/50-x264.sh"
grep -q "SCRIPT_COMMIT=\"$DAV1D_COMMIT\"" "$WORK/btbn/scripts.d/50-dav1d.sh"
grep -q "SCRIPT_COMMIT=\"$OPENSSL_TAG\"" "$WORK/btbn/scripts.d/25-openssl.sh"

# fetch <name> <repo> <ref> [depth]: a checkout in $WORK/<name>, and its source as published
fetch() {
  git init -q "$WORK/$1"
  git -C "$WORK/$1" fetch -q --depth "${4:-1}" "$2" "$3"
  git -C "$WORK/$1" checkout -q FETCH_HEAD
  local full; full="$(git -C "$WORK/$1" rev-parse HEAD)"
  git -C "$WORK/$1" archive --format=tar --prefix="$1-$full/" HEAD | xz -T0 -9 > "$SRC/$1-$full.tar.xz"
  echo "$1 $3 → $full"
}
echo "== sources"
fetch openssl https://github.com/openssl/openssl.git "refs/tags/$OPENSSL_TAG"
fetch x264 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
fetch dav1d https://code.videolan.org/videolan/dav1d.git "$DAV1D_COMMIT"
# FFmpeg: the branch, then the commit on it (a short hash can't be fetched by itself)
git init -q "$WORK/ffmpeg"
git -C "$WORK/ffmpeg" fetch -q --depth 300 https://github.com/FFmpeg/FFmpeg.git "$FFMPEG_BRANCH"
FFMPEG_FULL="$(git -C "$WORK/ffmpeg" rev-parse "$FFMPEG_COMMIT")"
git -C "$WORK/ffmpeg" checkout -q "$FFMPEG_FULL"
# ffmpeg -version names this, as the Windows and Linux builds do (ffbuild/version.sh reads a VERSION file first)
echo "$FFMPEG_VERSION" > "$WORK/ffmpeg/VERSION"
git -C "$WORK/ffmpeg" archive --format=tar --prefix="ffmpeg-$FFMPEG_FULL/" --add-file="$WORK/ffmpeg/VERSION" HEAD | xz -T0 -9 > "$SRC/ffmpeg-$FFMPEG_FULL.tar.xz"
cp "$0" "$SRC/ffmpeg-macos.sh"

echo "== OpenSSL"
(cd "$WORK/openssl" && ./Configure darwin64-$ARCH-cc no-shared no-tests no-docs no-apps --prefix="$PREFIX" --libdir=lib > /dev/null \
  && make -j"$JOBS" > /dev/null && make install_sw > /dev/null)
echo "== x264"
(cd "$WORK/x264" && ./configure --prefix="$PREFIX" --enable-static --disable-cli --enable-pic --disable-lavf --disable-swscale > /dev/null \
  && make -j"$JOBS" > /dev/null && make install-lib-static > /dev/null)
echo "== dav1d"
(cd "$WORK/dav1d" && meson setup build --prefix="$PREFIX" --libdir=lib --buildtype=release --default-library=static \
  -Denable_tools=false -Denable_tests=false > /dev/null && ninja -C build install > /dev/null)

echo "== FFmpeg"
# --disable-autodetect: nothing from Homebrew or elsewhere on this Mac gets in by itself; only what is listed
CONF=(--prefix="$PREFIX" --enable-gpl --enable-version3 --enable-static --disable-shared --pkg-config-flags=--static
  --disable-autodetect --enable-libx264 --enable-libdav1d --enable-openssl
  --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-bzlib --enable-iconv
  --disable-ffplay --disable-ffprobe --disable-doc --disable-debug
  --extra-cflags="-I$PREFIX/include" --extra-ldflags="-L$PREFIX/lib"
  --extra-libs=-liconv)   # macOS's libiconv: --disable-autodetect leaves it out of the link (found on CI)
(cd "$WORK/ffmpeg" && PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure "${CONF[@]}" > "$WORK/configure.log" 2>&1 \
  || { tail -40 ffbuild/config.log; exit 1; })
(cd "$WORK/ffmpeg" && make -j"$JOBS" ffmpeg > /dev/null)
BIN="$WORK/ffmpeg/ffmpeg"
strip "$BIN"

echo "== checks"
# only macOS's own libraries and frameworks
if otool -L "$BIN" | tail -n +2 | grep -vE '^\s+(/usr/lib/|/System/Library/Frameworks/)'; then echo "ffmpeg links a library macOS doesn't have"; exit 1; fi
"$BIN" -hide_banner -version | head -1
for need in "libx264" "aac "; do "$BIN" -hide_banner -encoders 2>/dev/null | grep -q " $need" || { echo "no $need encoder"; exit 1; }; done
"$BIN" -hide_banner -decoders 2>/dev/null | grep -q libdav1d || { echo "no libdav1d decoder"; exit 1; }
"$BIN" -hide_banner -protocols 2>/dev/null | grep -qx '  https' || { echo "no https"; exit 1; }
"$BIN" -hide_banner -loglevel error -f lavfi -i testsrc2=size=320x180:rate=25:duration=2 -f lavfi -i sine=d=2 \
  -c:v libx264 -c:a aac -f mp4 -y "$WORK/check.mp4"
[ -s "$WORK/check.mp4" ]

VERSION="$("$BIN" -hide_banner -version | head -1 | awk '{print $3}')"
NAME="ffmpeg-$VERSION-macos-$ARCH"
mkdir -p "$WORK/$NAME"
cp "$BIN" "$WORK/$NAME/ffmpeg"
cp "$WORK/ffmpeg/COPYING.GPLv3" "$WORK/$NAME/LICENSE"
{
  echo "ffmpeg $VERSION for macOS 12+ on $ARCH, built by scripts/ffmpeg-macos.sh (AG Horizon)."
  echo "Licence: GNU GPL version 3 (LICENSE). The complete corresponding source is published with it (source/)."
  echo
  echo "FFmpeg   $FFMPEG_BRANCH at $FFMPEG_FULL"
  echo "x264     $X264_COMMIT"
  echo "dav1d    $DAV1D_COMMIT"
  echo "OpenSSL  $OPENSSL_TAG"
  echo "(the library versions are BtbN/FFmpeg-Builds' pins at $BTBN_COMMIT)"
  echo "macOS SDK $(xcrun --show-sdk-version), $(clang --version | head -1)"
  echo
  echo "configure ${CONF[*]}" | sed "s#$PREFIX#<prefix>#g"
} > "$WORK/$NAME/BUILD-INFO.txt"
tar -C "$WORK" -cJf "$OUT/$NAME.tar.xz" "$NAME"
(cd "$SRC" && shasum -a 256 -- * > SHA256SUMS)
(cd "$OUT" && shasum -a 256 "$NAME.tar.xz")
shasum -a 256 "$BIN"
ls -la "$OUT" "$SRC"

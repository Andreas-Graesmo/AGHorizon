#!/bin/bash
# The source of every Ubuntu package the Linux AppImage bundles (MIGRATION_PLAN.md 9.8, owner's decision 2026-11-18):
# WebKitGTK, GTK, GLib, GStreamer and its plugins, gst-libav with libavcodec, x264, x265 and the rest. Several are
# GPL or LGPL, which oblige us to offer their source with the program. It must run on the system that built the
# AppImage (the same packages, at the same versions, are installed there).
#   MANIFEST.txt   each bundled file → the package it came from → that package's source package and version
#   <source package files>   .dsc, .orig.tar.*, .debian.tar.* (or .diff.gz), from Ubuntu's archive (apt-get source)
#   SHA256SUMS
# Not covered here: the app's own programs (ag-horizon, aghorizon-server) and ffmpeg (BtbN's: its source is the
# ffmpeg source release, scripts/ffmpeg-source.sh).
# Usage: scripts/appimage-sources.sh <AppImage> <out dir> [--list-only]
set -euo pipefail

APPIMAGE="$(realpath "${1:?usage: scripts/appimage-sources.sh <AppImage> <out dir> [--list-only]}")"
OUT="$(realpath -m "${2:?usage: scripts/appimage-sources.sh <AppImage> <out dir> [--list-only]}")"
LIST_ONLY="${3:-}"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$OUT"

echo "== what the AppImage bundles"
(cd "$WORK" && "$APPIMAGE" --appimage-extract > /dev/null)
ROOT="$WORK/squashfs-root"
# every file in it but the app's own programs and BtbN's ffmpeg, the page (public/) and the desktop file and icons
find "$ROOT/usr" -type f \
  ! -path "$ROOT/usr/bin/ag-horizon" ! -path "$ROOT/usr/bin/aghorizon-server" ! -path "$ROOT/usr/bin/ffmpeg" \
  ! -path "$ROOT/usr/lib/AG Horizon/*" ! -path "$ROOT/usr/share/applications/*" ! -path "$ROOT/usr/share/icons/*" \
  | sed "s#^$ROOT/##" | sort > "$WORK/files.txt"
echo "$(wc -l < "$WORK/files.txt") files"

echo "== which package each came from"
# every installed package's files: by full path (files kept where they were, e.g. usr/share/doc/<package>/copyright)
# and, for those linuxdeploy moved (libraries: /usr/lib/x86_64-linux-gnu/x → usr/lib/x), by file name
for l in /var/lib/dpkg/info/*.list; do
  pkg="$(basename "$l" .list)"
  sed "s#^#$pkg\t#" "$l"
done > "$WORK/all.tsv"
awk -F'\t' '!($2 in seen) { seen[$2] = 1; print $2 "\t" $1 }' "$WORK/all.tsv" > "$WORK/bypath.tsv"
# where the dynamic linker (and so linuxdeploy) finds a library first: the system's library folders. A program may
# ship its own copy under the same name (Firefox, on GitHub's runners, has libnss3.so and others in /usr/lib/firefox),
# and that copy is not the one bundled. Anything else only if no system folder has the name.
awk -F'\t' '
  $2 ~ /\/lib\// { n = $2; sub(/.*\//, "", n); if (n == "") next
    sys = ($2 ~ /^\/(usr\/)?lib\/(x86_64-linux-gnu\/)?[^\/]+$/ || $2 ~ /^\/(usr\/)?lib\/x86_64-linux-gnu\/(gstreamer-1\.0|gstreamer1\.0\/gstreamer-1\.0|gdk-pixbuf-2\.0|gtk-3\.0|gio|webkit2gtk-4\.1)\//)
    if (sys && !(n in s)) s[n] = $1; else if (!sys && !(n in o)) o[n] = $1 }
  END { for (n in s) print n "\t" s[n]; for (n in o) if (!(n in s)) print n "\t" o[n] }' "$WORK/all.tsv" > "$WORK/byname.tsv"
: > "$WORK/map.tsv"; : > "$WORK/unknown.txt"
while IFS= read -r f; do
  pkg="$(awk -F'\t' -v p="/$f" '$1 == p { print $2; exit }' "$WORK/bypath.tsv")"
  case "$f" in usr/lib/*|usr/bin/*) [ -n "$pkg" ] || pkg="$(awk -F'\t' -v n="$(basename "$f")" '$1 == n { print $2; exit }' "$WORK/byname.tsv")";; esac
  # usr/share/doc/<package>/…: a package's own copyright file, under a folder Ubuntu may have made a symlink
  if [ -z "$pkg" ] && [[ "$f" =~ ^usr/share/doc/([^/]+)/ ]] && dpkg-query -W "${BASH_REMATCH[1]}" > /dev/null 2>&1; then
    pkg="${BASH_REMATCH[1]}"
  fi
  if [ -n "$pkg" ]; then printf '%s\t%s\n' "$f" "$pkg" >> "$WORK/map.tsv"; else echo "$f" >> "$WORK/unknown.txt"; fi
done < "$WORK/files.txt"

# each binary package's source package and version
cut -f2 "$WORK/map.tsv" | sort -u > "$WORK/pkgs.txt"
: > "$WORK/sources.tsv"
while IFS= read -r p; do
  printf '%s\t%s\n' "$p" "$(dpkg-query -W -f='${source:Package}\t${source:Version}' "$p")" >> "$WORK/sources.tsv"
done < "$WORK/pkgs.txt"
cut -f2,3 "$WORK/sources.tsv" | sort -u > "$WORK/srcpkgs.tsv"

{
  echo "Third-party software bundled in the AG Horizon Linux AppImage ($(basename "$APPIMAGE"))"
  echo "Built on $(. /etc/os-release && echo "$PRETTY_NAME"); every file below comes from that system's packages."
  echo "The source of each source package below is published next to this file (apt-get source, Ubuntu's archive)."
  echo
  echo "== source packages ($(wc -l < "$WORK/srcpkgs.tsv"))"
  sed 's/\t/ /' "$WORK/srcpkgs.tsv"
  echo
  echo "== bundled file → binary package → source package version"
  while IFS=$'\t' read -r f p; do
    printf '%s\t%s\t%s\n' "$f" "$p" "$(awk -F'\t' -v p="$p" '$1 == p { print $2 " " $3; exit }' "$WORK/sources.tsv")"
  done < "$WORK/map.tsv"
  if [ -s "$WORK/unknown.txt" ]; then
    echo
    echo "== bundled files from no package (added by the AppImage tools: linuxdeploy, its GTK/GStreamer hooks, AppRun)"
    cat "$WORK/unknown.txt"
  fi
} > "$OUT/MANIFEST.txt"
echo "$(wc -l < "$WORK/map.tsv") files from $(wc -l < "$WORK/pkgs.txt") packages, $(wc -l < "$WORK/srcpkgs.tsv") source packages; $(wc -l < "$WORK/unknown.txt") from no package"

if [ "$LIST_ONLY" = "--list-only" ]; then exit 0; fi

# Ubuntu's archive index only lists a package's newest version. When the build machine has an older one installed (a
# runner image made before the latest update), apt-get can't find it: then take that exact version from Launchpad,
# which keeps every version Ubuntu published, and check each file against the .dsc's SHA-256.
launchpad_source() {
  local src="$1" ver="$2" bare="${2#*:}" base dsc
  for v in "$ver" "$bare"; do
    base="https://launchpad.net/ubuntu/+archive/primary/+sourcefiles/$src/$v"
    dsc="${src}_${bare}.dsc"
    curl -fsSL --retry 3 -o "$dsc" "$base/$dsc" || continue
    awk '/^Checksums-Sha256:/ { on = 1; next } /^[^ ]/ { on = 0 } on && NF == 3 { print $1 "  " $3 }' "$dsc" > "$WORK/dsc.sha256"
    [ -s "$WORK/dsc.sha256" ] || { echo "no checksums in $dsc"; return 1; }
    while read -r _ f; do curl -fsSL --retry 3 -o "$f" "$base/$f" || return 1; done < "$WORK/dsc.sha256"
    sha256sum -c --quiet "$WORK/dsc.sha256" || return 1
    return 0
  done
  return 1
}

echo "== their sources (apt-get source, needs deb-src entries; else Launchpad)"
cd "$OUT"
while IFS=$'\t' read -r src ver; do
  apt-get source --download-only -qq "$src=$ver" 2> /dev/null && continue
  echo "$src $ver: not in the archive's index, from Launchpad"
  launchpad_source "$src" "$ver" || { echo "could not fetch the source of $src $ver"; exit 1; }
done < "$WORK/srcpkgs.tsv"
sha256sum -- * | grep -v ' SHA256SUMS$' > SHA256SUMS
du -sh "$OUT"

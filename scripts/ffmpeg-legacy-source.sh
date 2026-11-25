#!/bin/bash
# The sources of the ffmpeg builds AG Horizon shipped before 3.1, best effort (MIGRATION_PLAN.md 5.9): gyan.dev 6.1.1
# (Windows), John Van Sickle's 7.0.2 (Linux) and osxexperts.net's 6.0 (Mac), all through ffmpeg-static 5.3.0 (b6.1.1).
# Their makers publish no build scripts and don't pin every library, so this fetches what can be known: FFmpeg and each
# library at the version the build names, and where it names none, the one current at the time
# (scripts/ffmpeg-legacy-sources.txt says which is which).
#   <name>-<version>.tar.xz (git) or the release archive as published (url, debsrc: a folder's files, tarred)
#   build-*   each build's own README and configuration, and the sha256 of the binary that was shipped
#   SHA256SUMS, README.txt (what each file is, for which build, exact or nearest; what couldn't be fetched)
# Needs: Linux, git, curl, xz, python3. Usage: scripts/ffmpeg-legacy-source.sh <out dir>
set -uo pipefail

LIST="${LIST:-$(dirname "$0")/ffmpeg-legacy-sources.txt}"
OUT="$(realpath -m "${1:?usage: scripts/ffmpeg-legacy-source.sh <out dir>}")"
WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT
mkdir -p "$OUT"
STATIC=https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1
declare -A DONE      # file -> already fetched (the same source serves several builds)
ROWS=(); MISSING=(); EXACT_MISSING=0

# HTTP/1.1: snapshot.debian.org breaks HTTP/2 streams now and then
fetch() { curl -fsSL --http1.1 --retry 6 --retry-all-errors --retry-delay 10 --connect-timeout 30 -o "$1" "$2"; }

# a repository's tree at a ref, as <file>: tags and full or short commits
git_archive() {   # <file> <repo> <ref | date> <kind>
  local file="$1" repo="$2" ref="$3" kind="$4" dir="$WORK/git" rev
  rm -rf "$dir"
  git clone -q --filter=blob:none --no-checkout "$repo" "$dir" || return 1
  case "$kind" in
    git)     rev="$(git -C "$dir" rev-parse -q --verify "$ref^{commit}")" || return 1 ;;
    gitdate) rev="$(git -C "$dir" rev-list -1 --before="$ref" HEAD)" ;;
    x264rev) rev="$(git -C "$dir" rev-list --reverse HEAD | sed -n "${ref}p")"
             # x264's version number counts the commits up to it: check it against the commit found
             [ "$(git -C "$dir" rev-list --count "$rev")" = "$ref" ] || return 1 ;;
  esac
  [ -n "$rev" ] || return 1
  echo "   $repo $ref -> $rev"
  git -C "$dir" archive --format=tar --prefix="${file%.tar.xz}/" "$rev" | xz -T0 -6 > "$OUT/$file" || return 1
  echo "$rev" > "$WORK/rev"
}

# a Debian source package (its .dsc, original archive and Debian changes), from snapshot.debian.org
debsrc() {   # <file> <package> <version>
  local file="$1" pkg="$2" ver="$3" dir="$WORK/deb/${file%.tar}" hash fname
  mkdir -p "$dir"
  fetch "$WORK/deb.json" "https://snapshot.debian.org/mr/package/$pkg/$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$ver")/srcfiles?fileinfo=1" || return 1
  python3 - "$WORK/deb.json" > "$WORK/deb.list" <<'EOF' || return 1
import json, sys
d = json.load(open(sys.argv[1]))
for h in d['result']:
    print(h['hash'], d['fileinfo'][h['hash']][0]['name'])
EOF
  [ -s "$WORK/deb.list" ] || return 1
  while read -r hash fname; do fetch "$dir/$fname" "https://snapshot.debian.org/file/$hash" || return 1; done < "$WORK/deb.list"
  tar -C "$WORK/deb" -cf "$OUT/$file" "${file%.tar}"
}

echo "== the shipped builds"
for b in win32-x64 linux-x64 darwin-arm64; do
  fetch "$OUT/build-$b.README" "$STATIC/$b.README"
  fetch "$WORK/$b.gz" "$STATIC/ffmpeg-$b.gz" && gunzip -f "$WORK/$b.gz" && {
    echo "$(sha256sum < "$WORK/$b" | cut -d' ' -f1)  ffmpeg ($b, from ffmpeg-static b6.1.1)" > "$OUT/build-$b.sha256"
    strings -n 8 "$WORK/$b" | grep -m1 -E -- '--enable-gpl' > "$OUT/build-$b.configuration.txt" || true
  }
done

while read -r os name version how kind source ref; do
  case "$os" in ''|\#*) continue ;; esac
  case "$kind" in
    git|gitdate|x264rev) file="$name-$version.tar.xz" ;;
    debsrc)              file="$name-$version.debian-source.tar"; ref="$ref" ;;
    url)                 file="${source##*/}" ;;
  esac
  file="${file//[:+]/_}"
  echo "== $os $name $version ($how)"
  note="$source${ref:+ $ref}"
  if [ -z "${DONE[$file]:-}" ]; then
    ok=1
    case "$kind" in
      git|gitdate|x264rev) git_archive "$file" "$source" "$ref" "$kind" && note="$source at $(cat "$WORK/rev")" || ok=0 ;;
      debsrc)              debsrc "$file" "$source" "$ref" && note="Debian source package $source $ref (snapshot.debian.org)" || ok=0 ;;
      url)                 fetch "$OUT/$file" "$source" || ok=0 ;;
    esac
    if [ $ok = 1 ]; then DONE[$file]="$note"; else
      rm -f "$OUT/$file"; echo "   NOT FETCHED: $source ${ref:-}"
      MISSING+=("$os  $name $version ($how): $source ${ref:-}")
      [ "$how" = exact ] && EXACT_MISSING=$((EXACT_MISSING + 1))
      continue
    fi
  fi
  ROWS+=("$(printf '%-6s %-18s %-26s %-8s %s\n      from %s' "$os" "$name" "$version" "$how" "$file" "${DONE[$file]}")")
done < "$LIST"

cp "$LIST" "$OUT/sources.txt"
{
  cat <<'EOF'
The source code of the ffmpeg builds in AG Horizon before 3.1 (GPL v3), best effort
==================================================================================

AG Horizon 2.x (the Electron app) and 3.1.0-beta.0 shipped ffmpeg from the ffmpeg-static package, version 5.3.0
(its release b6.1.1), which bundles builds made by others:

  win    Windows (Electron <= 2.6.0, and 3.1.0-beta.0): gyan.dev's ffmpeg 6.1.1 "essentials" build
  linux  Linux (the Electron AppImage): John Van Sickle's ffmpeg 7.0.2 static build (made on Debian 10)
  mac    macOS, Apple silicon (the Electron Mac app): osxexperts.net's ffmpeg 6.0

Those builders publish no build scripts, and don't name every library version, so the complete corresponding source
can't be had in full. This is as close as it gets:

  exact    the version the build names, in its README or in the binary itself
  nearest  not named anywhere: the release (or commit) that was current when the build was made, or, for the Linux
           build, the version Debian 10 had

build-* hold each build's README, its configure line and the sha256 of the binary that was shipped.
sources.txt is the list this was made from. AG Horizon 3.1 and later ship other ffmpeg builds, whose complete
source is published in full (see the app's Settings > About, or the README).

Files
-----
EOF
  printf '%s\n' "${ROWS[@]}"
  if [ ${#MISSING[@]} -gt 0 ]; then
    printf '\nCould not be fetched (named for completeness)\n---------------------------------------------\n'
    printf '%s\n' "${MISSING[@]}"
  fi
} > "$OUT/README.txt"
(cd "$OUT" && find . -type f ! -name SHA256SUMS | sort | sed 's|^\./||' | xargs sha256sum > SHA256SUMS)
echo "== $(ls "$OUT" | wc -l) files, $(du -sh "$OUT" | cut -f1); not fetched: ${#MISSING[@]} (exact: $EXACT_MISSING)"
[ $EXACT_MISSING = 0 ]

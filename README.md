# AG Horizon

A desktop IPTV player (Windows, macOS, Linux) built with Tauri (from 3.1; 2.x was built with Electron). It also runs on **Android TV**, steered with the remote (see [Android TV](#android-tv)).

- **Dashboard** with a large slideshow, *Trending this week* (from TMDB, matched to your playlists), live channels on your favorites, and what you watched recently
- **Live TV** – channel list (All / Groups / Favorites, numbers, search), the player, and a programme-guide column for the channel you watch; plus a full TV-guide grid
- **Movies and series** – category list with poster grids, sorting, detail pages with plot, cast (with photos and sharp posters from TMDB), seasons and episodes, "Resume", auto-play of the next episode
- **Football** – pick your teams and see their matches from the TV guide and the channel names: what's on now, what's coming up, and the channels showing it (see below)
- **Several playlists** – Xtream Codes (server + login, or paste a `get.php?username=…&password=…` link), M3U/M3U8 by URL or file; drag an `.m3u` file onto the window to add it
- **Mirror picture** – show the same picture onto another monitor or TV (see below)
- **Compatibility mode** – HEVC video and DTS / AC-3 audio are converted on the fly with ffmpeg
- **Audio language and subtitles** – switch between a video's languages, with a preferred language for each (see below)
- **Sync between computers** – Recently viewed, where you stopped and favorites, end-to-end encrypted with a sync code (see below)
- Favorites and recently viewed across playlists, global search, command palette (**Ctrl K**), light / dark theme with accent colours, 24- or 12-hour clock, mini player that keeps playing while you browse
- Keyboard: press **?** in the app for the full list

## Download

**[Download the latest version](https://github.com/Andreas-Graesmo/AGHorizon/releases/latest)** · [all releases](https://github.com/Andreas-Graesmo/AGHorizon/releases)

| System | File |
|---|---|
| Windows | `AG-Horizon-Setup-<version>.exe` |
| macOS (Apple silicon and Intel) | `AG-Horizon-<version>-universal.dmg` |
| Linux | `AG-Horizon-<version>.AppImage` |
| Android TV | `AG-Horizon-TV-<version>.apk` |

After that the app updates itself: **Settings › About & updates**.

- **Windows:** the installer isn't code-signed, so SmartScreen may say "Windows protected your PC" the first time. Click **More info › Run anyway**.
- **macOS:** the app isn't signed either. The first time, macOS says it can't check it: open **System Settings › Privacy & Security** and click **Open Anyway** (on macOS 14 and earlier, right-click the app and choose **Open**). Move it to **Applications** first: from there it updates itself like on the other systems (not when it runs from the disk image).
- **Linux:** make the file executable once (`chmod +x AG-Horizon-*.AppImage`), then run it. If it won't start on a newer Ubuntu, install `libfuse2` (`libfuse2t64` on 24.04 and later).
- **Android TV:** the app isn't in the Play Store; you install the `.apk` yourself. See [Android TV](#android-tv).

Building from source and publishing releases: see [RELEASING.md](RELEASING.md).

## Android TV

The same app on a TV: Android TV and Google TV boxes and sets with Android 7 or newer. (Fire TV runs Android apps too, but the app hasn't been tried there.) It has the dashboard, Live TV with the guide, movies and series, the Football page, favorites, recently viewed, search, several playlists and sync (AG Horizon cloud). It opens with the AG Horizon sun rising over the horizon while it starts.

**Installing.** Download `AG-Horizon-TV-<version>.apk` from the [releases page](https://github.com/Andreas-Graesmo/AGHorizon/releases/latest) and install it on the TV. The usual ways: the *Downloader* app on the TV (type the address of the file), *Send files to TV* from a phone, or `adb install` from a computer. The TV asks once whether that app may install apps. After that the app updates itself: it tells you when there is a new version, downloads it, and hands it to Android's installer, which asks you once more (**Settings › About & updates**). Your playlists, favorites and history are kept.

**The remote.**

| | In the app | In the player |
|---|---|---|
| ◀ ▶ ▲ ▼ | Move the focus | Live TV: ▲ ▼ change channel. Movies and episodes: ◀ ▶ skip 10 s back / 30 s forward |
| OK | Open / watch | Show the controls (pause, seek bar, audio language, subtitles, speed) |
| Hold OK, or Menu | What the small buttons on a tile do: favorite, remove from Recently viewed, mark as watched, edit a playlist | |
| Back | Close a menu or dialog, go back a page; twice on the dashboard leaves the app | Hide the controls, then leave the player |
| Channel + / − | | Next / previous channel |
| Play / pause, ⏪ ⏩, ⏮ ⏭ | | Pause, skip, previous / next episode |
| 0–9 | Live TV: go to that channel number | Live TV: go to that channel number |

**What plays, plays in the TV's own player** (ExoPlayer), full screen, not in the page. It uses the TV's hardware decoders, so HEVC and 4K play where the TV can, and sound it has no decoder for (AC-3, E-AC-3, DTS, MP2) is decoded by the app. That is why there is no compatibility mode on a TV. The player picks your preferred audio language and turns subtitles on in your language (**Settings › Languages**); you can change both in its controls.

**Left out on a TV**, because they belong to a computer: picture-in-picture, Mirror picture, Multi view, downloads, playlists from a file, the command palette and keyboard shortcuts, OpenSubtitles search, and syncing through a folder.

**Size.** **Settings › Appearance › Size** makes everything larger or smaller.

**If pages look wrong** (missing colours, broken layout), the TV's *Android System WebView* is old: the app needs version 111 or newer. Update it in the TV's app store.

## Football

The ball in the left rail (under Live TV, Series and Movies) opens your teams' matches.

- **Your teams:** pick as many as you like, from England, Norway, Spain, Italy, Germany, France and the national teams. Each gets its own part of the page: the channels named after a match first, then what's **on now**, what's **coming up**, and apart from those, **replays, highlights and shows**.
- **Where it looks:** the TV guide of your playlists and the channel names (many providers have match channels such as "EPL 03: Man Utd vs Liverpool 20:00", often without a guide). The guide covers about the next day and a half, so a match further ahead shows up when the guide has it.
- **Every name a team goes by:** Manchester United is found as Manchester United, Man United, Man Utd, Man. Utd, MUFC, ManU, Red Devils and "MUN v LIV". Words that also mean something else (Brann, Viking, Arsenal, Norway) only count when the text is about football ("Brann – Molde", not "Brann i Bergen"), and other teams with the same words (Man City, Leeds United) never do.
- **One match, all its channels:** the same match on several channels (an HD and an SD feed, a 15:00 and a 15:30 start with different build-ups) is one row with a button per channel. Pick one and it plays.
- **Checked against the real fixtures:** each team's matches come from [TheSportsDB](https://www.thesportsdb.com) (looked up once, kept 6 hours), and under the team's name you see its next match and its last result. A guide entry is a match only when it airs at a real kick-off against the real opponent, and it gets a ✓ with the competition; last weekend's match shown again, the build-up and the highlights go under replays. A match the fixture list doesn't have (a friendly) still counts when the guide says it is live.
- **Replays are kept apart:** what says so (replay, highlights, classic, "(R)", reprise…), short slots, a club's own channel (MUTV, LFC TV: only its live matches, such as pre-season friendlies, count), and the airings that are not at a kick-off. Without the fixtures (offline, or a team TheSportsDB doesn't know), the guide alone decides: the team's other airings in the guide's day and a half are the replays, and a replay that shows once, in a long slot and without any mark, can still show among the matches.
- **Search** for any team (by any of its names) or for any words, such as "Champions League", from the box at the top.

## Sources and startup

- On every start AG Horizon reloads all your playlists in the background (the one you used last first), so channel lists and the guide are fresh and each source gets a status: green = responding, red = not responding.
- **Sources** (list icon in the left rail) shows every playlist with type, date added, last update, server and user. Filter by type or status, sort, reload, edit, or use *Clean up inactive sources…*.
- Click the playlist name in the top bar for a quick switcher (type to search, ↑ ↓ and Enter to open).

## Mirror picture (show the video on two displays)

Click the **Mirror picture** button on the player (the two-screens icon).

- With one display, a small window opens that stays on top of other windows (drag it by the picture, resize it by the edges) while the player keeps playing in the app.
- With more displays, pick that floating window or a monitor or TV. On a monitor, a borderless window opens full screen there, showing exactly what the main player shows.
- Press **Esc** in that window (or click the button again) to close it. The floating window also shows a ✕ in its top right corner while the mouse is over it.
- The floating window looks like the player and has its controls while the mouse is over it: the title, play / pause, back and forward 15 seconds and (when the window is wide enough) a seek bar for movies and series, a LIVE badge for live TV, and a speaker that brings up a volume slider (press it again to mute). They steer the player in the app.
- It does **not** open a second connection to your provider: the main player hands the mirror window its decoded picture, so it stays in sync and your connection limit isn't affected. It follows when you change channel or title.
- **Sound** (Settings › Playback › Mirror picture: sound plays on): play it on this window, on the mirror window only (useful when the TV has the speakers), or on both.

## Sync between computers

**Settings › Sync** keeps Recently viewed, where you stopped and your favorites the same on all your computers.

- Turn it on with **Create a sync code** on the first computer, then **I have a code** on the others. The code is 27 letters and digits; a typo is caught before anything happens.
- Everything is encrypted on the computer with a key made from the code (AES-256-GCM) before it's stored. Where it's stored sees only random ids and noise, and the code is kept in the system keychain.
- Store it in **a synced folder** (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing: pick the same folder on each computer), or in **AG Horizon cloud** when the build has a sync server set up (see [`supabase/README.md`](supabase/README.md)).
- Playlists and logins are not synced. Add the same playlist on each computer: the same Xtream account or playlist link is recognised everywhere, so its history lines up.
- **New code** shuts out every computer that only knows the old one. **Delete synced data** removes the stored copy; what each computer has stays on it.

## Audio language and subtitles

The language button (next to the CC button, right of the volume) lists the sound tracks of what's playing.

- **Movies and episodes** are checked before they start, so the button only shows when there's more than one language. A track the player decodes itself switches at once; AC-3 / DTS tracks play through compatibility mode, from where you were.
- **Live channels**: the app's own server reads the list of sound tracks from the stream as it passes through to the player (the MPEG-TS programme map, also inside HLS segments), so the button shows as soon as a channel with several languages plays, and the menu opens at once: no second connection to the provider, nothing to wait for. HLS streams with an audio playlist per language switch directly. Another language than the stream's own plays through compatibility mode (a short restart, like changing channel). Only for streams that aren't MPEG-TS does a click on a channel marked *MULTI-AUDIO*, *Dual Audio* or *[MULTI]* hang up and check the stream with ffmpeg.
- **Settings › Languages › Preferred audio language** picks that language when it's there. **Settings › Languages › Turn on subtitles automatically** turns on subtitles in a language (from the video, or saved with a download), unless it's already spoken in it.
- What you pick with either button is remembered for that series, movie or channel, including *Off* for subtitles.

## Compatibility mode (codecs)

The player is the system's own web view (WebView2 on Windows, WebKit on macOS and Linux), which can't decode every format: HEVC on some machines, DTS / AC-3 audio. If a stream fails, or plays with no picture or no sound, AG Horizon converts it on the fly with ffmpeg to H.264 video + stereo AAC audio. Videos that already have H.264 only get their audio converted (cheap); HEVC is re-encoded (uses CPU, capped at 1080p). A "Compatibility mode" badge shows while this is active. Converted movies and episodes use AG Horizon's own seek bar, and each seek restarts the conversion at that point (a second or two). Switch it to *Always* or *Off* in Settings › Playback.

- The app **bundles ffmpeg**, which is licensed under the [GPL v3](https://www.gnu.org/licenses/gpl-3.0.html):
  - **Windows:** ffmpeg 8.1, the win64 GPL build by [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (autobuild 2026-10-31), checked by SHA-256 when the app is built (`scripts/tauri-prep.js`). Its complete source code, every library in it included, is published as [this release](https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/ffmpeg-n8.1.3-27-g8dca1586f4-btbn-2026-10-31-source) (`scripts/ffmpeg-source.sh` makes it).
  - **Linux:** the same ffmpeg 8.1 from the same BtbN autobuild (linux64 GPL); its source is in the same release. The AppImage also bundles libraries from Ubuntu so video plays everywhere (GStreamer with `gst-libav`, WebKitGTK, GTK and others, under the GPL and LGPL): each release has `AG-Horizon-<version>-AppImage-sources.txt`, which lists them and links to their published source (`scripts/appimage-sources.sh`).
  - **macOS:** ffmpeg 8.1 from the same commit, built for this app by `scripts/ffmpeg-macos.sh` with x264, dav1d and OpenSSL at BtbN's versions; its complete source is published with it in [this release](https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/ffmpeg-n8.1.3-27-g8dca1586f4-macos-universal-3).
  - **Versions before 3.1** (the 2.x Electron app, and 3.1.0-beta.0) shipped other builds, from the `ffmpeg-static` package: gyan.dev's 6.1.1 on Windows, John Van Sickle's 7.0.2 on Linux, osxexperts.net's 6.0 on the Mac. Their makers don't publish every source, so [this release](https://github.com/Andreas-Graesmo/AGHorizon/releases/tag/ffmpeg-legacy-ffmpeg-static-b6.1.1-source) holds them as far as they can be found (its `README.txt` says which are exact).
- The licence matters only if you redistribute installers to other people.

## How it works

The window shows the UI from a small server that runs inside the app on `127.0.0.1`: the Rust server in `server-rs/` (the Tauri app and Android TV), ported from `server.js` (the 2.x Electron app's server), which the tests still hold it to. The server fetches playlists, parses the (often huge, gzipped) XMLTV guide, relays streams and runs ffmpeg, because providers don't allow direct calls from a web page (CORS, custom User-Agents). It only accepts requests from the app itself.

On Android TV it is the same pages and the same server: the app (`android/`) shows the pages in a WebView and runs the Rust server (`server-rs/`, built for Android as `server-rs/jni`) inside the app. The pages notice the TV (`public/js/tv.js`), switch to the remote, and hand what should play to ExoPlayer.

## Notes

- **Playlist logins are saved in plain text** in the app's local storage on your computer.
- **Saved data is tied to the port.** The app always uses port 47831 so your playlists persist. If another program already uses it, set `TUNER_PORT` to a different free port and keep using that one.
- **Connection limits:** most providers allow only 1–2 simultaneous streams.
- **Guide matching:** channels are matched to the guide by `epg_channel_id` / `tvg-id`, then by name. The guide window is ~3 h back to 36 h ahead, cached for 30 minutes.
- **M3U playlists:** entries with `/movie/` or `/series/` in the URL are sorted into Movies and Series automatically.
- **Offline player libraries (optional):** hls.js and mpegts.js load from the jsDelivr CDN on first use. `npm run setup` saves local copies into `public/vendor/`.
- Use this only with services you're entitled to watch.

## Files

```
src-tauri/              the desktop app (Tauri): windows, updater, keychain, mirror window placement
server-rs/              the server inside the apps (Rust)
desktop/                downloads and the sync folder, run by the app's server sidecar (sidecar/)
public/js/tauri-shell.js  the page's bridge to the desktop app
server.js               the 2.x server: the reference the Rust server is tested against
public/index.html       page structure
public/style.css        styles (dark / light, accent colours)
public/js/core.js       storage, Xtream / M3U loading, EPG lookups
public/js/player.js     player, compatibility mode, picture mirroring
public/js/workspace.js  live TV, guide, movies and series
public/js/dialogs.js    add / edit playlists
public/js/ui.js         navigation, dashboard, settings, search, command palette
public/js/audio.js      the audio-language button, preferred audio language
public/js/sync-core.js  sync codes, encryption, merging history / progress / favorites
public/js/sync.js       Settings › Sync, when to sync, the folder and cloud storage
public/js/sync-config.js  the sync server's address (empty: folder only)
supabase/sync.sql       tables and functions for the optional sync server
public/js/boot.js       start-up, drag & drop
public/mirror.html/js   the mirror window
scripts/get-vendor.js   optional: download player libraries locally
public/js/tv.js         Android TV: the remote, what a TV leaves out, handing playback to the TV's player
public/js/football.js   the Football page
public/js/football-core.js  the teams and their names, finding their matches in the guide and channel names
unicode-ln.js           letters and numbers, for the Node.js inside the Android TV app (made by scripts/gen-unicode-ln.js)
android/                the Android TV app: WebView, the Rust server (server-rs/jni), ExoPlayer
android/ci/smoke.js     tries the Android TV app on an emulator
```

## Credits

Navigation icons (Live TV, Series, Movies) are from [Font Awesome Free](https://fontawesome.com) and licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Cast photos come from [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.

The Android TV app runs the same Rust server as the desktop app and plays with [AndroidX Media3 / ExoPlayer](https://github.com/androidx/media); sound the TV can't decode is decoded by ffmpeg, as built by the [Jellyfin project](https://github.com/jellyfin/jellyfin-media3-ffmpeg-decoder) (GPL-licensed, like the desktop app's ffmpeg: that matters only if you redistribute the app).

The desktop app's ffmpeg is [ffmpeg](https://ffmpeg.org) (GPL v3); see *Compatibility mode* above for which build each system gets and where its source is.

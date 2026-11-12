# AG Horizon

A desktop IPTV player (Windows, macOS, Linux) built with Electron, laid out like IPTVnator.

- **Dashboard** with a large slideshow, *Trending this week* (from TMDB, matched to your playlists), live channels on your favorites, and what you watched recently
- **Live TV** – channel list (All / Groups / Favorites, numbers, search), the player, and a programme-guide column for the channel you watch; plus a full TV-guide grid
- **Movies and series** – category list with poster grids, sorting, detail pages with plot, cast, seasons and episodes, "Resume", auto-play of the next episode
- **Several playlists** – Xtream Codes (server + login, or paste a `get.php?username=…&password=…` link), M3U/M3U8 by URL or file; drag an `.m3u` file onto the window to add it
- **Second screen** – mirror the picture onto another monitor or TV (see below)
- **Compatibility mode** – HEVC video and DTS / AC-3 audio are converted on the fly with ffmpeg
- **Sync between computers** – Recently viewed, where you stopped and favorites, end-to-end encrypted with a sync code (see below)
- Favorites and recently viewed across playlists, global search, command palette (**Ctrl K**), light / dark theme with accent colours, mini player that keeps playing while you browse
- Keyboard: press **?** in the app for the full list

## Download

**[Download the latest version](https://github.com/Andreas-Graesmo/AGHorizon/releases/latest)** · [all releases](https://github.com/Andreas-Graesmo/AGHorizon/releases)

| System | File |
|---|---|
| Windows | `AG-Horizon-Setup-<version>.exe` |
| macOS (Apple silicon) | `AG-Horizon-<version>-arm64.dmg` |
| Linux | `AG-Horizon-<version>.AppImage` |

After that the app updates itself: **Settings › About & updates**.

- **Windows:** the installer isn't code-signed, so SmartScreen may say "Windows protected your PC" the first time. Click **More info › Run anyway**.
- **macOS:** the app isn't signed either. The first time, right-click the app and choose **Open**. On a Mac the app tells you about new versions, and you download them from the releases page.
- **Linux:** make the file executable once (`chmod +x AG-Horizon-*.AppImage`), then run it.

Building from source and publishing releases: see [RELEASING.md](RELEASING.md).

## Sources and startup

- On every start AG Horizon reloads all your playlists in the background (the one you used last first), so channel lists and the guide are fresh and each source gets a status: green = responding, red = not responding.
- **Sources** (list icon in the left rail) shows every playlist with type, date added, last update, server and user. Filter by type or status, sort, reload, edit, or use *Clean up inactive sources…*.
- Click the playlist name in the top bar for a quick switcher (type to search, ↑ ↓ and Enter to open).

## Second screen (show the video on two displays)

Click the **second screen** button on the player (the two-screens icon, also in the top bar).

- With one display, a small window opens that stays on top of other windows (drag it by the picture, resize it by the edges) while the player keeps playing in the app.
- With more displays, pick that floating window or a monitor or TV. On a monitor, a borderless window opens full screen there, showing exactly what the main player shows.
- Press **Esc** in that window (or click the button again) to close it.
- It does **not** open a second connection to your provider: the main player hands the second window its decoded picture, so it stays in sync and your connection limit isn't affected. It follows when you change channel or title.
- **Sound** (Settings › Second screen): play it on this window, on the second screen only (useful when the TV has the speakers), or on both.

## Sync between computers

**Settings › Sync** keeps Recently viewed, where you stopped and your favorites the same on all your computers.

- Turn it on with **Create a sync code** on the first computer, then **I have a code** on the others. The code is 27 letters and digits; a typo is caught before anything happens.
- Everything is encrypted on the computer with a key made from the code (AES-256-GCM) before it's stored. Where it's stored sees only random ids and noise, and the code is kept in the system keychain.
- Store it in **a synced folder** (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing: pick the same folder on each computer), or in **AG Horizon cloud** when the build has a sync server set up (see [`supabase/README.md`](supabase/README.md)).
- Playlists and logins are not synced. Add the same playlist on each computer: the same Xtream account or playlist link is recognised everywhere, so its history lines up.
- **New code** shuts out every computer that only knows the old one. **Delete synced data** removes the stored copy; what each computer has stays on it.

## Compatibility mode (codecs)

The player is Chromium, which can't decode HEVC on every machine or DTS / AC-3 audio. If a stream fails, or plays with no picture or no sound, AG Horizon converts it on the fly with ffmpeg to H.264 video + stereo AAC audio. Videos that already have H.264 only get their audio converted (cheap); HEVC is re-encoded (uses CPU, capped at 1080p). A "Compatibility mode" badge shows while this is active. Converted movies and episodes use AG Horizon's own seek bar, and each seek restarts the conversion at that point (a second or two). Switch it to *Always* or *Off* in Settings › Playback.

- The app **bundles ffmpeg** (via the `ffmpeg-static` package, installed by `npm install`).
- The bundled ffmpeg build is GPL-licensed; that matters only if you redistribute installers to other people.

## How it works

The window shows the UI from a small server (`server.js`) that runs inside the app on `127.0.0.1`. The server fetches playlists, parses the (often huge, gzipped) XMLTV guide, relays streams and runs ffmpeg, because providers don't allow direct calls from a web page (CORS, custom User-Agents). It only accepts requests from the app itself.

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
electron/main.js        desktop window, second-screen window placement
electron/preload.js     lets the page ask which monitors exist
server.js               proxy + EPG parser + ffmpeg conversion + static files
public/index.html       page structure
public/style.css        styles (dark / light, accent colours)
public/js/core.js       storage, Xtream / M3U loading, EPG lookups
public/js/player.js     player, compatibility mode, second-screen mirror
public/js/workspace.js  live TV, guide, movies and series
public/js/dialogs.js    add / edit playlists
public/js/ui.js         navigation, dashboard, settings, search, command palette
public/js/sync-core.js  sync codes, encryption, merging history / progress / favorites
public/js/sync.js       Settings › Sync, when to sync, the folder and cloud storage
public/js/sync-config.js  the sync server's address (empty: folder only)
electron/sync.js        the sync code in the keychain, reading and writing the sync folder
supabase/sync.sql       tables and functions for the optional sync server
public/js/boot.js       start-up, drag & drop
public/mirror.html/js   the second-screen window
scripts/get-vendor.js   optional: download player libraries locally
```

## Credits

Navigation icons (Live TV, Series, Movies) are from [Font Awesome Free](https://fontawesome.com) and licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

Cast photos come from [TMDB](https://www.themoviedb.org). This product uses the TMDB API but is not endorsed or certified by TMDB.

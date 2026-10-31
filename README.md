# AG Horizon

A desktop IPTV player (Windows, macOS, Linux) built with Electron, laid out like IPTVnator. It can also run as a plain local web app.

- **Dashboard** with *continue watching*, recently viewed and favorites from all your playlists
- **Live TV** – channel list (All / Groups / Favorites, numbers, search), the player, and a programme-guide column for the channel you watch; plus a full TV-guide grid
- **Movies and series** – category list with poster grids, sorting, detail pages with plot, cast, seasons and episodes, "Resume", auto-play of the next episode
- **Several playlists** – Xtream Codes (server + login, or paste a `get.php?username=…&password=…` link), M3U/M3U8 by URL or file; drag an `.m3u` file onto the window to add it
- **Second screen** – mirror the picture onto another monitor or TV (see below)
- **Compatibility mode** – HEVC video and DTS / AC-3 audio are converted on the fly with ffmpeg
- Favorites and recently viewed across playlists, global search, command palette (**Ctrl K**), light / dark theme with accent colours, mini player that keeps playing while you browse
- Keyboard: press **?** in the app for the full list

## Run the desktop app

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install     # downloads Electron and ffmpeg (once)
npm start       # opens the app window
```

### Make an installer

```bash
npm run dist          # for the system you're on
npm run dist:win      # .exe installer   (build on Windows)
npm run dist:mac      # .dmg             (build on macOS)
npm run dist:linux    # .AppImage        (build on Linux)
```

The result is in `dist/`. Each platform is best built on that platform.

## Sources and startup

- On every start AG Horizon reloads all your playlists in the background (the one you used last first), so channel lists and the guide are fresh and each source gets a status: green = responding, red = not responding.
- **Sources** (list icon in the left rail) shows every playlist with type, date added, last update, server and user. Filter by type or status, sort, reload, edit, or use *Clean up inactive sources…*.
- Click the playlist name in the top bar for a quick switcher (type to search, ↑ ↓ and Enter to open).

## Or run it as a web app (no Electron)

```bash
npm run web      # or: node server.js
```

Then open <http://localhost:8787>.

## Second screen (show the video on two displays)

Click the **cast** button on the player (or the cast icon in the top bar).

- **Desktop app:** pick the monitor or TV. A borderless window opens full screen there, showing exactly what the main player shows. Press **Esc** in that window (or click the button again) to close it.
- **Browser:** a pop-up window opens; drag it to the other screen and press **F** for full screen.
- It does **not** open a second connection to your provider: the main player hands the second window its decoded picture, so it stays in sync and your connection limit isn't affected. It follows when you change channel or title.
- **Sound** (Settings › Second screen): play it on this window, on the second screen only (useful when the TV has the speakers), or on both.

## Multi view (up to 4 channels at once)

Click the grid icon in the side bar (below the TV guide). Pick a layout at the top:
**Side by side**, **Stacked** (two pictures), **3 · big left**, **3 · big top**, or **2 × 2**.

- Add channels with **Add a channel** in a picture, with the grid button on a channel row or tile, or with the Multi view button in the player bar (it moves the channel you are watching into Multi view).
- One picture has sound at a time. Click a picture, or press **1–4**. **F** or double-click gives full screen, **M** mutes all.
- Your layout and channels are remembered.
- Every picture uses one connection from your provider. If the provider allows fewer connections than pictures, AG Horizon warns you. Pictures that need ffmpeg conversion are scaled down to keep the CPU load reasonable.
- The second-screen mirror shows the normal player only, not Multi view.

## Compatibility mode (codecs)

The player is Chromium, which can't decode HEVC on every machine or DTS / AC-3 audio. If a stream fails, or plays with no picture or no sound, AG Horizon converts it on the fly with ffmpeg to H.264 video + stereo AAC audio. Videos that already have H.264 only get their audio converted (cheap); HEVC is re-encoded (uses CPU, capped at 1080p). A "Compatibility mode" badge shows while this is active. Converted movies and episodes use AG Horizon's own seek bar, and each seek restarts the conversion at that point (a second or two). Switch it to *Always* or *Off* in Settings › Playback.

- The **desktop app bundles ffmpeg** (via the `ffmpeg-static` package, installed by `npm install`).
- For the **web version**, install ffmpeg yourself (it must be on your PATH) or set `FFMPEG_PATH=/path/to/ffmpeg`.
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
server.js               proxy + EPG parser + ffmpeg conversion + static files (also runs standalone)
public/index.html       page structure
public/style.css        styles (dark / light, accent colours)
public/js/core.js       storage, Xtream / M3U loading, EPG lookups
public/js/player.js     player, compatibility mode, second-screen mirror
public/js/workspace.js  live TV, guide, movies and series
public/js/dialogs.js    add / edit playlists
public/js/ui.js         navigation, dashboard, settings, search, command palette
public/js/boot.js       start-up, drag & drop
public/mirror.html/js   the second-screen window
scripts/get-vendor.js   optional: download player libraries locally
```


## Credits

Navigation icons (Live TV, Series, Movies) are from [Font Awesome Free](https://fontawesome.com) and licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

# AG Horizon: migration plan from Electron to Tauri v2

Status: plan only, nothing is migrated yet. Based on an audit of commit `7fe2b6f` (`2.5.0-beta.4`).

The audit had three parts:
1. the IPC, preload and renderer bridge;
2. the Node APIs and dependencies;
3. windows, OS integration, the updater and packaging.

Line references are `file:line` at that commit.

---

## 1. Summary

The Electron layer is small: `electron/` holds 941 lines in 6 files. The app's real logic sits in two places that both carry over:
- the renderer (`public/`);
- the local HTTP server (`server.js`, `subtitles.js`). It is plain Node 18 with no npm dependencies, and **the same file runs on Android TV** (nodejs-mobile 18.20.4).

These facts shape the plan:

| Fact | Consequence |
|---|---|
| The UI loads from `http://127.0.0.1:47831` (`electron/main.js:16,80`). The server rejects anything that is not same-origin (`server.js:1010-1022`). | Keep that origin in Tauri: `WebviewUrl::External` plus a `remote.urls` capability. Every `/api/*` URL, the same-origin guard and `location.origin` keep working unchanged. |
| Playlists, favourites, history and settings live in **Chromium localStorage and IndexedDB** under `<appData>/Tuner IPTV` (`main.js:20`, `public/js/core.js:26-50`). | Tauri's webviews cannot read that data. **A final Electron "bridge" release must export it**, or every user loses their playlists. |
| ffmpeg is spawned for probing, keyframes, transcoding and subtitles. Media must flow over HTTP with Range and backpressure. | Keep a localhost HTTP server in every variant. Never send media over Tauri IPC. ffmpeg becomes an `externalBin` sidecar. |
| PiP moves the live `<video>` element into an `about:blank` popup (`public/js/player.js:476-496`). Mirror uses `window.opener` plus `video.captureStream()` (`player.js:586,600`, `public/mirror.js:15,85,132`). | These are the hardest features. They need opener-linked popups (Tauri `on_new_window`), and `captureStream` exists **only in WebView2**. Mirror needs a redesign on macOS and Linux. |
| Electron gives the same Chromium on every OS. Tauri uses WebView2, WKWebView or WebKitGTK. | Codecs, MSE, autoplay, fullscreen and wake-lock behaviour differ per OS. **Phase 0 is a media spike** that decides go or no-go before most other work starts. |
| The renderer reaches the desktop layer through one object, `window.tunerDesktop`. It has 34 members (`electron/preload.js:6-46`), and `public/js/tv.js:29-127` already re-implements that contract for Android. | Write a `public/js/tauri-shell.js` adapter with the same shape on top of `__TAURI__`. Renderer code otherwise stays unchanged. |

**Recommended server strategy: hybrid (option C in Appendix D).**
- At first, run `server.js` unchanged as a Node sidecar binary.
- Write the shell (window, updater, dialogs, sync, migration) in Rust.
- Later, and optionally, port routes to a standalone `aghorizon-server` axum crate that Android could link too.

This separates the real unknown (webview media) from a 1,300-line rewrite.

---

## 2. Phased checklist

Each phase ends with a **gate**. Do not start the next phase until the gate passes.

### Phase 0: Spikes and decisions (go/no-go)

- [x] **0.1 Media spike on all three webviews.** Done on CI VMs (Windows WebView2, macOS WKWebView, Ubuntu 22.04 WebKitGTK) and locally (Ubuntu 24.04). The harness is in `spike/media/` and the results in [`spike/media/RESULTS.md`](spike/media/RESULTS.md). Outcomes that change this plan:
  - **Go on all three.** Every webview plays H.264/AAC through native, hls.js and mpegts.js; autoplay works; and `invoke` from the `remote.urls` origin works (Windows confirmation pending in CI run #3).
  - **New, blocking on macOS:** WKWebView rejects every `/api/transcode` stream, fMP4 included, so compatibility mode is dead there as built. Fix it by feeding the conversion through MSE on WebKit (being verified on macOS), or by having ffmpeg output HLS. → task 2.12.
  - **New:** undecodable HEVC gives sound with no picture and no `error` event (Chromium/WebView2), so the H.264 fallback in `player.js` never fires. → task 2.13.
  - **Confirmed:** keep `--enable-blink-features=AudioVideoTracks` (without it `audioTracks` is missing on WebView2).
  - **Confirmed:** `navigator.wakeLock` is denied on both WebKits, so use `keepawake` (4.6).
  - **Confirmed:** no PiP API at all on WebKitGTK (4.3).
  - **Confirmed:** `canvas.captureStream()` works everywhere, so the Mirror fallback is viable (4.4).
  - **Open:** Multiview with 4 MSE pictures on Linux was flaky in a software-GL container (but 4/4 on CI). Retest on a real Linux desktop, and add a per-tile retry. Manual checks still open: sound on WKWebView for MSE streams, and HEVC/AC-3 on real Windows hardware.

  The original checklist for this spike:
  - [ ] hls.js and mpegts.js playback (MSE), including the mpegts Worker (`player.js:191-192`)
  - [ ] Native HLS on WKWebView (`player.js:158`)
  - [ ] H.264/AAC, HEVC, AC-3/E-AC-3 detection, and the existing ffmpeg fallback (`/api/transcode`)
  - [ ] **Matroska output** of `/api/transcode?video=hevc` (`server.js:812,834`). WebKit is expected to fail, so decide on fMP4 or HLS for WebKit.
  - [ ] `video.audioTracks` (WebView2 needs `--enable-blink-features=AudioVideoTracks`)
  - [ ] Autoplay without a user gesture (auto-play of the next episode)
  - [ ] Element fullscreen (player, multiview tiles, `downloads.js:286`), and whether it fills the OS window
  - [ ] Multiview with 4 or more simultaneous decoders
  - [ ] Media Session keys and `navigator.wakeLock`
  - [ ] `navigator.clipboard.writeText` (`player.js:121`, `sync.js:345`)
  - [ ] Linux: `bundle.linux.appimage.bundleMediaFramework: true` (GStreamer), plus the `WEBKIT_DISABLE_DMABUF_RENDERER` workaround on Nvidia/Wayland
- [ ] **0.2 Popup spike.**
  - Pin a Tauri 2.x version that has `on_new_window` with window features.
  - Check that `window.open('about:blank')` returns a scriptable `w.document` that you can `appendChild(playerEl)` into, and that `window.opener` works from `/mirror.html`. Test on each OS.
  - Record the result per OS, because it decides the PiP and mirror design in Phase 4.
- [ ] **0.3 Decide the server strategy** (Appendix D). The default is C, hybrid.
  - [ ] Prove a Node SEA (or `bun build --compile`) binary of `server.js`. Bundle it with esbuild so `./subtitles`, `./unicode-ln`, `./secrets.json` and `./package.json` are inlined. It must run with `PUBLIC_DIR`, `FFMPEG_PATH` and `TMPDIR` passed through env.
- [ ] **0.4 Decide on ffmpeg.** Keep the GPL static build (libx264 is needed by `-c:v libx264`) as a sidecar per target triple. Ship the GPL licence and a source link with each release.
- [ ] **0.5 Decide on the title bar.**
  - Windows/Linux: `decorations:false` plus HTML window buttons (optionally `tauri-plugin-decorum` for Win11 snap layouts).
  - macOS: `titleBarStyle: "Overlay"`.
- [ ] **0.6 Choose the beta update channel design** (§3.2 option a, a rolling `updater-beta` release, is recommended).
- [ ] **Gate:** a written go/no-go per OS (media: go on all three, see 0.1; still to do: 0.2-0.6). Any feature that cannot reach parity gets a documented degradation (see Appendix E).

### Phase 1: Bridge Electron release (ships *before* any Tauri build)

This is the last Electron version, for example `2.9.0`, on **both** the stable and test channels. Its job is to make data migration possible.

- [ ] **1.1 Export renderer storage.**
  - Trigger: the main process asks the renderer through a new IPC call, for example `migration:export`.
  - Contents: all `tuner.*` localStorage keys, plus the IndexedDB `tuner` / `files` store (local-file playlists, `core.js:31-50`).
  - Destination: `<appData>/Tuner IPTV/migration.json`, written atomically.
  - When: at startup and again on `before-quit`.
- [ ] **1.2 Export the sync code.**
  - Decrypt `sync-code` with `safeStorage` (`electron/sync.js:31-63`).
  - Write it either to the OS keychain under the service and account names the Tauri build will read with the `keyring` crate, or into `migration.json` with mode 0600.
- [ ] **1.3 Updater handover** in `electron/updater.js`.
  - [ ] Windows: when the newest release has Tauri assets (for example `latest.json`), download the Tauri `-setup.exe`, verify it (minisign `.sig` against the embedded pubkey, or a sha256 published in the release body), run it with `/P`, then `app.quit()`.
  - [ ] Linux: put the new AppImage next to `process.env.APPIMAGE`, keeping the **same file name** so desktop launchers keep working. Then `chmod +x`, spawn it detached and quit.
  - [ ] macOS: a banner with a link to download the new `.dmg`. Mac installs are manual today too.
- [ ] **1.4** Change no other behaviour. Ship it and leave it out for at least one release cycle.
- [ ] **Gate:** `migration.json` appears on all three OSes with real data, and a round-trip import into a scratch profile restores every playlist.

### Phase 2: Tauri scaffold and server sidecar

- [ ] **2.1** `npm i -D @tauri-apps/cli@^2`, then `npx tauri init`. This creates `src-tauri/`:
  - identifier **`app.aghorizon.desktop`** (the same as electron-builder's `appId`)
  - `"version": "../package.json"`, so there is one version source shared with Android (`android/app/build.gradle.kts:11-14`)
  - `productName "AG Horizon"`
- [ ] **2.2** `npx tauri icon build/icon.png`.
- [ ] **2.3 Sidecars** in `bundle.externalBin`:
  - `binaries/aghorizon-server-<triple>` (Node SEA of `server.js`)
  - `binaries/ffmpeg-<triple>`
  - Targets: `x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, `x86_64-unknown-linux-gnu`
- [ ] **2.4 `server.js` changes.** Each must stay Node 18 compatible, because Android shares the file.
  - [ ] Read `PUBLIC_DIR` from env, defaulting to the current `__dirname/public` (`server.js:21`).
  - [ ] Make `ffmpeg-static` optional, using `FFMPEG_PATH` first. That code path already exists at `server.js:647`.
  - [ ] Add a CLI entry (`node server.js --port N`, or reuse `android/app/nodejs/tv-main.js` as the sidecar entry). It prints `READY <port>` or `ERROR EADDRINUSE` on stdout.
  - [ ] Exit when stdin closes or the parent PID dies, so no orphans are left behind.
- [ ] **2.5 Rust `setup()`.**
  - Spawn the server sidecar (`tauri-plugin-shell`), passing env: port 47831 (`TUNER_PORT` override), `PUBLIC_DIR` = resource dir, `FFMPEG_PATH` = resolved sidecar path, `TMPDIR`, and the API keys.
  - Wait for `READY` before creating the window.
  - On `EADDRINUSE`, show a `tauri-plugin-dialog` error and `app.exit(1)`, as `main.js:197-205` does.
  - On Windows, put the sidecar in a Job Object so it dies with the app.
- [ ] **2.6** Bundle `public/**` as `bundle.resources`. Keep `npm run setup` (vendored hls.js and mpegts.js) as a pre-build step.
- [ ] **2.7 Main window** from `WebviewWindowBuilder`:
  - `WebviewUrl::External("http://127.0.0.1:47831/")`
  - `visible:false`, 1280×800, min 760×520, background `#0c0e12`
  - `drag_drop_enabled(false)`. **This is required**, so that HTML5 `.m3u` drops (`boot.js:15-42`) and drag-reordering (`downloads.js:387-394`) keep working.
  - Windows: `additional_browser_args("--enable-features=PlatformHEVCDecoderSupport --enable-blink-features=AudioVideoTracks --autoplay-policy=no-user-gesture-required")`, plus Tauri's default `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`.
- [ ] **2.8 Capabilities.** `src-tauri/capabilities/main.json` for window `main` with `remote.urls: ["http://127.0.0.1:47831/*"]` (see Appendix B). Give `pip` and `mirror` a separate minimal capability.
- [ ] **2.9** `on_navigation`: block navigation away from the origin and send http(s) URLs to `tauri-plugin-opener`, replacing `main.js:143-145`.
- [ ] **2.10** Register `tauri-plugin-single-instance` **first**. Its callback calls unminimize, show and set_focus on `main` (replaces `main.js:27-30,154-156`).
- [ ] **2.11 Exit handling** (`RunEvent::ExitRequested` / `Exit`): stop the sidecar gracefully, and flush downloads to the "queued" state, replacing `downloads.js:410` and `main.js:215`.
- [ ] **2.12 Compatibility mode on WebKit** (found by spike 0.1).
  - WKWebView refuses `/api/transcode` as a plain `<video src>`, because the stream has no byte ranges and no length.
  - On WebKit, play the conversion through MSE: fetch it, then `appendBuffer` into a `SourceBuffer`, or `ManagedMediaSource` on macOS.
  - Alternatively, have ffmpeg write HLS (fMP4 segments) and play that natively.
  - Keep `<video src>` on WebView2, where it works.
  - The output must be fMP4 on WebKit: Matroska fails there.
- [ ] **2.13 Watchdog for silent decode failures** (found by spike 0.1; also fixes Electron).
  - In `player.js`, treat "playing but `videoWidth` still 0 after ~4 s" as an error, so the HEVC → H.264 fallback runs.
  - Today it only listens for `video.onerror`, which Chromium never fires for undecodable HEVC.
- [ ] **Gate:** the app starts on all three OSes, the dashboard renders, live TV plays through `/api/stream`, compatibility mode transcodes through the ffmpeg sidecar, and there are no orphan processes after quit or kill.

### Phase 3: Bridge adapter and IPC commands

All 34 preload members are listed in Appendix A.

- [ ] **3.1** Set `app.withGlobalTauri: true`.
- [ ] **3.2** Add `public/js/tauri-shell.js` and load it right after `tv.js` in `public/index.html:428`.
  - It defines `window.tunerDesktop` with the exact `preload.js` shape, using `__TAURI__.core.invoke` and `__TAURI__.event.listen`.
  - It does nothing when `window.AGHorizonTV` exists (Android) or `__TAURI__` is missing.
  - It must define the object **synchronously**, because `downloads.js:5` dereferences it at load time and `boot.js:46` calls `ready` without a guard.
  - Exclude it from the Android asset list (`build.gradle.kts:88`), or keep the no-op guard.
- [ ] **3.3 App and window commands:**
  - `app_ready`: show the window, with a 5 s Rust fallback.
  - `focus_main`
  - `displays`: `available_monitors()`. There is no stable numeric id, so key monitors by `name + position`.
  - `app_info`
  - `titleBar`: becomes a no-op in the adapter.
- [ ] **3.4 Sync commands** (Rust).
  - `sync_info`: use the `hostname` crate.
  - `sync_code_get` / `sync_code_set`: use the `keyring` crate, which replaces `safeStorage`.
  - `sync_folder_choose`: use `tauri-plugin-dialog`, and save to `sync.json` in `app_config_dir`.
  - `sync_folder_list` / `sync_folder_put` / `sync_folder_remove`.
  - Keep the validation from `sync.js:17-29`: hex vault (64 chars), hex device (16-32 chars), and atomic tmp+rename writes.
  - **Binary blobs:** the adapter sends `Array.from(blob)` (or base64) and converts results back to `Uint8Array`. A raw `Uint8Array` inside an object serialises as `{"0":…}`.
- [ ] **3.5 Downloads**, recommended for the hybrid strategy:
  - [ ] **Where it runs:** keep the engine in Node, inside the sidecar. Refactor `electron/downloads.js` into an injectable module (no `require('electron')`) that reuses `test/downloads.test.js`.
  - [ ] **Control routes:** the sidecar exposes `/internal/downloads/*`, guarded by a per-launch random token passed through env. Thin Rust commands forward to those routes.
  - [ ] **Change events:** `downloads:changed` snapshots go to the sidecar's stdout as JSON lines, and Rust re-emits them with `app.emit_to("main", "downloads:changed", …)`, throttled to 500 ms.
  - [ ] **Rust-only actions:** folder picking (`dialog.pick_folder`), `reveal` (`opener.reveal_item_in_dir`) and `openFolder` (`opener.open_path`). Rust resolves the id to a path, and the renderer never names a path.
  - [ ] **Validation to keep:**
    - http(s)-only URLs (`downloads.js:282-285`)
    - the under-folder check in `adopt` (`downloads.js:100`)
    - free space via `fs.statfs` (sidecar) or the `fs4` crate (Rust)
  - [ ] **Alternative:** port the engine to Rust (reqwest Range resume, `CancellationToken`). The server then needs a lookup for `/api/local/<id>` (`server.js:856-857`). Defer this to Phase 8.
- [ ] **3.6 Updater commands.** These are built in Phase 5. Until then, stub them so `app_info.updater = false` and the manual check path works.
- [ ] **3.7 Tests.**
  - Update `test/tv.test.js:32`, which asserts `tunerDesktop` is undefined outside the TV app.
  - Add a node test that loads `tauri-shell.js` with a fake `__TAURI__` and asserts the 34-member shape.
- [ ] **Gate:** every flow works in Tauri on all OSes:
  - Settings: downloads (add, pause, resume, reorder, remove, reveal, choose folder, orphans and adopt, pause while watching)
  - Sync: cloud mode and folder mode, set and clear the code
  - About: version, channel, manual update check

### Phase 4: Windows, title bar and OS integration

- [ ] **4.1 Window state.** Use `tauri-plugin-window-state` with `SIZE|POSITION|MAXIMIZED` (not `VISIBLE`, so `app_ready` still controls showing the window). Denylist `pip` and `mirror`. Import the legacy `<appData>/Tuner IPTV/window-state.json` once.
- [ ] **4.2 Title bar.**
  - Add HTML min/max/close buttons for Windows and Linux.
  - Replace `-webkit-app-region: drag` with `data-tauri-drag-region` (`public/style.css:101-104,835-836,939`, `public/mirror.html:21`).
  - Replace the `env(titlebar-area-*)` padding.
  - macOS: overlay style with a traffic-light inset.
- [ ] **4.3 PiP** (`player.js:465-534`, Electron options `main.js:86-95,117-124`).
  - [ ] If spike 0.2 passed: use `on_new_window` with frame name `ag-horizon-pip` to create a frameless, always-on-top 480×270 window (min 260×146), placed bottom-right of `current_monitor().work_area()` with a 24 px margin.
  - [ ] Tauri has no `setAspectRatio`, so clamp to 16:9 on `WindowEvent::Resized`.
  - [ ] Fallback where the spike failed: native `video.requestPictureInPicture()` on WebView2 and WKWebView. This loses the custom controls. Hide the PiP button on WebKitGTK.
- [ ] **4.4 Mirror** (`player.js:546-623`, `mirror.js`, `main.js:98-141`).
  - [ ] Display picker: `?d=` carries the new monitor key. Rust sets position and size from the `Monitor`, then `set_fullscreen(true)` (`set_simple_fullscreen` on macOS if available).
  - [ ] Replace the manual `window.moveTo` drag (`mirror.js:21-33`) with `startDragging()`, and drop the `content-bounds-updated` hack.
  - [ ] **WebView2:** keep `captureStream()` if spike 0.2 shows opener popups work.
  - [ ] **macOS/Linux:** either `canvas.captureStream()` fed from the main `<video>` (verify the A/V sync and CPU cost), or hide Mirror and document why. Do **not** fall back to a second provider connection without making that an explicit decision (`player.js:541-543`).
  - [ ] Closing `main` closes `pip` and `mirror` (replaces `main.js:148-151`).
- [ ] **4.5 Fullscreen.** In the adapter, mirror `document.fullscreenElement` to `getCurrentWindow().setFullscreen()` wherever element fullscreen does not fill the OS window (expected on WebView2).
- [ ] **4.6 Keep-awake.**
  - Today Chromium does this for free; Tauri does not.
  - Add `keep_awake(on: bool)` using the `keepawake` crate, called on `playing`, `pause` and `ended` from `player.js` and `multiview.js`.
  - Alternatively `navigator.wakeLock` where spike 0.1 shows support.
- [ ] **4.7 External links.** `window.open(..., '_blank')` for trailers (`workspace.js:831`) goes to the opener plugin, and so do `updater:open` and any other http(s) URL.
- [ ] **4.8 macOS lifecycle.** Keep Tauri's default macOS app menu (Edit shortcuts, Cmd+Q). Optional parity: `RunEvent::Reopen` recreates `main`, and `ExitRequested` → `prevent_exit()` when the last window closes.
- [ ] **4.9 Clipboard.** If spike 0.1 showed `navigator.clipboard` failing on WKWebView, add `tauri-plugin-clipboard-manager`.
- [ ] **Gate:** a manual QA pass of the window features on all OSes: PiP, mirror to a second monitor, fullscreen player and multiview, no screensaver during playback, window state restored, a second launch focuses the first, `.m3u` drag-drop works.

### Phase 5: Updater, packaging and CI

- [ ] **5.1 Signing.** `npx tauri signer generate`. Put the pubkey in `plugins.updater.pubkey`, and add the CI secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Document key custody in `RELEASING.md` next to the Android keystore: if the key is lost, updates stop.
- [ ] **5.2** Set `bundle.createUpdaterArtifacts: true`, and `plugins.updater.windows.installMode: "passive"`.
- [ ] **5.3 Rust updater commands.** They keep the status shape `{state, version, percent, notes, manual, checkedAt, message}` and push `updater:status` events.
  - [ ] `updater_check`: `updater_builder().endpoints([url_for(channel)])`.
  - [ ] `updater_download`: `update.download(on_chunk → percent, …)`, with the bytes kept in managed state.
  - [ ] `updater_install`: run the exit cleanup (2.11) **first**, because NSIS kills the process. Then `install()`, then `app.restart()` (`tauri-plugin-process`).
  - [ ] `updater_set_channel`, `updater_status`.
  - [ ] Install-on-quit: if bytes are pending at `ExitRequested`, call `install()`. This replaces `autoInstallOnAppQuit`.
  - [ ] `updater:notes`, `manualCheck` and `updater:open` stay plain GitHub REST calls. Port them to Rust with `reqwest`, or reuse the renderer JS in `tv.js:43-116`. Keep `electron/versions.js` semantics (the `semver` crate orders versions the same way) and `test/versions.test.js`.
  - [ ] **macOS:** the minisign updater works without Apple signing. Enable in-app updates on Mac, but keep notify-only when the bundle path is under `/Volumes/` or `AppTranslocation`. Update the README and RELEASING Mac caveats.
- [ ] **5.4 Channels.**
  - Stable endpoint: `https://github.com/Andreas-Graesmo/AGHorizon/releases/latest/download/latest.json`.
  - Test endpoint: a rolling `updater-beta` release whose `beta.json` CI rewrites to the newer of {latest stable, newest beta}, which keeps "Test also gets stable" (`RELEASING.md:72`).
  - The default comparator (strict `>`) keeps "never downgrade".
- [ ] **5.5 Bundle targets:** `nsis`, `app`, `dmg`, `appimage`. **No `msi`**, because WiX rejects `-beta.N` versions.
  - macOS: `signingIdentity: "-"` (ad-hoc), `category: "Entertainment"`.
  - Windows: `webviewInstallMode: embedBootstrapper` (about +1.8 MB).
- [ ] **5.6 Rewrite `.github/workflows/release.yml`.**
  - [ ] Matrix: `windows-latest`, `macos-latest` (`--target aarch64-apple-darwin`), and **`ubuntu-22.04`** (older glibc baseline for the AppImage).
  - [ ] Toolchain: `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2`.
  - [ ] Linux packages: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` plus the GStreamer packages.
  - [ ] Keep: `npm ci` with retries, `npm test`, `npm run setup` (vendor), and the `secrets.json` step.
  - [ ] New steps: build the Node SEA server sidecar per target, and download plus checksum-verify the ffmpeg sidecar per target.
  - [ ] `tauri-apps/tauri-action@v0`: `tagName`/`releaseName` = `github.ref_name`, `releaseDraft: true`, `prerelease: contains(ref_name,'-')`, `includeUpdaterJson: true`.
  - [ ] Remove the electron-builder and Electron cache steps.
  - [ ] Keep `android-tv` and `publish-test`. Align the release title with the one the Android job uses (`gh release create --title`).
- [ ] **5.7 Asset names.** Use tauri-action `assetNamePattern` (or rename after the build) to keep `AG-Horizon-Setup-<v>.exe`, `AG-Horizon-<v>-arm64.dmg` and `AG-Horizon-<v>.AppImage`. Otherwise:
  - the website's Mac regex `/arm64\.dmg$/` breaks (`docs/site.js:18`);
  - the static labels in `docs/index.html:233-243` and `README.md:22-24` need updating.
- [ ] **5.8** Do **not** upload `latest*.yml` or `beta*.yml` to Tauri releases. Old Electron clients must only ever see the bridge release.
- [ ] **5.9 `android.yml`.** Drop `ELECTRON_SKIP_BINARY_DOWNLOAD` (`android.yml:45`) once Electron leaves `package.json`. The Android build itself is independent of Electron.
- [ ] **5.10 Licensing.** Ship the ffmpeg GPL licence text and a source link in the bundle resources and the release notes.
- [ ] **Gate:** a `v*-beta` tag produces a draft with all 3 installers, `.sig` files and `latest.json`. A Tauri build updates itself from N to N+1 on each OS, on both the stable and test channels.

### Phase 6: Data migration on first Tauri launch

- [ ] **6.1 Plain files.** If `app_data_dir/migrated` is missing, copy `downloads.json`, `sync.json` and `window-state.json` from the legacy folder:
  - `%APPDATA%\Tuner IPTV`
  - `~/Library/Application Support/Tuner IPTV`
  - `~/.config/Tuner IPTV`

  Download files stay where they are; the paths in `downloads.json` are absolute.
- [ ] **6.2 Renderer storage.**
  - Rust command `migration_payload()` returns the parsed `migration.json`, once.
  - Before `core.js` reads storage, the adapter writes every `tuner.*` key to localStorage and refills IndexedDB `tuner/files`, then calls `migration_done()`.
  - Do not overwrite keys that already exist; a user may have opened the Tauri app first.
- [ ] **6.3 Sync code.** Read it from the keychain entry or the export written in 1.2. If it is missing, sync turns off cleanly (`sync.js:360-363`). Show a one-time "re-enter your sync code" notice.
- [ ] **6.4 No bridge export found** (the user skipped 2.9.0). Show a one-time dialog: "Open the previous version once, or restore from sync." Optional and fragile: parse the Chromium LevelDB with `rusty-leveldb`.
- [ ] **6.5 Windows installer handover.** Add a Tauri NSIS hook (`NSIS_HOOK_POSTINSTALL`) that:
  - finds the electron-builder uninstaller through the HKCU Uninstall key (GUID derived from `app.aghorizon.desktop`);
  - runs `Uninstall AG Horizon.exe /S`;
  - **never deletes `%APPDATA%\Tuner IPTV`**;
  - fixes the Start menu and desktop shortcuts.
- [ ] **Gate:** run the full upgrade on clean VMs per OS, Electron 2.5.x → bridge 2.9.0 → Tauri 3.0.0-beta.1:
  - playlists, file playlists, favourites, history, settings, theme, downloads list, sync folder and sync code all survive;
  - exactly one app is installed on Windows;
  - the AppImage launcher still works on Linux.

### Phase 7: Rollout

- [ ] **7.1** Ship Tauri on the **test channel** first (`3.0.0-beta.N`), for at least 2 beta cycles.
- [ ] **7.2** Track problems by OS. Watch Linux GStreamer and Wayland reports and macOS translocation in particular.
- [ ] **7.3** Promote to stable: publish the stable Tauri release, and point the stable bridge release's handover at it.
- [ ] **7.4** Update `README.md` (now "built with Tauri", update behaviour per OS, Linux media dependencies), `RELEASING.md` and `docs/`.
- [ ] **Gate:** two weeks of stable with no data-loss reports.

### Phase 8 (optional): Port the server to Rust

Do this only if bundle size or the two-process design hurts. The Node SEA adds roughly 30-45 MB compressed.

- [ ] **8.1** Create a separate `aghorizon-server` crate with **no Tauri dependency**, so Android TV could later link it over JNI and replace libnode.
- [ ] **8.2 Fallback proxy.** axum forwards unknown `/api/*` routes to the Node sidecar, so routes can move one at a time.
- [ ] **8.3** Port in this order:
  1. static, `/api/fetch`, `/api/local` (Range), `/api/tmdb`, `/api/trending`, `/api/capabilities`
  2. `/api/stream` with M3U8 rewriting and the TS sniffer, plus `/api/tracks`
  3. `/api/probe`, `/api/keyframe`, `/api/transcode`, `/api/tcsubs` (`tokio::process`, `kill_on_drop`, `Semaphore(4)`)
  4. `/api/subs/*` and local subtitles
  5. `/api/epg` (quick-xml streaming)
  6. `/api/shared` with the PCR stitcher, last or never
- [ ] **8.4** Port the `node --test` fixtures for `server.test.js`, `shared.test.js` and `cast.test.js` into contract tests that run against **both** implementations.
- [ ] **8.5** Move the downloads engine to Rust (see 3.5, "Alternative"), then drop the Node sidecar.
- [ ] **Gate:** both servers pass the same contract tests, with no regressions in compatibility mode or Multiview shared mode on real providers.

### Phase 9: Remove Electron

- [ ] **9.1** Delete `electron/`. Remove `electron`, `electron-builder`, `electron-updater`, the `build` block and `allowScripts` from `package.json`. Make `ffmpeg-static` dev-only, or drop it in favour of the CI download.
- [ ] **9.2** Update the tests:
  - `test/downloads.test.js` stubs `require('electron')`; point it at the refactored module, or drop it after Phase 8.
  - `test/server.test.js:13-16` checks the publish target for `electron/updater.js`.
  - `test/versions.test.js` moves along with `versions.js`.
- [ ] **9.3** Update `package.json` scripts: `start` → `tauri dev`, `dist*` → `tauri build`. Keep the `release:*` version scripts.
- [ ] **9.4** Remove the update-handover code paths once telemetry or issue reports show the bridge release has drained. Keep it published.

---

## Appendix A: IPC channel map (34 preload members → Tauri)

The Electron side has 30 `ipcMain.handle`, 1 `ipcMain.on` (`app:titlebar`), 1 `webContents.ipc.once` (`app:ready`) and 2 pushes. `updater:check`, `updater:download` and `updater:install` are registered in two branches, manual and electron-updater (`updater.js:103-105,119-121`).

| Preload member | Electron channel (file:line) | Tauri v2 |
|---|---|---|
| `ready()` | `app:ready` once (`main.js:77`) | cmd `app_ready` → `window.show()`; 5 s fallback in Rust |
| `titleBar(c)` | `app:titlebar` on (`main.js:172-176`) | no-op (HTML buttons follow CSS) |
| `focusWindow()` | `tuner:focus` (`main.js:163`) | cmd `focus_main`: unminimize, show, set_focus (no `moveTop`) |
| `displays()` | `tuner:displays` (`main.js:178`) | cmd `displays` → `available_monitors()`; key = name+position |
| `appInfo()` | `app:info` (`updater.js:73`) | cmd `app_info` |
| `updater.status/check/download/install/setChannel` | `updater.js:82,103-105,119-121,77` | cmds over `tauri-plugin-updater` (§5.3) |
| `updater.notes(v)` | `updater:notes` (`updater.js:90`) | reqwest or renderer `fetch` to api.github.com |
| `updater.openReleases()` | `updater:open` (`updater.js:84`) | `opener::open_url` (scoped to github.com) |
| `updater.onStatus(cb)` | push `updater:status` (`updater.js:35`) | `app.emit_to("main","updater:status")` + `listen` |
| `downloads.list/add/pause/resume/reorder/remove/setOption/setWatching/orphans/adopt` | `downloads.js:380-409` | cmds → sidecar `/internal/downloads/*` (token); later Rust |
| `downloads.reveal/openFolder/chooseFolder` | `downloads.js:391,397,398` | Rust: opener `reveal_item_in_dir` / `open_path`, dialog `pick_folder` |
| `downloads.onChange(cb)` | push `downloads:changed` (`downloads.js:136`, 500 ms throttle) | sidecar stdout JSON line → `emit_to("main", …)` |
| `sync.info` | `sync.js:40` | cmd `sync_info` (hostname crate; keychain availability) |
| `sync.getCode/setCode` | `sync.js:47,59` (safeStorage) | cmds over the `keyring` crate |
| `sync.chooseFolder` | `sync.js:66` | dialog `pick_folder` → `sync.json` |
| `sync.folderList/Put/Remove` | `sync.js:76,92,101` | cmds; blobs as `Vec<u8>`/base64, converted in the adapter |

Non-IPC coupling that has to be dealt with:
- `main.js:160` `setLocalFiles(downloads.localFile)`: the server serves `/api/local/<id>` by calling into the downloads module in-process (`server.js:856-857`).
- Cross-window JS for PiP and mirror (Phase 4.3 and 4.4).

## Appendix B: Plugins, crates and capabilities

- **Tauri plugins:**
  - `single-instance`, `window-state`, `updater`, `process`, `dialog`, `opener`, `shell` (sidecars)
  - optional: `os`, `clipboard-manager`, `decorum`
  - **Do not** grant `fs:*` or a generic `shell:*` to the webview.
- **Crates:**
  - `keyring` (sync code), `keepawake`, `hostname`, `serde`, `serde_json`, `tempfile` (atomic writes), `dirs` (legacy paths)
  - Phase 8: `axum`, `tower-http`, `reqwest` (rustls, stream), `tokio`, `tokio-util`, `async-compression`/`flate2`, `quick-xml`, `url`, `fs4`, `rand`
- **Capability for `main`:**
  - `remote.urls: ["http://127.0.0.1:47831/*"]`
  - `core:default`, `core:event:default`
  - window `show`, `set-focus`, `unminimize`, `minimize`, `toggle-maximize`, `close`, `start-dragging`, `available-monitors`, `primary-monitor`, `set-fullscreen`, `set-always-on-top`
  - the app's own commands
  - **Because `remote.urls` gives IPC to anything that origin serves**, the server must keep serving only `public/` and keep its traversal guard (`server.js:995-996`).
- **Capability for `pip` and `mirror`:** only the window permissions they need. No downloads, sync or updater commands.
- **CSP:** none exists today. Add it as a **server response header** on HTML responses, because `app.security.csp` only covers `frontendDist`:
  - `default-src 'self'`
  - `script-src 'self'`; drop the jsDelivr fallback in `player.js:95-96` once the vendor libraries are always bundled
  - `style-src 'self' 'unsafe-inline'`
  - `img-src * data: blob:`
  - `media-src 'self' blob: mediastream:`
  - `connect-src 'self' ipc: http://ipc.localhost https://*.supabase.co https://api.github.com`
  - `worker-src 'self' blob:`
  - `font-src 'self' data:`

## Appendix C: Node APIs → Rust or Tauri

| Node / Electron API | Where | Replacement |
|---|---|---|
| `http.createServer` | `server.js:1024` | Node sidecar (Phase 2), then axum (Phase 8) |
| global `fetch`, Range, redirects, timeouts | `server.js`, `downloads.js:210-240`, `updater.js:18` | reqwest (`stream`), `tokio::time::timeout` |
| `child_process.spawn(ffmpeg)` | `server.js:644-848`, `subtitles.js:56,86` | ffmpeg `externalBin` sidecar; `tokio::process` + `kill_on_drop` |
| `zlib` gunzip and streaming gunzip | `server.js:65,200` | `flate2` / `async-compression` |
| `fs`, `fs.promises`, `statfs` | everywhere | `std::fs`/`tokio::fs`, `fs4::available_space` |
| `crypto.randomBytes` | `downloads.js:284` | `rand` + `hex` |
| `os.tmpdir`, `os.hostname` | `subtitles.js:117`, `sync.js` | `std::env::temp_dir`, `hostname` |
| `safeStorage` | `sync.js:31-63` | `keyring`; migrated by the bridge release |
| `app.getPath('userData'\|'documents')` | `main.js:20`, `downloads.js:34` | `app_data_dir`/`app_config_dir` (+ legacy `Tuner IPTV`), `document_dir` |
| `dialog.showOpenDialog` / `showErrorBox` | `downloads.js:398`, `sync.js:66`, `main.js:198` | `tauri-plugin-dialog` |
| `shell.openExternal` / `openPath` / `showItemInFolder` | `main.js:112,144`, `updater.js:84`, `downloads.js:391-397` | `tauri-plugin-opener` |
| `screen.*` | `main.js:117-141,178` | `available_monitors`, `current_monitor().work_area()` |
| `electron-updater` | `updater.js` | `tauri-plugin-updater` + `tauri-plugin-process` |
| `ffmpeg-static` | `server.js:649`, `asarUnpack` | per-triple `binaries/ffmpeg-*` sidecar |
| Unicode `\p{L}` fallback (`unicode-ln.js`) | `server.js:106` | not needed in Rust (`char::is_alphanumeric`); keep it for Android |

## Appendix D: Options for the server strategy

| | A: rewrite in Rust now | B: Node sidecar forever | **C: hybrid (recommended)** |
|---|---|---|---|
| Risk to the tuned media path (`/api/shared`, TS sniffer, EPG parser) | High | None | None at first, then incremental |
| Android TV (runs the same `server.js`) | Forks the code | Shared | Shared; crate can later replace libnode |
| Bundle size | Smallest | +30-45 MB | +30-45 MB until Phase 8 |
| Processes | 1 + ffmpeg | 2 + ffmpeg | 2 + ffmpeg → 1 + ffmpeg |
| Effort to first ship | ~3-5 weeks of server port | Smallest | Smallest |

## Appendix E: Risk register

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | Users lose playlists and settings | High / critical | Bridge export (Phase 1), import (6.2), fallback notice (6.4), VM upgrade tests |
| 2 | WebKitGTK cannot play common streams (GStreamer missing) | High / high | `bundleMediaFramework`, compatibility mode, documented dependencies, spike 0.1 |
| 3 | `/api/transcode` Matroska output fails on WebKit | High / high | fMP4 or HLS output for WebKit, chosen in 0.1 |
| 4 | PiP and mirror cannot get opener popups | Medium / medium | Spike 0.2; native PiP fallback; mirror via `canvas.captureStream` or hidden |
| 5 | `captureStream` missing on WebKit breaks mirror | Certain / medium | As in 4 |
| 6 | Screen sleeps during playback | High / medium | `keepawake` (4.6) |
| 7 | Orphaned server or ffmpeg processes; port 47831 still taken on relaunch | Medium / high | Parent-death detection, Job Object, cleanup before `install()` |
| 8 | Two Windows installs side by side after the upgrade | High / medium | NSIS post-install hook (6.5) |
| 9 | Website download buttons break because of asset names | High / low | `assetNamePattern`, or update `docs/site.js:18` |
| 10 | Updater signing key lost | Low / critical | Key custody documented in `RELEASING.md` |
| 11 | No Windows Controls Overlay, `setAspectRatio` or stable monitor id | Certain / low | HTML buttons, resize clamp, name+position key |
| 12 | `remote.urls` exposes IPC to the origin | Low / high | Minimal capabilities, server serves only `public/`, keep `requestAllowed` |
| 13 | macOS app translocation blocks self-update | Medium / low | Notify-only fallback (5.3) |
| 14 | `server.js` changes break Android (Node 18.20.4) | Medium / high | Keep the CI `node --test` run on Node 18 (`android.yml`) |

## Appendix F: Baseline

- **Test run:** `npm test` at `7fe2b6f` in a fresh checkout gives 56 of 57 passing. `test/downloads.test.js` fails only because `node_modules` was not installed (it calls `require.resolve('electron')`). Keep this suite green, apart from the planned removals, through Phases 2-7.
- **Out of scope** for this migration, unaffected apart from the shared release draft and the shared `server.js`/`public/`:
  - the Android TV app (`android/`, `android.yml`);
  - the website (`docs/`), apart from the asset names;
  - Supabase sync (`supabase/`).

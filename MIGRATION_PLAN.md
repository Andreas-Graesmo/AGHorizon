# AG Horizon: migration plan from Electron to Tauri v2 (Windows first)

Status: plan only, nothing is migrated yet. Based on an audit of commit `7fe2b6f` (`2.5.0-beta.4`).

The audit had three parts:
1. the IPC, preload and renderer bridge;
2. the Node APIs and dependencies;
3. windows, OS integration, the updater and packaging.

Line references are `file:line` at that commit. Spike results are in [`spike/media/RESULTS.md`](spike/media/RESULTS.md).

## Scope: Windows first

**Windows moves to Tauri. macOS and Linux keep shipping the Electron build** until Phase 9, when they move too.

Why:
- The media spike (0.1) found WebView2 at parity with Electron on everything the app needs.
- Every blocking problem it found is macOS- or Linux-only:
  - compatibility mode dead in WKWebView;
  - WebKitGTK freezing with several MSE players;
  - no `captureStream`, PiP or wake lock on WebKit.

What that means until Phase 9:
- **Both shells live in the repo.** They share `server.js`, `public/` and the `window.tunerDesktop` bridge, so the cost is small. `electron/` stays, and so do the electron-builder targets for macOS and Linux.
- **Every renderer or `server.js` change must keep working under Electron** (macOS and Linux) and on Android TV (Node 18).
- **Write Rust portably.** Only Windows-specific code goes behind `#[cfg(windows)]`, so Phase 9 is mostly packaging plus the WebKit fixes.
- **One GitHub release per version.** Its assets are the Tauri installer for Windows, Electron builds for macOS and Linux, and the Android APK. Each updater must only ever see its own files (5.6).

---

## 1. Summary

The Electron layer is small: `electron/` holds 941 lines in 6 files. The app's real logic sits in two places that both carry over:
- the renderer (`public/`);
- the local HTTP server (`server.js`, `subtitles.js`). It is plain Node 18 with no npm dependencies, and **the same file runs on Android TV** (nodejs-mobile 18.20.4).

| Fact | Consequence |
|---|---|
| The UI loads from `http://127.0.0.1:47831` (`electron/main.js:16,80`). The server rejects anything that is not same-origin (`server.js:1010-1022`). | Keep that origin in Tauri: `WebviewUrl::External` plus a `remote.urls` capability. **Verified in spike 0.1:** `invoke` and the same-origin guard both work. |
| Playlists, favourites, history and settings live in **Chromium localStorage and IndexedDB** under `%APPDATA%\Tuner IPTV` (`main.js:20`, `public/js/core.js:26-50`). | WebView2 uses its own profile, so it cannot see that data. **A final Electron "bridge" release for Windows must export it**, or Windows users lose their playlists. |
| ffmpeg is spawned for probing, keyframes, transcoding and subtitles. Media must flow over HTTP with Range and backpressure. | Keep a localhost HTTP server. Never send media over Tauri IPC. ffmpeg becomes an `externalBin` sidecar. |
| PiP moves the live `<video>` element into an `about:blank` popup (`public/js/player.js:476-496`). Mirror uses `window.opener` plus `video.captureStream()` (`player.js:586,600`, `public/mirror.js:15,85,132`). | These need opener-linked popups (Tauri `on_new_window`, spike 0.2). `captureStream` works in WebView2 (spike 0.1). |
| The renderer reaches the desktop layer through one object, `window.tunerDesktop`. It has 34 members (`electron/preload.js:6-46`), and `public/js/tv.js:29-127` already re-implements that contract for Android. | Write a `public/js/tauri-shell.js` adapter with the same shape on top of `__TAURI__`. The same renderer then runs under Tauri on Windows, Electron on macOS and Linux, and Android. |

**Recommended server strategy: hybrid (option C in Appendix D).**
- At first, run `server.js` unchanged as a Node sidecar binary.
- Write the shell (window, updater, dialogs, sync, migration) in Rust.
- Later, and optionally, port routes to a standalone `aghorizon-server` axum crate.

---

## 2. Phased checklist

Each phase ends with a **gate**. Do not start the next phase until the gate passes. Unless a task says otherwise, it is about the Windows build.

### Phase 0: Spikes, decisions and a quick win

- [x] **0.1 Media spike.** The harness is in `spike/media/` and the results in [`RESULTS.md`](spike/media/RESULTS.md). CI now runs it on Windows only (WebView2, with and without the planned browser flags).
  - **Windows (WebView2): go.**
    - Native, hls.js and mpegts.js all play with sound.
    - Autoplay works without a gesture.
    - Multiview 4 × mpegts.js plays 4/4.
    - Compatibility mode works.
    - `captureStream`, `requestPictureInPicture` and `navigator.wakeLock` work.
    - `invoke` from the `remote.urls` origin works.
  - **Confirmed:** keep `--enable-blink-features=AudioVideoTracks`. Without it `video.audioTracks` is missing and switching sound tracks breaks.
  - **Found:** undecodable HEVC gives sound with no picture and **no `error` event**, so the H.264 fallback in `player.js` never fires. → 0.7.
  - **To check by hand on a real PC:** HEVC with the HEVC Video Extensions and a GPU, and AC-3 (the CI VM has neither). Today the app converts both, as Electron does.
  - macOS and Linux results are recorded for Phase 9.
- [x] **0.2 Popup spike (WebView2): go.** The spike is `spike/media/page/popup.js` plus `on_new_window` in `spike/media/tauri/src/main.rs`; it runs in CI as `windows-webview2-popups`. Results are in [`RESULTS.md`](spike/media/RESULTS.md#phase-02-popups).
  - **With no handler, Tauri refuses `window.open`** (returns `null`), so PiP and Mirror do nothing until 4.3 and 4.4 are done.
  - **`on_new_window` → `NewWindowResponse::Create`** with a `WebviewWindowBuilder` (`.window_features(features)`, `decorations(false)`, `always_on_top`) keeps PiP and Mirror working **as built**, twice in a row:
    - the app writes into `about:blank` at once, and the document is not replaced later;
    - `movePlayer` moves the playing `<video>` in, and it keeps playing;
    - `pagehide` fires on close;
    - the Mirror calls `window.opener.*`, reads the opener's document, and shows the `captureStream()` picture;
    - Rust can set the Mirror window fullscreen.
  - **Bug found: closing the popup (`window.close()`) leaves the Tauri window visible on screen.** Fix, verified: fixed labels `pip` and `mirror`, and Rust destroys the window when the page closes it (4.3, 4.4).
  - `NewWindowResponse::Allow` (WebView2's own popup) also keeps the opener link, but Tauri cannot make it frameless, on top or fullscreen. Don't use it.
  - `window.moveTo` does not move a Tauri-created window. Mirror's drag must use `startDragging()` (4.4).
- [x] **0.3 Server strategy: C, hybrid, starting with a Node sidecar. Proven on Windows.** The code is in `sidecar/`; CI runs `.github/workflows/sidecar.yml` ([run #1](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44108337313)).
  - **Entry:** `sidecar/entry.js` takes a port, prints `READY <port>` or `ERROR <code> <message>` (exit 1), and **exits when its stdin closes**.
  - **Build:** `sidecar/build.js` bundles it with esbuild into 64 KB of JS. `ffmpeg-static` and `secrets.json` are left out: `FFMPEG_PATH` and `TMDB_API_KEY` / `OPENSUBTITLES_API_KEY` come as env. Node 22's SEA then makes `aghorizon-server-x86_64-pc-windows-msvc.exe`, the name `externalBin` expects.
  - **`server.js` changed in one line:** `PUBLIC_DIR` comes from env, with the same default as before (Electron and Android unaffected; `npm test` unchanged).
  - **Windows results** (`sidecar/smoke.js` against the built `.exe`, 13/13):
    - starts with READY in 81 ms;
    - serves the UI and scripts from `PUBLIC_DIR`, and `/api/fetch`, `/api/stream`, `/api/probe` and `/api/transcode` all work through ffmpeg from `FFMPEG_PATH`;
    - API keys from env;
    - the static path guard holds;
    - a second copy on the same port prints `ERROR EADDRINUSE` and exits 1;
    - closing stdin ends it, and **killing the parent ends it within 102 ms**, so no orphan.
  - **Size:** 83.2 MB on disk, **32.7 MB compressed**. That's almost all Node itself (Linux: 119 MB / 40.8 MB). This is the cost Phase 8 would remove.
  - **To carry into 2.3 / 5.6:**
    - The injection breaks `node.exe`'s Authenticode signature ("signature seems corrupted"). Strip it in CI before injecting (`signtool remove /s`), and sign the result if the app is ever signed.
    - Pin the Node version used to build (currently 22).
    - The downloads engine (`setLocalFiles`, `/api/local`) isn't wired into the sidecar yet; that's 3.5.
- [x] **0.4 ffmpeg: approved. Keep today's build.** That's the gyan.dev "essentials" FFmpeg 6.1.1 (GPL v3, libx264, gnutls), from `github.com/eugeneware/ffmpeg-static` release `b6.1.1`, pinned by checksum ([`MIGRATION_DECISIONS.md`](MIGRATION_DECISIONS.md#04-which-ffmpeg-to-ship)). The GPL source archive ships **with the first Tauri release** (5.9).
  - `ffmpeg-win32-x64.gz` sha256 `8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77`; unpacked `ffmpeg.exe` sha256 `04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00` (79.0 MB).
  - `win32-x64.LICENSE` sha256 `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`; `win32-x64.README` sha256 `a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311`.
- [x] **0.5 Title bar: approved.** A frameless window (`decorations(false)`, `shadow(true)`) with HTML minimise/maximise/close buttons in the existing 42 px top bar, shown only under Tauri. There's no Windows 11 snap-layout hover menu; `tauri-plugin-decorum` can add it later if people ask ([`MIGRATION_DECISIONS.md`](MIGRATION_DECISIONS.md#05-title-bar)). → 4.2.
- [x] **0.6 Beta channel: approved.** Stable reads `releases/latest/download/latest.json`. Test finds the newest published release (beta or stable) through the GitHub API, as `manualCheck` does today, uses that release's `latest.json`, and falls back to Stable on any error ([`MIGRATION_DECISIONS.md`](MIGRATION_DECISIONS.md#06-beta-update-channel)). → 5.4.
- [x] **0.7 Quick win in the shared code (ship it in Electron now).** Done in `public/js/player.js` (`armKeptHevcCheck`, `tcHevcToH264`). Checked with `spike/media/check-hevc-watchdog.js`: before the change the film stays on `transcode video=hevc` with no picture; after it, it switches to H.264 at about 8.5 s and shows the picture. An H.264 film still plays natively.
  - Add a watchdog for silent decode failures in `player.js`: "playing, but `videoWidth` still 0 after ~4 s" counts as an error, so the HEVC → H.264 fallback runs.
  - Today the fallback only listens for `video.onerror`, which Chromium never fires for undecodable HEVC.
  - This helps every platform today, independent of the migration.
- [x] **Gate: passed for Windows.** Media go (0.1), popups go (0.2), server sidecar proven (0.3), decisions 0.4–0.6 approved. Any feature that cannot reach parity gets a documented degradation (Appendix E).

### Phase 1: Bridge Electron release for Windows (ships *before* any Tauri build)

This is the last Windows Electron version, for example `2.9.0`, on **both** the stable and test channels. Its job is to make data migration possible.

It changes nothing a user notices until a Tauri release exists. The code is portable; the export runs only on Windows (or with `AGH_MIGRATION_EXPORT=1`), and the hand-over only on Windows with the updater public key present.

- [x] **1.1 Export renderer storage** (`electron/migration.js`).
  - `EXPORT_SCRIPT` runs in the page through `webContents.executeJavaScript`, so there are no preload or renderer changes. It collects every localStorage key, plus every record of IndexedDB `tuner/files` (playlist file text and the downloads' `dlinfo` map).
  - It writes `{ format: 1, appVersion, exportedAt, origin, localStorage, indexedDB }` atomically to `%APPDATA%\Tuner IPTV\migration.json`.
  - **When:** 5 s after start and every 10 minutes, plus at hand-over. **Changed from the plan's "on `before-quit`":** an async page script during quit could get in the way of electron-updater's quit-and-install. The worst case is losing the last ≤10 minutes before a *manual* Tauri install; the hand-over itself exports right before running the installer.
  - `IMPORT_SCRIPT` (for 6.2) lives in the same file. It never overwrites keys or records the new app already has.
- [x] **1.2 Sync code: exported only at hand-over.** `sync.readCode()` (pulled out of the `sync:code:get` handler) decrypts it with `safeStorage`, and it goes into `migration.json` as `syncCode` **only right before the installer runs**, never on an ordinary start. That keeps today's at-rest protection for everyone who doesn't move. Users who install Tauri by hand re-enter it (6.3). The Tauri side must store it in Credential Manager and remove it from `migration.json` after import (6.3).
- [x] **1.3 Updater hand-over (Windows)** (`electron/handover.js`, wired into `electron/updater.js`).
  - **Check:** the newest published release on the user's channel that carries a Tauri `latest.json` (test: newest of all published; stable: GitHub's latest), newer than the running version. It is offered through the existing `available` → `downloading` → `ready` states, so there are no UI changes. If there's none, electron-updater runs as before.
  - **Download:** the installer is accepted only from `https://github.com/<owner>/<repo>/releases/download/…`. It is hashed (BLAKE2b-512) while downloading, then **its minisign signature is verified** against `electron/tauri-updater.key.pub`, the same check Tauri's updater makes. Electron 45's BoringSSL has no `blake2b512`, so `electron/blake2b.js` provides a plain-JS one, checked against Node's.
  - **Install:** export with the sync code first. **If the export fails, nothing is installed.** Then run the installer with `/P`, and quit.
  - **Off until `electron/tauri-updater.key.pub` exists** (see 1.0 below).
- [ ] **1.0 Before the bridge ships: create the Tauri updater key pair** (moved up from 5.1, because the bridge must embed the public key).
  - **You run:** `npx @tauri-apps/cli signer generate -w ~/.tauri/aghorizon.key`. Keep the private key and its password safe, and store them as the CI secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. If they are lost, users can no longer be updated.
  - **Commit:** the **public** key (`aghorizon.key.pub`) as `electron/tauri-updater.key.pub`. It also goes into `plugins.updater.pubkey` in Phase 5.
- [ ] **1.4** Ship the bridge (with 1.0 done) on both channels, and leave it out for at least one release cycle before the first Tauri release.
- **Checks:**
  - `npm test`: 67/67, including `test/handover.test.js`: signatures made by `tauri signer` (throwaway key in `test/fixtures/handover/`), tampering, wrong key, an edited trusted comment, release choice per channel, and the installer URL guard.
  - Signature verification also checked inside Electron 45 itself.
  - `spike/migration/check-roundtrip.js` (Chromium, real UI): Xtream credentials with special characters, a 3 MB file playlist, favourites, history, progress and settings all survive export → empty profile → import, 13/13. A second import doesn't overwrite.
  - `spike/migration/check-electron-export.js`: the real Electron app writes `migration.json` with the stored data and no sync code. Linux done; Windows in `.github/workflows/bridge.yml`.
  - **Not testable before a Tauri release exists:** the full download → verify → install path against a real release. That is covered by the Phase 6 gate (Electron 2.5 → bridge → Tauri on clean VMs).
- [ ] **Gate:** `migration.json` appears on Windows with real data (CI: `bridge.yml`), the round trip restores everything (done), and 1.0 is done.

### Phase 2: Tauri scaffold and server sidecar

- [ ] **2.1** `npm i -D @tauri-apps/cli@^2`, then `npx tauri init`. This creates `src-tauri/`:
  - identifier **`app.aghorizon.desktop`** (the same as electron-builder's `appId`)
  - `"version": "../package.json"`, so there is one version source shared with Electron and Android (`android/app/build.gradle.kts:11-14`)
  - `productName "AG Horizon"`
- [ ] **2.2** `npx tauri icon build/icon.png`.
- [ ] **2.3 Sidecars** in `bundle.externalBin`:
  - `binaries/aghorizon-server-x86_64-pc-windows-msvc.exe` (Node SEA of `server.js`)
  - `binaries/ffmpeg-x86_64-pc-windows-msvc.exe`: CI downloads `ffmpeg-win32-x64.gz` from `ffmpeg-static` release `b6.1.1` and checks the sha256 recorded in 0.4. Not via `npm install`: `ffmpeg-static` leaves the Windows build.
  - Other targets are added in Phase 9.
- [ ] **2.4 `server.js` changes.** Each must stay Node 18 compatible (Android) and keep working in-process under Electron (macOS and Linux).
  - [x] Read `PUBLIC_DIR` from env, defaulting to the current `__dirname/public` (`server.js:21`; done in 0.3).
  - [ ] Make `ffmpeg-static` optional, using `FFMPEG_PATH` first. That code path already exists at `server.js:647`.
  - [x] CLI entry `sidecar/entry.js`: `READY <port>` / `ERROR <code>` on stdout (done in 0.3).
  - [x] Exit when stdin closes; this also covers a killed parent on Windows (102 ms in 0.3).
- [ ] **2.5 Rust `setup()`.**
  - Spawn the server sidecar (`tauri-plugin-shell`), passing env: port 47831 (`TUNER_PORT` override), `PUBLIC_DIR` = resource dir, `FFMPEG_PATH` = resolved sidecar path, `TMPDIR`, and the API keys.
  - Wait for `READY` before creating the window.
  - On `EADDRINUSE`, show a `tauri-plugin-dialog` error and `app.exit(1)`, as `main.js:197-205` does.
  - Keep the sidecar's stdin piped and never close it while the app runs: its end is how the server notices the app has gone (0.3). A Windows Job Object is optional extra safety, and it also covers ffmpeg children if the server itself is killed.
- [ ] **2.6** Bundle `public/**` as `bundle.resources`. Keep `npm run setup` (vendored hls.js and mpegts.js) as a pre-build step.
- [ ] **2.7 Main window** from `WebviewWindowBuilder`:
  - `WebviewUrl::External("http://127.0.0.1:47831/")`
  - `visible:false`, 1280×800, min 760×520, background `#0c0e12`
  - `drag_drop_enabled(false)`. **This is required**, so that HTML5 `.m3u` drops (`boot.js:15-42`) and drag-reordering (`downloads.js:387-394`) keep working.
  - `additional_browser_args`: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=PlatformHEVCDecoderSupport --enable-blink-features=AudioVideoTracks --autoplay-policy=no-user-gesture-required`. Tauri's own defaults come first, because setting this replaces them. This exact string was tested in spike 0.1.
- [ ] **2.8 Capabilities.** `src-tauri/capabilities/main.json` for window `main` with `remote.urls: ["http://127.0.0.1:47831/*"]` (Appendix B; the pattern is proven in `spike/media/tauri/`). Give `pip` and `mirror` a separate minimal capability.
- [ ] **2.9** `on_navigation`: block navigation away from the origin and send http(s) URLs to `tauri-plugin-opener`, replacing `main.js:143-145`.
- [ ] **2.10** Register `tauri-plugin-single-instance` **first**. Its callback calls unminimize, show and set_focus on `main` (replaces `main.js:27-30,154-156`).
- [ ] **2.11 Exit handling** (`RunEvent::ExitRequested` / `Exit`): stop the sidecar gracefully, and flush downloads to the "queued" state, replacing `downloads.js:410` and `main.js:215`.
- [ ] **Gate:** on Windows the app starts, the dashboard renders, live TV plays through `/api/stream`, compatibility mode transcodes through the ffmpeg sidecar, and there are no orphan processes after quit or kill. The Electron build on macOS and Linux still passes `npm test` and a smoke run.

### Phase 3: Bridge adapter and IPC commands

All 34 preload members are listed in Appendix A.

- [ ] **3.1** Set `app.withGlobalTauri: true`.
- [ ] **3.2** Add `public/js/tauri-shell.js` and load it right after `tv.js` in `public/index.html:428`.
  - It defines `window.tunerDesktop` with the exact `preload.js` shape, using `__TAURI__.core.invoke` and `__TAURI__.event.listen`.
  - It does nothing when `window.AGHorizonTV` exists (Android), when `__TAURI__` is missing (Electron, browsers), or when Electron's preload has already defined `tunerDesktop`.
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
  - `sync_code_get` / `sync_code_set`: use the `keyring` crate (Windows Credential Manager), which replaces `safeStorage`.
  - `sync_folder_choose`: use `tauri-plugin-dialog`, and save to `sync.json` in `app_config_dir`.
  - `sync_folder_list` / `sync_folder_put` / `sync_folder_remove`.
  - Keep the validation from `sync.js:17-29`: hex vault (64 chars), hex device (16-32 chars), and atomic tmp+rename writes.
  - **Binary blobs:** the adapter sends `Array.from(blob)` (or base64) and converts results back to `Uint8Array`. A raw `Uint8Array` inside an object serialises as `{"0":…}`.
- [ ] **3.5 Downloads**, recommended for the hybrid strategy:
  - [ ] **Where it runs:** keep the engine in Node, inside the sidecar. Refactor `electron/downloads.js` into an injectable module (no direct `require('electron')`), used **both** by Electron (macOS/Linux) and by the sidecar, so there is one engine and `test/downloads.test.js` keeps covering it.
  - [ ] **Control routes:** the sidecar exposes `/internal/downloads/*`, guarded by a per-launch random token passed through env. Thin Rust commands forward to those routes.
  - [ ] **Change events:** `downloads:changed` snapshots go to the sidecar's stdout as JSON lines, and Rust re-emits them with `app.emit_to("main", "downloads:changed", …)`, throttled to 500 ms.
  - [ ] **Rust-only actions:** folder picking (`dialog.pick_folder`), `reveal` (`opener.reveal_item_in_dir`) and `openFolder` (`opener.open_path`). Rust resolves the id to a path, and the renderer never names a path.
  - [ ] **Validation to keep:**
    - http(s)-only URLs (`downloads.js:282-285`)
    - the under-folder check in `adopt` (`downloads.js:100`)
    - free space (`fs.statfs`)
- [ ] **3.6 Updater commands.** These are built in Phase 5. Until then, stub them so `app_info.updater = false` and the manual check path works.
- [ ] **3.7 Tests.**
  - Update `test/tv.test.js:32`, which asserts `tunerDesktop` is undefined outside the TV app.
  - Add a node test that loads `tauri-shell.js` with a fake `__TAURI__` and asserts the 34-member shape.
  - Add a test that the adapter is a no-op without `__TAURI__`.
- [ ] **Gate:** every flow works in Tauri on Windows, and still works in Electron on macOS and Linux:
  - Settings: downloads (add, pause, resume, reorder, remove, reveal, choose folder, orphans and adopt, pause while watching)
  - Sync: cloud mode and folder mode, set and clear the code
  - About: version, channel, manual update check

### Phase 4: Windows, title bar and OS integration

- [ ] **4.1 Window state.** Use `tauri-plugin-window-state` with `SIZE|POSITION|MAXIMIZED` (not `VISIBLE`, so `app_ready` still controls showing the window). Denylist `pip` and `mirror`. Import the legacy `%APPDATA%\Tuner IPTV\window-state.json` once.
- [ ] **4.2 Title bar** (decided in 0.5; details in [`MIGRATION_DECISIONS.md`](MIGRATION_DECISIONS.md#05-title-bar)).
  - `main`: `decorations(false)`, `shadow(true)`.
  - Three buttons at the right of `#topbar`, 46×42 px, rendered only under Tauri (the adapter sets a class on `<html>`; Electron on macOS/Linux keeps its native overlay).
    - Theme hover colours; close turns red on hover.
    - `minimize()` / `toggleMaximize()` / `close()`; the maximise icon swaps to "restore" while maximised.
    - `aria-label`s, and reachable by keyboard.
  - `data-tauri-drag-region` on `#topbar` next to the existing `-webkit-app-region: drag` (`public/style.css:101-104,835-836,939`, `public/mirror.html:21`). It drags, and double-click maximises (Tauri 2.12 `drag.js`).
  - Under Tauri, replace the `env(titlebar-area-*)` padding with the buttons' width. `tunerDesktop.titleBar` is a no-op.
  - Check in the gate: resizing from every edge and corner, Aero Snap by dragging and with Win+arrows, maximising on a second monitor, and that dragging never starts on a button.
- [ ] **4.3 PiP** (`player.js:465-534`, Electron options `main.js:86-95,117-124`). The design is proven by spike 0.2.
  - [ ] **`on_new_window` on `main`:** for `about:blank`, build `WebviewWindowBuilder::new(app, "pip", WebviewUrl::External("about:blank"))` with `.window_features(features)` (required: it gives the popup the opener's WebView2 environment), `decorations(false)`, `always_on_top(true)`, `inner_size(480, 270)` and `min_inner_size(260, 146)`. Return `NewWindowResponse::Create`. Deny any other URL that isn't the app's own `/mirror.html`.
  - [ ] **Close:** `window.close()` leaves the Tauri window on screen (spike 0.2), so destroy the `pip` window from Rust when the page closes it. The adapter calls a `close_popup("pip")` command on the window's `pagehide`; Rust can also do it on the webview's close request. Without this the next PiP can't be created either, because the label is taken.
  - [ ] **Position:** bottom-right of `current_monitor().work_area()` with a 24 px margin.
  - [ ] Tauri has no `setAspectRatio`, so clamp to 16:9 on `WindowEvent::Resized`.
  - [ ] Give `pip` its own minimal capability: window dragging only, no app commands.
- [ ] **4.4 Mirror** (`player.js:546-623`, `mirror.js`, `main.js:98-141`). Proven by spike 0.2, including `captureStream()` from the main window, `window.opener` calls and fullscreen from Rust.
  - [ ] **`on_new_window`:** for `/mirror.html`, build the `mirror` window the same way as PiP (`.window_features(features)`, `decorations(false)`, 960×540); on top only for the floating mirror (no `?d=`).
  - [ ] **Close:** destroy the `mirror` window from Rust when the page closes it (same bug as PiP).
  - [ ] **Display picker:** `?d=` carries the new monitor key (`name + position`; Windows names look like `\\.\DISPLAY1`). Rust sets position and size from the `Monitor`, then `set_fullscreen(true)`.
  - [ ] **Drag:** `window.moveTo` does nothing for a Tauri window (spike 0.2). Under Tauri, replace the manual drag (`mirror.js:21-33`) with `getCurrentWindow().startDragging()`, keeping the old code path for Electron. Drop the `content-bounds-updated` hack on the Tauri side.
  - [ ] Closing `main` closes `pip` and `mirror` (replaces `main.js:148-151`).
- [ ] **4.5 Fullscreen.** In the adapter, mirror `document.fullscreenElement` to `getCurrentWindow().setFullscreen()`, because WebView2's element fullscreen fills only the webview.
- [ ] **4.6 Keep-awake.**
  - `navigator.wakeLock` works in WebView2 (spike 0.1), so it can be used directly.
  - Add a Rust `keep_awake(on: bool)` using the `keepawake` crate as a fallback, and for Phase 9, where WebKit denies `wakeLock`.
  - Call it on `playing`, `pause` and `ended` from `player.js` and `multiview.js`.
- [ ] **4.7 External links.** `window.open(..., '_blank')` for trailers (`workspace.js:831`) goes to the opener plugin, and so do `updater:open` and any other http(s) URL.
- [ ] **4.8 Multiview robustness.** Add a per-tile retry in `multiview.js`. It costs little on Windows and is required for Linux in Phase 9.
- [ ] **Gate:** a manual QA pass on Windows 10 and 11:
  - PiP, and Mirror to a second monitor;
  - fullscreen player and Multiview;
  - no screensaver during playback;
  - window state restored, and a second launch focuses the first;
  - `.m3u` drag-drop works.

### Phase 5: Updater, packaging and CI (mixed release)

- [ ] **5.1 Signing.** The key pair already exists from 1.0. `npx tauri signer generate`. Put the pubkey in `plugins.updater.pubkey`, and add the CI secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Document key custody in `RELEASING.md` next to the Android keystore: if the key is lost, updates stop.
- [ ] **5.2** Set `bundle.createUpdaterArtifacts: true`, and `plugins.updater.windows.installMode: "passive"`.
- [ ] **5.3 Rust updater commands.** They keep the status shape `{state, version, percent, notes, manual, checkedAt, message}` and push `updater:status` events.
  - [ ] `updater_check`: `updater_builder().endpoints([url_for(channel)])`.
  - [ ] `updater_download`: `update.download(on_chunk → percent, …)`, with the bytes kept in managed state.
  - [ ] `updater_install`: run the exit cleanup (2.11) **first**, because NSIS kills the process. Then `install()`.
  - [ ] `updater_set_channel`, `updater_status`.
  - [ ] Install-on-quit: if bytes are pending at `ExitRequested`, call `install()`. This replaces `autoInstallOnAppQuit`.
  - [ ] `updater:notes`, `manualCheck` and `updater:open` stay plain GitHub REST calls. Port them to Rust with `reqwest`, or reuse the renderer JS in `tv.js:43-116`. Keep `electron/versions.js` semantics (the `semver` crate orders versions the same way) and `test/versions.test.js`.
- [ ] **5.4 Channels** (decided in 0.6).
  - **Stable:** `https://github.com/Andreas-Graesmo/AGHorizon/releases/latest/download/latest.json`.
  - **Test:**
    1. `GET https://api.github.com/repos/Andreas-Graesmo/AGHorizon/releases?per_page=30` (with `User-Agent: AG-Horizon`).
    2. Skip drafts and releases without a `latest.json` asset; take the highest version (`semver`, same order as `electron/versions.js`).
    3. If it is newer than the running version, `updater_builder().endpoints([that asset's URL])`.
    4. On any error (offline, API limit), use the Stable endpoint.
  - The default comparator (strictly newer only) keeps "never downgrade", and Test still gets stable releases (`RELEASING.md:72`).
- [ ] **5.5 Bundle targets:** `nsis` only. **No `msi`**, because WiX rejects `-beta.N` versions. Set `webviewInstallMode: embedBootstrapper` (about +1.8 MB).
- [ ] **5.6 Rewrite `.github/workflows/release.yml` as a mixed release.**
  - [ ] **Windows job:**
    - Rust toolchain: `dtolnay/rust-toolchain@stable`, `swatinem/rust-cache@v2`.
    - Build the Node SEA server sidecar, and download plus checksum-verify the ffmpeg sidecar.
    - Run `tauri-apps/tauri-action@v0` with `tagName`/`releaseName` = `github.ref_name`, `releaseDraft: true`, `prerelease: contains(ref_name,'-')` and `includeUpdaterJson: true`.
  - [ ] **macOS and Linux jobs:** keep electron-builder, but with `--mac` / `--linux` only, so it never builds or publishes a Windows Electron installer or `latest.yml` / `beta.yml`.
    - It still publishes `latest-mac.yml`, `latest-linux.yml`, `beta-mac.yml` and `beta-linux.yml`, which the Electron updaters on those platforms read.
  - [ ] **Updater rule:** the Tauri `latest.json` lists only `windows-x86_64`. Old Windows Electron clients see only the bridge release (1.3), and must never find a Windows Electron `latest.yml` in a newer release.
  - [ ] **Keep:** `npm ci` with retries, `npm test`, `npm run setup` (vendor), the `secrets.json` step, `android-tv` and `publish-test`. Align the release title across all jobs.
- [ ] **5.7 Asset names.** Use tauri-action `assetNamePattern`, or rename after the build, so the Windows installer stays `AG-Horizon-Setup-<v>.exe`. The website regex (`docs/site.js:18`, `/setup.*\.exe$/`) and `README.md:22-24` then keep working. The macOS and Linux names don't change.
- [ ] **5.8 `android.yml`:** no change while Electron stays in `package.json`.
- [ ] **5.9 Licensing: ffmpeg GPL source with the first Tauri release** (decided in 0.4).
  - [ ] Ship `win32-x64.LICENSE` (GPL v3) next to the ffmpeg sidecar, and name ffmpeg and its licence on the About page and in the README.
  - [ ] Build the **corresponding source archive** once, and attach it to a pinned release `ffmpeg-6.1.1-gyan-essentials-source` that every Tauri release's notes link to:
    - FFmpeg at commit `e38092ef93` (`win32-x64.README`);
    - the 33 libraries whose exact versions that README lists (x264 `v0.164.3172`, x265 `3.5-153-gce8642f22`, libvpx `v1.13.1-601-g655da33b8`, aom, opus, lame, …), fetched by a script at those versions.
  - [ ] **Open:** about 8 bundled libraries have **no version** in the README: gnutls, gmp, libxml2, zlib, xz/lzma, bzip2, iconv and fontconfig. Ask gyan.dev for their exact sources or versions.
    - If they can't be had, switch the sidecar to a build whose recipe pins every source, such as BtbN FFmpeg-Builds (option B in the decision). That means re-running the media spike, and decision 0.4 is revisited.
  - [ ] Keep the license file and README hashes from 0.4 with the archive, so it's clear which binary it belongs to.
- [ ] **Gate:** a `v*-beta` tag produces one draft containing the Windows Tauri installer with `.sig` and `latest.json`, the Electron dmg and AppImage with their `*-mac.yml` / `*-linux.yml`, and the APK.
  - The Tauri build updates itself from N to N+1 on both channels.
  - An Electron macOS or Linux build updates itself from N to N+1, and does not see the Windows assets.

### Phase 6: Data migration on first Tauri launch (Windows)

- [ ] **6.1 Plain files.** If `app_data_dir/migrated` is missing, copy `downloads.json`, `sync.json` and `window-state.json` from `%APPDATA%\Tuner IPTV`. Download files stay where they are; the paths in `downloads.json` are absolute.
- [ ] **6.2 Renderer storage.**
  - Rust command `migration_payload()` returns the parsed `migration.json`, once.
  - Before `core.js` reads storage, the adapter writes every `tuner.*` key to localStorage and refills IndexedDB `tuner/files`, then calls `migration_done()`.
  - Do not overwrite keys that already exist; a user may have opened the Tauri app first.
- [ ] **6.3 Sync code.** Read it from the Credential Manager entry or the export written in 1.2. If it is missing, sync turns off cleanly (`sync.js:360-363`). Show a one-time "re-enter your sync code" notice.
- [ ] **6.4 No bridge export found** (the user skipped 2.9.0). Show a one-time dialog: "Open the previous version once, or restore from sync." Optional and fragile: parse the Chromium LevelDB with `rusty-leveldb`.
- [ ] **6.5 Windows installer handover.** Add a Tauri NSIS hook (`NSIS_HOOK_POSTINSTALL`) that:
  - finds the electron-builder uninstaller through the HKCU Uninstall key (GUID derived from `app.aghorizon.desktop`);
  - runs `Uninstall AG Horizon.exe /S`;
  - **never deletes `%APPDATA%\Tuner IPTV`**;
  - fixes the Start menu and desktop shortcuts.
- [ ] **Gate:** run the full upgrade on clean Windows 10 and 11 VMs, Electron 2.5.x → bridge 2.9.0 → Tauri 3.0.0-beta.1:
  - playlists, file playlists, favourites, history, settings, theme, downloads list, sync folder and sync code all survive;
  - exactly one app is installed.

### Phase 7: Windows rollout

- [ ] **7.1** Ship Tauri for Windows on the **test channel** first (`3.0.0-beta.N`), for at least 2 beta cycles.
- [ ] **7.2** Watch for media regressions on real hardware (HEVC, AC-3, GPUs), WebView2 runtime issues and upgrade problems.
- [ ] **7.3** Promote to stable: publish the stable Tauri release, and point the stable bridge release's handover at it.
- [ ] **7.4** Update `README.md` ("Windows: built with Tauri; macOS and Linux: Electron, moving later"), `RELEASING.md` (mixed release) and `docs/`.
- [ ] **Gate:** two weeks of stable on Windows with no data-loss reports.

### Phase 8 (optional): Port the server to Rust

Do this only if bundle size or the two-process design hurts. The Node SEA adds roughly 30-45 MB compressed. Electron on macOS and Linux keeps running `server.js` in-process until Phase 9, so the JS server stays the reference implementation.

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
- [ ] **8.5** Move the downloads engine to Rust, then drop the Node sidecar.
- [ ] **Gate:** both servers pass the same contract tests, with no regressions in compatibility mode or Multiview shared mode on real providers.

### Phase 9 (later): macOS and Linux on Tauri

Start this only when there is demand. Everything the spike found for these platforms is collected here.

- [ ] **9.1 Re-run the media spike** on both: restore the macOS and Linux jobs in `.github/workflows/media-spike.yml` (see the git history), or run `spike/media/` on a Mac and a Linux desktop. Repeat the popup spike (0.2) on WKWebView and WebKitGTK.
- [ ] **9.2 Compatibility mode on WebKit (blocking on macOS).**
  - WKWebView refuses `/api/transcode` as a plain `<video src>` (media error 4, fMP4 included), because the stream has no byte ranges and no length.
  - Play the conversion through MSE (fetch, then `appendBuffer` into a `SourceBuffer`, or `ManagedMediaSource` on macOS). That works on WebView2 and WebKitGTK but is **not yet verified on macOS**.
  - Alternatively, have ffmpeg write HLS (fMP4 segments) and play that natively.
  - The output must be fMP4 on WebKit: Matroska fails there.
- [ ] **9.3 Multiview on Linux (blocking on Linux).**
  - WebKitGTK can freeze its whole web process when several MSE players run at once; this reproduced on a clean CI runner.
  - Play tiles from the server's progressive output (`/api/transcode?video=copy`) instead of MSE, and verify that this avoids the freeze. If it doesn't, cap Linux at 1–2 tiles.
- [ ] **9.4 Mirror.** `video.captureStream()` is missing on both WebKits. Use `canvas.captureStream()` fed from the `<video>` (it works on both; A/V sync and CPU cost are unmeasured), or hide Mirror.
- [ ] **9.5 PiP.** WKWebView has `requestPictureInPicture`; WebKitGTK has no PiP API, so hide the button on Linux unless the opener popup works.
- [ ] **9.6 Keep-awake.** `navigator.wakeLock` is denied on both, so use the `keepawake` command from 4.6.
- [ ] **9.7 Window chrome and lifecycle.**
  - macOS: `titleBarStyle: "Overlay"` with a traffic-light inset. Keep Tauri's default app menu (Edit shortcuts, Cmd+Q). Optionally `RunEvent::Reopen` and `prevent_exit()`.
  - Linux: HTML buttons as on Windows.
  - Add `tauri-plugin-clipboard-manager` if `navigator.clipboard` needs a gesture that the app's flows don't give.
- [ ] **9.8 Packaging.**
  - Add sidecars for `aarch64-apple-darwin` and `x86_64-unknown-linux-gnu`.
  - Bundle targets: `app`, `dmg` and `appimage`, with `bundle.linux.appimage.bundleMediaFramework: true` (GStreamer; WebKitGTK decodes HEVC/AC-3 only with `gst-libav`/`-bad`).
  - macOS: `signingIdentity: "-"`.
  - Build Linux on `ubuntu-22.04` for the glibc baseline, with `libwebkit2gtk-4.1-dev librsvg2-dev patchelf` and the GStreamer packages.
  - Keep the asset names (`AG-Horizon-<v>-arm64.dmg`, `AG-Horizon-<v>.AppImage`); otherwise `docs/site.js:18` breaks.
- [ ] **9.9 Updater.**
  - macOS: the minisign updater works without Apple signing. Keep notify-only when the bundle path is under `/Volumes/` or `AppTranslocation`.
  - Linux: self-update works for the AppImage only.
  - Stop publishing `*-mac.yml` and `*-linux.yml` once the handover (9.10) is out.
- [ ] **9.10 Bridge and migration.**
  - Extend 1.3 with the Linux handover (new AppImage next to `$APPIMAGE` with the **same file name**, `chmod +x`, spawn, quit) and a macOS banner linking to the new `.dmg`.
  - Extend 6.1 with `~/Library/Application Support/Tuner IPTV` and `~/.config/Tuner IPTV`.
  - Sync code via Keychain or Secret Service.
- [ ] **Gate:** the Phase 2–7 gates, repeated on macOS and Linux.

### Phase 10: Remove Electron (after Phase 9)

- [ ] **10.1** Delete `electron/`. Remove `electron`, `electron-builder`, `electron-updater`, the `build` block and `allowScripts` from `package.json`. Make `ffmpeg-static` dev-only, or drop it in favour of the CI download.
- [ ] **10.2** Update the tests:
  - `test/downloads.test.js` stubs `require('electron')`; point it at the refactored module from 3.5.
  - `test/server.test.js:13-16` checks the publish target for `electron/updater.js`.
  - `test/versions.test.js` moves along with `versions.js`.
- [ ] **10.3** Update `package.json` scripts: `start` → `tauri dev`, `dist*` → `tauri build`. Keep the `release:*` version scripts. Drop `ELECTRON_SKIP_BINARY_DOWNLOAD` from `android.yml:45`.
- [ ] **10.4** Remove the update-handover code paths once issue reports show the bridge releases have drained. Keep them published.

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
  - optional: `os`, `decorum`; `clipboard-manager` in Phase 9
  - **Do not** grant `fs:*` or a generic `shell:*` to the webview.
- **Crates:**
  - `keyring` (sync code), `keepawake`, `hostname`, `serde`, `serde_json`, `tempfile` (atomic writes), `dirs` (legacy paths)
  - Phase 8: `axum`, `tower-http`, `reqwest` (rustls, stream), `tokio`, `tokio-util`, `async-compression`/`flate2`, `quick-xml`, `url`, `fs4`, `rand`
- **Capability for `main`:**
  - `remote.urls: ["http://127.0.0.1:47831/*"]`
  - `core:default`, `core:event:default`
  - window `show`, `set-focus`, `unminimize`, `minimize`, `toggle-maximize`, `close`, `start-dragging`, `available-monitors`, `primary-monitor`, `set-fullscreen`, `set-always-on-top`
  - the app's own commands, declared through `tauri_build::AppManifest::commands` as in `spike/media/tauri/build.rs`
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
| Android TV and Electron (macOS/Linux) run the same `server.js` | Forks the code | Shared | Shared; crate can later replace libnode |
| Bundle size | Smallest | +30-45 MB | +30-45 MB until Phase 8 |
| Processes | 1 + ffmpeg | 2 + ffmpeg | 2 + ffmpeg → 1 + ffmpeg |
| Effort to first ship | ~3-5 weeks of server port | Smallest | Smallest |

## Appendix E: Risk register

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | Windows users lose playlists and settings | High / critical | Bridge export (Phase 1), import (6.2), fallback notice (6.4), VM upgrade tests |
| 2 | A Windows Electron client picks up a Tauri asset, or a macOS/Linux client picks up a Windows asset | Medium / high | Strict asset and manifest separation in the mixed release (5.6); gate tests both updaters |
| 3 | A shared renderer or `server.js` change breaks the Electron build (macOS/Linux) or Android | Medium / high | Adapter is a no-op outside Tauri (3.2); Electron smoke run in the Phase 2/3 gates; Node 18 CI (`android.yml`) |
| 4 | PiP and Mirror popups | **Retired by spike 0.2** (works with `on_new_window` → `Create`) / medium | Destroy the popup from Rust on close (4.3, 4.4), or windows are left on screen |
| 5 | Silent HEVC decode failure (sound, no picture) | Seen in spike / medium | Watchdog (0.7), already useful in Electron |
| 6 | Screen sleeps during playback | Medium / medium | `navigator.wakeLock` (works in WebView2) plus `keepawake` (4.6) |
| 7 | Orphaned server or ffmpeg processes; port 47831 still taken on relaunch | Medium / high | Parent-death detection, Job Object, cleanup before `install()` |
| 8 | Two Windows installs side by side after the upgrade | High / medium | NSIS post-install hook (6.5) |
| 9 | Website download button breaks because of the Windows asset name | High / low | `assetNamePattern` (5.7) |
| 10 | Updater signing key lost | Low / critical | Key custody documented in `RELEASING.md` |
| 11 | No Windows Controls Overlay, `setAspectRatio` or stable monitor id | Certain / low | HTML buttons, resize clamp, name+position key |
| 12 | `remote.urls` exposes IPC to the origin | Low / high | Minimal capabilities, server serves only `public/`, keep `requestAllowed` |
| 13 | Phase 9 blockers: WKWebView compatibility mode, WebKitGTK Multiview freeze | Certain / high, **deferred** | 9.2, 9.3; the Electron build keeps serving those users until then |

## Appendix F: Baseline

- **Test run:** `npm test` at `7fe2b6f` in a fresh checkout gives 56 of 57 passing. `test/downloads.test.js` fails only because `node_modules` was not installed (it calls `require.resolve('electron')`). Keep this suite green through every phase. Electron stays until Phase 10, so no tests are removed before then.
- **Out of scope** for this migration, unaffected apart from the shared release draft and the shared `server.js`/`public/`:
  - the Android TV app (`android/`, `android.yml`);
  - the website (`docs/`), apart from the asset names;
  - Supabase sync (`supabase/`).

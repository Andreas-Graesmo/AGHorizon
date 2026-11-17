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
- [x] **1.0 Before the bridge ships: create the Tauri updater key pair** (moved up from 5.1, because the bridge must embed the public key).
  - Done on 2026-11-17: the owner generated it on their own PC (`npx @tauri-apps/cli signer generate -w ~/.tauri/aghorizon.key`). The minisign key ID is `F074C66F1E88511B`.
  - The **public** key is committed as `electron/tauri-updater.key.pub`, which switches the hand-over on. `test/handover.test.js` checks the key ID. The key also goes into `plugins.updater.pubkey` in Phase 5.
  - The private key and its password stay with the owner, backed up off the PC. If they are lost, users can no longer be updated.
  - [x] **The owner added the CI secrets** `TAURI_SIGNING_PRIVATE_KEY` (the content of `aghorizon.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (2026-11-17). The release workflow (5.6) signs with them.
- [x] **1.4** Ship the bridge (with 1.0 done) on both channels, and leave it out for at least one release cycle before the first Tauri release.
  - Shipped as **v2.5.0** (stable, 2026-11-17). PR [Andreas-Graesmo/AGHorizon#24](https://github.com/Andreas-Graesmo/AGHorizon/pull/24) brought only the Electron bridge parts to `main`.
  - It reaches the Test channel too, because Test takes the newest of all published releases.
  - Its Windows assets are the Electron installer plus `latest.yml`.
  - That release has no macOS build (`.dmg` / `latest-mac.yml`). That doesn't matter for the hand-over, which is Windows only.
  - [ ] **Wait:** keep v2.5.0 (or later Electron releases from `main`, which keep the bridge) as the newest Windows release for at least one release cycle, before the first tag with the Tauri `release.yml`.
- **Checks:**
  - `npm test`: 67/67, including `test/handover.test.js`: signatures made by `tauri signer` (throwaway key in `test/fixtures/handover/`), tampering, wrong key, an edited trusted comment, release choice per channel, and the installer URL guard.
  - Signature verification also checked inside Electron 45 itself.
  - `spike/migration/check-roundtrip.js` (Chromium, real UI): Xtream credentials with special characters, a 3 MB file playlist, favourites, history, progress and settings all survive export → empty profile → import, 13/13. A second import doesn't overwrite.
  - `spike/migration/check-electron-export.js`: the real Electron app writes `migration.json` with the stored data and no sync code, on Linux and **on Windows** (`%APPDATA%\Tuner IPTV`; CI `bridge.yml` [run #2](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44115287363), where `npm test` also passes). The first Windows run showed Git turning the signed fixture's LF into CRLF; `.gitattributes` now keeps `test/fixtures/**` byte-exact.
  - **Not testable before a Tauri release exists:** the full download → verify → install path against a real release. That is covered by the Phase 6 gate (Electron 2.5 → bridge → Tauri on clean VMs).
- [ ] **Gate:** `migration.json` appears on Windows with real data (**done**, CI), the round trip restores everything (**done**), and **1.0 is done**. **Passed:** 1.4 shipped as v2.5.0.

### Phase 2: Tauri scaffold and server sidecar

- [x] **2.1** `npm i -D @tauri-apps/cli@^2`, then `npx tauri init`. This creates `src-tauri/`:
  - identifier **`app.aghorizon.desktop`** (the same as electron-builder's `appId`)
  - `"version": "../package.json"`, so there is one version source shared with Electron and Android (`android/app/build.gradle.kts:11-14`)
  - `productName "AG Horizon"`
- [x] **2.2** `npx tauri icon build/icon.png`.
- [x] **2.3 Sidecars** in `bundle.externalBin`:
  - `binaries/aghorizon-server-x86_64-pc-windows-msvc.exe` (Node SEA of `server.js`)
  - `binaries/ffmpeg-x86_64-pc-windows-msvc.exe`: CI downloads `ffmpeg-win32-x64.gz` from `ffmpeg-static` release `b6.1.1` and checks the sha256 recorded in 0.4. Not via `npm install`: `ffmpeg-static` leaves the Windows build.
  - Other targets are added in Phase 9.
- [x] **2.4 `server.js` changes.** Each must stay Node 18 compatible (Android) and keep working in-process under Electron (macOS and Linux).
  - [x] Read `PUBLIC_DIR` from env, defaulting to the current `__dirname/public` (`server.js:21`; done in 0.3).
  - [x] Make `ffmpeg-static` optional, using `FFMPEG_PATH` first. That code path already exists at `server.js:647`.
  - [x] CLI entry `sidecar/entry.js`: `READY <port>` / `ERROR <code>` on stdout (done in 0.3).
  - [x] Exit when stdin closes; this also covers a killed parent on Windows (102 ms in 0.3).
- [x] **2.5 Rust `setup()`.**
  - Spawn the server sidecar (`tauri-plugin-shell`), passing env: port 47831 (`TUNER_PORT` override), `PUBLIC_DIR` = resource dir, `FFMPEG_PATH` = resolved sidecar path, `TMPDIR`, and the API keys.
  - Wait for `READY` before creating the window.
  - On `EADDRINUSE`, show a `tauri-plugin-dialog` error and `app.exit(1)`, as `main.js:197-205` does.
  - Keep the sidecar's stdin piped and never close it while the app runs: its end is how the server notices the app has gone (0.3). A Windows Job Object is optional extra safety, and it also covers ffmpeg children if the server itself is killed.
- [x] **2.6** Bundle `public/**` as `bundle.resources`. Keep `npm run setup` (vendored hls.js and mpegts.js) as a pre-build step.
- [x] **2.7 Main window** from `WebviewWindowBuilder`:
  - `WebviewUrl::External("http://127.0.0.1:47831/")`
  - `visible:false`, 1280×800, min 760×520, background `#0c0e12`
  - `drag_drop_enabled(false)`. **This is required**, so that HTML5 `.m3u` drops (`boot.js:15-42`) and drag-reordering (`downloads.js:387-394`) keep working.
  - `additional_browser_args`: `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --enable-features=PlatformHEVCDecoderSupport --enable-blink-features=AudioVideoTracks --autoplay-policy=no-user-gesture-required`. Tauri's own defaults come first, because setting this replaces them. This exact string was tested in spike 0.1.
- [x] **2.8 Capabilities.** `src-tauri/capabilities/main.json` for window `main` with `remote.urls: ["http://127.0.0.1:47831/*"]` (Appendix B; the pattern is proven in `spike/media/tauri/`). Give `pip` and `mirror` a separate minimal capability.
- [x] **2.9** `on_navigation`: block navigation away from the origin and send http(s) URLs to `tauri-plugin-opener`, replacing `main.js:143-145`.
- [x] **2.10** Register `tauri-plugin-single-instance` **first**. Its callback calls unminimize, show and set_focus on `main` (replaces `main.js:27-30,154-156`).
- [x] **2.11 Exit handling** (`RunEvent::ExitRequested` / `Exit`): stop the sidecar gracefully, and flush downloads to the "queued" state, replacing `downloads.js:410` and `main.js:215`.
- [x] **Gate: passed** (Tauri app on Windows CI, [run #1](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44119246878), `e2e/tauri-windows.js`, 9/9). Driven through WebView2's DevTools port (`AGH_DEVTOOLS_PORT`):
  - the page comes from the app's own server, with the Tauri bridge, and the dashboard renders; the server finds the ffmpeg sidecar;
  - **a live MPEG-TS channel with AC-3 sound plays, converted by ffmpeg** through `/api/transcode` (the app's own codec check chose that);
  - with the server and ffmpeg running, **`taskkill /F` on the app (no `/T`) ends both**, through the job object;
  - the app starts again afterwards, and **closing the window quits with exit 0, leaving nothing running**.
  - Locally (Linux): a busy port gives Electron's message once, with exit 1; `kill -9` leaves no server.
  - **Electron is unaffected:** `npm test` 67/67; the Electron app still renders the dashboard with its preload's bridge, and still writes `migration.json`.

**How Phase 2 was built** (`src-tauri/`, `scripts/tauri-prep.js`, `public/js/tauri-shell.js`):
- `scripts/tauri-prep.js` fills `src-tauri/binaries/` with the server `.exe` (`sidecar/build.js`) and the pinned ffmpeg, refused unless its sha256 matches (0.4).
- The shell is 7.9 MB (Linux release build).
- **Moved ahead from Phase 3:** a minimal `public/js/tauri-shell.js`, because the renderer can't load without `window.tunerDesktop` (found in 0.7). Window functions work; updater, downloads and folder sync answer "not available yet". It does nothing in Electron, on Android TV, or in a plain browser.
- The window is shown by the page's `ready()` (`core:window:allow-show`), or after 5 s.
- `window.open` is refused for now (PiP and Mirror are 4.3/4.4), except outside http(s) links, which open in the browser (4.7 done early).

### Phase 3: Bridge adapter and IPC commands

All 34 preload members are listed in Appendix A.

- [x] **3.1** `app.withGlobalTauri: true` (done in Phase 2).
- [x] **3.2 `public/js/tauri-shell.js`**, loaded right after `tv.js`.
  - It defines `window.tunerDesktop` synchronously, with exactly the shape of `electron/preload.js`. `test/tauri-shell.test.js` reads the member list from `preload.js` itself, so the two can't drift apart.
  - It does nothing in Electron, on Android TV, or without `__TAURI__`.
- [x] **3.3 App and window.**
  - `ready` / `focusWindow` use Tauri's window API.
  - `displays()` uses `availableMonitors()`/`primaryMonitor()`, in logical pixels. The id is `name@x,y` (Windows names look like `\\.\DISPLAY1`, labelled "Display 1").
  - `appInfo` gives the version; the updater comes in Phase 5.
  - `titleBar` is a no-op (4.2).
- [x] **3.4 Sync.**
  - **The code** is in **Windows Credential Manager** (`keyring` 3.6, `windows-native`, entry "AG Horizon" / "sync-code"), and `info.keychain` is `true`. Other systems (development until Phase 9) use a file in the app's data folder, as Electron does without a keychain.
  - **The folder** is shared code, `desktop/sync-folder.js`. Electron's `sync.js` now uses it too, with the same validation (hex vault and device, tmp+rename). In the Tauri app it runs in the sidecar, and Rust adds only the folder dialog.
  - **Blobs** travel as base64.
- [x] **3.5 Downloads.** **Changed from the plan's token-guarded `/internal/downloads/*` routes** to the sidecar's own stdin/stdout. That's simpler, with no new HTTP endpoints, no token and no HTTP client in Rust.
  - **The engine** is now `desktop/downloads-core.js`, with no Electron. `electron/downloads.js` is a thin layer with the same IPC as before.
  - **In the Tauri app** the engine runs in the sidecar (`sidecar/entry.js` with `AGH_DATA_DIR` = `app_data_dir`, `AGH_DOCUMENTS_DIR`), so `/api/local` plays downloads as before.
  - **Requests:** Rust writes `{"id","cmd","args"}` lines to the sidecar and gets `RPC {…}` answers. Changes arrive as `EVENT {"name":"downloads:changed",…}` and are emitted to `main`.
  - **Only a fixed list of operations** is reachable: the `downloads` and `sync` commands in `src-tauri/src/main.rs`.
  - **Rust alone handles** the folder dialog, Explorer (`reveal_item_in_dir`, `open_path`) and the id-to-path lookup, so the page never names a path.
  - **On exit,** Rust asks the sidecar to `quit` (what was downloading resumes next time) before stopping it.
  - **Kept:** http(s)-only URLs, the under-folder check in `adopt`, and free space.
- [x] **3.6 Updater:** still stubbed (`app_info.updater = false`) until Phase 5.
- [x] **3.7 Tests.**
  - `test/tauri-shell.test.js`: shape against `preload.js`; inert in Electron, Android TV and a browser; operations and arguments; base64 round trip; displays.
  - `test/sidecar-rpc.test.js` (since grown into `test/parity/rpc.test.js`, run against both servers, 8.5): a real download over the sidecar protocol, played back through `/api/local`; folder-sync round trip; bad vault and device refused; `quit` saves.
  - `npm test`: 74/74, on Linux and Windows.
- [x] **Gate: passed.** Windows CI `e2e/tauri-windows.js` 18/18 ([run #3](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44124087557)), bridge CI `npm test` 74/74 on Windows, Android TV CI (Node 18 tests and emulator smoke) green, plus Electron.
  - **Tauri on Windows:**
    - downloads folder from `downloads.json`;
    - a 4.6 MB film downloads with progress events, plays back through `/api/local` byte for byte, lands in `Movies/E2E Film (2024)/`, and is **still listed after a kill and restart**;
    - the sync code is in Credential Manager (`cmdkey /list`) and is removed when cleared; folder sync is byte-exact;
    - monitors are listed.
    - Not automated: the folder dialogs and Explorer, which need a person. Check them in the Phase 4 manual pass.
  - **Electron (Linux):** dashboard, downloads and sync answer through its IPC after the split; `migration.json` is still written.

### Phase 4: Windows, title bar and OS integration

Most of it lives in `public/js/tauri-shell.js` and `src-tauri/src/main.rs`; `player.js` and `mirror.js` are unchanged.

- [x] **4.1 Window state.**
  - `tauri-plugin-window-state` keeps `SIZE|POSITION|MAXIMIZED`, not `VISIBLE` (the page still shows the window).
  - `pip` and `mirror` are denylisted.
  - On the first start, Electron's last bounds (`%APPDATA%\Tuner IPTV\window-state.json`) are used once.
- [x] **4.2 Title bar** (decision 0.5).
  - `decorations(false)` and `shadow(true)`.
  - The adapter adds minimise/maximise/close (46×42, theme colours, red close, `aria-label`s, keyboard-reachable) to the end of `#topbar`, and sets `html.tauri-shell`.
  - `#topbar` gets `data-tauri-drag-region="deep"`. Its buttons and inputs are excluded by Tauri itself, and `#topSearch` is `"false"`. Double-click maximises.
  - Electron keeps its native overlay; the CSS only applies under `html.tauri-shell`.
- [x] **4.3 PiP** (design from spike 0.2).
  - `on_new_window`: `about:blank` becomes the `pip` window. It is frameless, on top, 480×270 (minimum 260×146), bottom right of the current screen's work area, 24 px in, and kept at 16:9 after resizing.
  - A leftover window with that label is destroyed first.
  - The adapter wraps `window.open`. Once the page's popup is closed, it asks Rust to destroy the window (the leak from 0.2), and it drags PiP by its `.p-top` bar through the `popups` command.
- [x] **4.4 Mirror.**
  - `/mirror.html` becomes the `mirror` window: frameless. Without `?d=` it floats on top, bottom right. With `?d=<name@x,y>` it is placed on that monitor and fullscreen.
  - It is dragged anywhere except its controls, through the adapter. `window.moveTo` in `mirror.js` does nothing under Tauri, and that's harmless.
  - Closing `main` destroys `pip` and `mirror`.
- [x] **4.5 Fullscreen.**
  - Element fullscreen also makes the window fullscreen.
  - **Escape leaves fullscreen.** WebView2 in Tauri didn't do that by itself; the e2e found it.
- [x] **4.6 Keep-awake.** The adapter holds a `navigator.wakeLock` screen lock while any video plays (the main page, PiP or the mirror), and releases it otherwise. The Rust `keepawake` crate is only needed for WebKit (Phase 9).
- [x] **4.7 External links** (Phase 2).
- [x] **4.8 Multiview:** a tile whose every way to play failed tries once more after 3 s ("Trying again…") before showing the error. This is shared code, so Electron gets it too.
- [x] **Gate (automated): passed.** Windows CI `e2e/tauri-windows.js` 32/32 ([run #7](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44131114163)):
  - no frame, with the three buttons; maximise/restore and minimise **by real clicks**;
  - PiP opens frameless and on top, the player moves in and plays, and closing it leaves **no window**;
  - the floating mirror shows the picture and leaves no window; on a chosen monitor it is fullscreen;
  - the fullscreen button (a real click) makes the window fullscreen, and Escape leaves it;
  - the wake lock is held while playing and released after;
  - the window size is kept across a restart (1111×733);
  - closing the app with PiP open quits, as does the close button, and nothing is left running.
- [x] **Manual pass on a real Windows 10/11 PC** (CI can't do these). The owner did it on 2026-11-17 with v3.1.0-beta.0, and **everything passed**:
  - dragging the window by the top bar; Aero Snap to the edges and with Win+arrows; double-click to maximise;
  - resizing from every edge and corner;
  - the folder dialogs (download folder, sync folder) and "show in Explorer";
  - PiP and the mirror dragged around; the mirror on a real second monitor;
  - the screen staying on during a long film;
  - `.m3u` drag-and-drop onto the window.

### Phase 5: Updater, packaging and CI (mixed release)

Built on 2026-11-17. The self-update gate passes on a Windows runner (`.github/workflows/tauri-update.yml`). The real release path (5.6) is written, but is first used by the first Tauri tag.

- [x] **5.1 Signing.** The release key from 1.0 (`F074C66F1E88511B`) is in `plugins.updater.pubkey`, and the CI secrets are set. Key custody is documented in `RELEASING.md` §8. The tests use a throwaway key made in CI, never the release key.
- [x] **5.2** `bundle.createUpdaterArtifacts: true` and `plugins.updater.windows.installMode: "passive"`. Builds that don't need updater files (the Phase 6 installer test) turn them off with `--config`.
- [x] **5.3 Rust updater commands** (`src-tauri/src/updater.rs`). One `updater` command with operations `info`, `status`, `setChannel`, `check`, `download`, `install` and `open`. They keep Electron's status shapes and `updater:status` events, so `ui.js` is unchanged.
  - `check` builds the updater with the channel's endpoint and `on_before_exit` → `stop_server` (the server and its ffmpeg are gone before NSIS replaces files).
  - `download` reports progress; the signature is verified there, and a wrong one becomes `error`.
  - `install` runs on its own thread: stopping the server blocks, and on a runtime thread that panicked ("Cannot start a runtime from within a runtime", found by e2e). NSIS then runs passive and starts the app again.
  - **Install on quit:** if an update is downloaded when the app exits, it is installed without restarting, like Electron's `autoInstallOnAppQuit`.
  - Release notes and the Test channel's lookup are plain GitHub REST calls in the adapter (`tauri-shell.js`), as on Android TV. Version order is `tvVersionCompare` (the same rules as `electron/versions.js`).
  - `AGH_UPDATER_ENDPOINT` replaces the endpoint, for the e2e only.
- [x] **5.4 Channels** (decided in 0.6).
  - **Stable:** `releases/latest/download/latest.json`.
  - **Test:** the adapter lists `/releases?per_page=30`, skips drafts and releases without `latest.json`, takes the highest version, and passes its `latest.json` URL to Rust if it's newer than the running version. Rust accepts only `https://github.com/Andreas-Graesmo/AGHorizon/releases/download/…/latest.json` (unit test), else it uses Stable.
  - On Stable, a missing `latest.json` (a 404, e.g. while GitHub's latest release is still Electron's) counts as "up to date".
  - The updater's default comparator means it never downgrades.
- [x] **5.5 Bundle targets:** `nsis` only, `embedBootstrapper`.
- [x] **5.6 `.github/workflows/release.yml` rewritten as a mixed release** (not yet run: the first Tauri tag will be the first run).
  - **`windows` job:**
    - Rust, the sidecars and `npm test`.
    - It stops if `TAURI_SIGNING_PRIVATE_KEY` is missing.
    - It runs `tauri build --bundles nsis` with the API keys compiled in, then `scripts/tauri-release.js`, then uploads to the draft with `gh`.
    - tauri-action is not used: our own script gives the asset names and `latest.json` exactly.
  - **`desktop` job (macOS, Linux):** `electron-builder --mac` / `--linux` only, so there is no Windows Electron installer and no `latest.yml` / `beta.yml`.
  - `android-tv` is unchanged. `publish-test` now needs `windows`, `desktop` and `android-tv`.
- [x] **5.7 Asset names.** `scripts/tauri-release.js` writes `AG-Horizon-Setup-<v>.exe`, `.exe.sig` and `latest.json`. `latest.json` has both the `windows-x86_64-nsis` and `windows-x86_64` keys, with URLs under this repository's releases, which the Electron hand-over requires. The website regex and README names still match.
- [x] **5.8 `android.yml`:** no change.
- [ ] **5.9 Licensing: ffmpeg GPL source.** **Changed on 2026-11-17 (owner's decision): Option B.** The Windows app now ships BtbN's ffmpeg, whose sources are all pinned.
  - **The build:** BtbN/FFmpeg-Builds `autobuild-2026-10-31-12-59` (a month-end build, which BtbN keeps until 2028-10), `ffmpeg-n8.1.3-27-g8dca1586f4-win64-gpl-8.1.zip`.
    - Zip sha256 `401dffcf…`, `ffmpeg.exe` sha256 `c46215f8…`, `LICENSE.txt` GPL v3.
    - BtbN no longer builds 6.1. 8.1 is the older of its two maintained release branches.
    - `scripts/tauri-prep.js` refuses anything else. `ffmpeg.LICENSE` in the app names the source release.
  - **Cost:** `ffmpeg.exe` is 165 MB instead of 83 MB (it has many more libraries). Compressed that is about 47 MB instead of 22 MB, so the installer grows by roughly 25 MB, to about 75 MB.
  - **The source:**
    - `scripts/ffmpeg-source.sh` fetches the following, with `SHA256SUMS` and a README:
      - BtbN's scripts, patches and Dockerfiles at commit `5031c6f`;
      - FFmpeg `release/8.1` at `8dca1586f4`;
      - every library of the 109 build stages enabled for win64 / gpl / 8.1, through BtbN's own `download.sh`.
    - `.github/workflows/ffmpeg-source.yml` publishes it as the pre-release `ffmpeg-n8.1.3-27-g8dca1586f4-btbn-2026-10-31-source`. **Published on 2026-11-17:** 107 files, 2.2 GB, with `README.txt` and `SHA256SUMS`. GitHub's latest release is still v2.5.0.
    - Its tag isn't a version number, so no updater offers it. electron-updater's Test channel skips tags that aren't valid semver, and Stable reads only GitHub's latest release, which a pre-release never is. The Tauri app, the Android TV app and `handover.js` skip it too.
  - [x] The media spike and the three Windows e2e suites pass with 8.1 (2026-11-17). The app's ffmpeg options (`-reconnect*`, `-copyts`, `-c:a aac`, `-movflags`, …) all exist in 8.1.
  - [x] ffmpeg and its licence are named in Settings › About & updates (`ffmpegCredit()` in `ui.js`: the BtbN build with a link to the source release in the Tauri app, `ffmpeg-static` in Electron, Jellyfin's decoder on Android TV) and in the README.
  - [ ] **Versions already shipped with gyan's 6.1.1** (Electron ≤ 2.5.0 on Windows, and Tauri v3.1.0-beta.0) — "make do with what we have":
    - 33 libraries come with versions from gyan's README;
    - zlib 1.2.13, bzip2 1.0.8, GnuTLS 3.6.16 and xz 5.2.9 were read from the binary;
    - libxml2 is a 2.13 development snapshot (commit unknown);
    - gmp, libiconv and fontconfig have no version.

    Not pursued further for now. A best-effort archive can be assembled from this if ever needed.
  - The macOS/Linux Electron apps' ffmpeg (`ffmpeg-static`'s other builders) is handled in Phase 9.
- [x] **Gate, self-update (CI):** `e2e/tauri-update.js`, 14/14. Versions 9.0.0 and 9.0.1 are built with a throwaway key and served locally.
  - A manifest for the installed version → up to date.
  - An installer with one byte changed → "The signature verification failed", and nothing is installed.
  - The real 9.0.1:
    - downloads with progress and is verified;
    - the server stops and NSIS installs it;
    - the app starts again by itself from the install folder;
    - it reports 9.0.1, its localStorage is kept, and exactly one app and one server are running.
  - **Not covered by CI:** install-on-quit; the Stable/Test choice against real GitHub releases.
- [x] **Gate, first real release: v3.1.0-beta.0** (2026-11-17, tagged by the owner; this session can only push its branch).
  - The release has `AG-Horizon-Setup-3.1.0-beta.0.exe` (49.5 MB), its `.sig` (release key `F074C66F1E88511B`) and `latest.json`, plus the AppImage with `latest-linux.yml` and the APK. There is no Windows `latest.yml`.
  - The **macOS job was cancelled** (as in v2.5.0's run), so this beta has no dmg. That needs a look before the next release.
  - The owner's manual pass on Windows: data, playback, window, PiP and mirror, downloads, sync and updates all passed.
  - Still to see: the Tauri app updating itself N → N+1 from a real release (the next beta).
- [ ] ~~Gate, first real release:~~ the original wording, kept for reference: a `v3.0.0-beta.1` tag from this branch (after the bridge has been out a release cycle) produces one draft containing:
  - the Windows Tauri installer with its `.sig` and `latest.json`;
  - the Electron dmg and AppImage with their `*-mac.yml` / `*-linux.yml`;
  - the APK.

  Then:
  - a Windows v2.5.0 on the Test channel is offered it and hands over (the Phase 6 manual gate);
  - a later beta updates the Tauri app N → N+1;
  - an Electron macOS or Linux build updates itself and doesn't see the Windows assets.

### Phase 6: Data migration on first Tauri launch (Windows)

Done on 2026-11-17; the CI gate passes (`.github/workflows/tauri-migration.yml`). The code lives in `src-tauri/src/main.rs` (`from_electron`, `migration` command), `desktop/migration-import.js`, `public/js/tauri-shell.js` and `src-tauri/windows/hooks.nsh`.

- [x] **6.1 Plain files.**
  - Before the server sidecar starts, `downloads.json` and `sync.json` are copied from `%APPDATA%\Tuner IPTV` into `app_data_dir`, but only where the new app has none yet.
  - Downloaded files stay where they are; the paths in `downloads.json` are absolute.
  - Window bounds were already handled in 4.1.
- [x] **6.2 Renderer storage.**
  - If `migration.json` (format 1) exists and the marker `electron-import.json` doesn't, Rust adds an initialization script to the main window: `window.__aghMigrating = <desktop/migration-import.js>(data)`.
  - It runs before the page's own scripts. localStorage is written synchronously; IndexedDB `tuner/files` follows, and `core.js`'s `idb.open` waits for it.
  - Keys and records the new app already has are kept.
  - The adapter then calls `migration {op:'done'}`, and Rust writes the marker. The import never runs twice.
  - The same function is `electron/migration.js`'s `IMPORT_SCRIPT`, so the round-trip test (`spike/migration/check-roundtrip.js`) covers the very code the app runs.
- [x] **6.3 Sync code.**
  - The hand-over adds `syncCode` to `migration.json`. On start it goes into Credential Manager (unless one is there already) and is then removed from the file.
  - If storing it fails, it stays in the file and the next start tries again.
  - Without a code, sync is simply off, as before.
- [x] **6.4 No bridge export found.**
  - Condition: an Electron profile (`Local Storage`) exists, but there is no `migration.json` and no marker.
  - The app shows a one-time dialog: "Start the previous version once, close it, and start this one again. Or restore from sync." Marker: `electron-import-notice`.
  - Parsing LevelDB is not done.
- [x] **6.5 Windows installer handover.** A `NSIS_HOOK_PREINSTALL` hook (`src-tauri/windows/hooks.nsh`, `installMode: currentUser`) runs only when `migration.json` exists. It:
  - finds the electron-builder entry in HKCU Uninstall (DisplayName `AG Horizon <version>`; electron-builder writes no InstallLocation, so the folder comes from its UninstallString `"…\Programs\ag-horizon\Uninstall AG Horizon.exe"`);
  - runs it with `/S _?=<folder>`, then deletes the uninstaller and the empty folder;
  - **never touches `%APPDATA%\Tuner IPTV`**.

  The shortcuts the Electron uninstaller removes are created again by the Tauri installer right after. Without `migration.json`, both apps stay installed.
- [x] **CI gate (Windows runner):**
  - `e2e/tauri-migration.js`, 14/14 checks:
    - the real Electron app exports;
    - the hand-over's sync code is added;
    - on the Tauri app's first start, the playlists, favourites, theme, IndexedDB playlist file, downloads folder and sync folder come over;
    - the code is in Credential Manager and gone from the file;
    - the marker is written;
    - a restart keeps the new app's changes;
    - the notice shows once.
  - `e2e/tauri-installer.js`, 10/10 checks:
    - with real electron-builder and Tauri installers, installing without a hand-over keeps both apps;
    - installing after a hand-over removes the Electron app (its entry and its files), keeps its data, and the Tauri app is installed.
- [x] **Owner's PC (2026-11-17):** the hand-over to v3.1.0-beta.0 passed. Data, downloads, sync code and the single installed app were all as expected.
- [ ] **Gate, by hand:** run the full upgrade on clean Windows 10 and 11 machines, Electron 2.5.x → bridge 2.9.0 → Tauri 3.0.0-beta.1. Check that:
  - playlists, file playlists, favourites, history, settings, theme, downloads list, sync folder and sync code all survive;
  - exactly one app is installed.

  This needs Phase 5 (updater) and the signing key (1.0).

### Phase 7: Windows rollout

**Decision (owner, 2026-11-17): the Tauri app stays on the Test channel until every platform has moved (Phase 9).** Stable is promoted once, for all systems together, instead of Windows first. Until then:
- Stable users stay on the Electron bridge (v2.5.0) on every system.
- **Stable fixes come from `main`**: Electron for every system, built as 2.5.0 was, with the bridge kept. Then `main` is merged into `migration/tauri`, so the betas keep them.
- **Never tag a version without `-beta` (or another pre-release suffix) on `migration/tauri`.** Its `release.yml` builds the Tauri app for Windows, and Stable users would be moved before the other systems are ready.
- A stable 2.x from `main` doesn't reach Tauri beta users: it's older than 3.x, and has no `latest.json`. Windows Electron users who switch to Test are handed over to the Tauri betas and don't come back, since the Tauri app never downgrades.

- [x] **7.1** Ship Tauri for Windows on the **test channel** first. v3.1.0-beta.0 and v3.1.0-beta.1 (with the Rust server, 8.5) are out, and each passed the owner's manual check.
- [ ] **7.2** Watch for media regressions on real hardware (HEVC, AC-3, GPUs), WebView2 runtime issues and upgrade problems.
- [ ] **7.3** Promote to stable: **deferred until after Phase 9**, together with macOS and Linux (see the decision above). Then: publish the stable Tauri release; the stable bridge's hand-over finds it by itself.
- [ ] **7.4** Update `README.md` ("Windows: built with Tauri; macOS and Linux: Electron, moving later"), `RELEASING.md` (mixed release) and `docs/`.
- [ ] **Gate:** two weeks of stable on Windows with no data-loss reports.

### Phase 8: Port the server to Rust (started 2026-11-17, owner's request)

`server.js` stays the reference. The Rust port must give the same answers, checked over HTTP by the same tests (8.4). Electron on macOS/Linux keeps `server.js` until Phase 9, and Android TV until 8.7.

- [x] **8.1** The crate `server-rs/` (`aghorizon-server`): a library plus the `aghorizon-server-rs` binary. It has **no Tauri dependency**: hyper 1, tokio and reqwest (rustls).
  - Same command line and lines as `sidecar/entry.js`: `[port]`, `READY <port>` / `ERROR <code> <message>`, and it exits when stdin closes.
  - Same environment: `PUBLIC_DIR`, `FFMPEG_PATH`, `OPENSUBTITLES_API_KEY`, `TMDB_API_KEY` (or `secrets.json` next to the program).
  - Unit tests with `cargo test`.
- [x] **8.2 Unported routes answer 501** ("Not available in this build yet") rather than being forwarded to the Node sidecar. The Windows app keeps the Node sidecar until every route is ported, so there's no mixed state to manage.
- [x] **8.3 Port**, every route of `server.js` (2026-11-17):
  - [x] the request guard, static files (WHATWG URL parsing via the `url` crate, as `new URL` does, so the same dot-segment and percent rules), `/api/capabilities`, `/api/fetch`;
  - [x] `/api/stream` (M3U8 rewriting, pass-through with Range, the TS sniffer) and `/api/tracks`;
  - [x] `/api/epg`. The same piece-by-piece parsing rules and regular expressions as `server.js` (regex crate; one branch per quote style instead of back-references), not quick-xml, so edge cases match. That includes JavaScript's object key order, which decides which channel a shared name goes to.
  - [x] `/api/local` (Range, HEAD, empty files) and local subtitles. These include extracting built-in text subtitles to `.srt` once, and the sort order that depends on `Intl.getCanonicalLocales`: a 434-entry alias table generated from Node 22's ICU (`server-rs/src/canon_table.rs`).
    - Until the downloads engine is ported, the Rust server reads `<AGH_DATA_DIR>/downloads.json` for each lookup, as `localFile()` answers. It doesn't relocate moved folders yet.
  - [x] `/api/tmdb`, `/api/trending` (cache, a failed fetch tried again);
  - [x] `/api/probe`, `/api/keyframe`, `/api/transcode`, `/api/tcsubs`: `tokio::process` with `kill_on_drop` (the player hanging up ends ffmpeg), at most 4 conversions, and the first bytes deciding between the video and "Conversion failed: <ffmpeg's last line>".
  - [x] `/api/subs/*` (OpenSubtitles): one login per account, logged in again once when a token expires. The User-Agent takes the app's version from `package.json` at build time.
  - JavaScript-compatible values throughout (`util.rs`): numbers written as JSON writes them (`10`, not `10.0`), `Number()`, `toFixed()` (ties up), `String()`, `||`, and UTF-16 `slice`.
  - Both servers take `AGH_TMDB_BASE` / `AGH_OPENSUBTITLES_BASE` (test-only; the real addresses otherwise), so the suite can stand in for TMDB and OpenSubtitles.
  - [x] `/api/shared` and `/api/shared/stats` (`server-rs/src/shared.rs`):
    - the PCR stitcher;
    - the scheduler: whose turn it is by need, the burst depth measured, a visit ended when another picture waits;
    - three tries, then the picture falls back;
    - a player that hangs up leaves at once;
    - 256 MB at most queued for a reader that stopped.

    The stitcher's three cases from `shared.test.js` are Rust unit tests. Both servers take `AGH_SHARE_REVISIT` (test only).
- [ ] **8.4 Contract tests against both.** `test/parity/parity.test.js` talks HTTP to whichever server `AGH_PARITY_SERVER` names (`node`, the default and part of `npm test`, or `rust`), with a fake provider. Both servers pass all of it. CI: `.github/workflows/server-rs.yml`, Linux and Windows.
  - Covered so far:
    - the guard (Host, Origin, Sec-Fetch-Site);
    - static files (types, index, 404, dot segments, encoded slashes, NUL, bad encoding);
    - capabilities and unknown routes;
    - fetch (gzip, user agent, every error message, refused connection, unknown host);
    - the guide (ids, names, `byName` order, the time window, entities, CDATA, 400-character descriptions, gzip, all errors);
    - HLS rewriting (keys, data: URIs, absolute and parent paths, redirects, src);
    - pass-through and Range;
    - tracks (PAT/PMT, private-data AC-3, language, visually impaired, HLS segments under src, no sniffing on Range).
  - Round 2 (2026-11-17), 18 tests now. Added:
    - downloads with Range, HEAD, posters and every 404;
    - subtitles extracted, sorted, Latin-1 and cleaned;
    - `tcsubs`;
    - TMDB runtime, cast and cache;
    - trending;
    - OpenSubtitles login, search (sorted lower-case parameters), download with a token expiring, saving next to a download, quota and credential errors;
    - probe (tracks, subtitles, quick);
    - keyframe;
    - transcode: MP4, Matroska, live subtitles, the failure message, and four conversions running so a fifth gets 429, freed when the player hangs up.

    The fixtures are made with ffmpeg; without it `npm test` skips the suite. CI uses the distribution's ffmpeg on Linux and the shipped BtbN 8.1 on Windows.
    - Two differences are allowed:
      - a 416 for an empty file carries no Content-Length from `server.js`, and `Content-Length: 0` from Rust;
      - an oversized request body makes `server.js` drop the connection, where Rust answers 413.
  - Round 3 (2026-11-17), 20 tests:
    - two Multi view pictures on one fake provider connection that opens with an 8 s burst. The provider never sees two connections; each picture gets one unbroken stream of its own channel, byte for byte; the stats (joins, no rough joins, nothing missing, a believable reserve and burst) check out; and the group and connection are gone once the pictures close;
    - HLS-only channels refused with 415;
    - 404 after three tries;
    - a bad address.

    `cast.test.js`'s TMDB behaviour was already covered in round 2.
- [x] **8.5 (engine)** The downloads engine, folder sync and the stdin/stdout RPC are in Rust (2026-11-17): `server-rs/src/downloads.rs`, `sync_folder.rs`, `main.rs`.
  - Same commands, replies and `downloads:changed` events as `sidecar/entry.js`. List entries stay JSON objects, so `downloads.json` and the page's snapshot carry the same fields in the same order.
  - Node's ways kept:
    - `readdir` order (libuv sorts on Linux and macOS);
    - `path.join`, `resolve`, `dirname` and `extname`;
    - `toISOString`;
    - `mtimeMs`;
    - `JSON.stringify(…, null, 2)` for `sync.json`.
  - `/api/local` now asks the engine (in memory) instead of reading `downloads.json`.
  - `test/parity/rpc.test.js` (9 tests, both servers) covers:
    - a film with its poster played through `/api/local`, byte for byte;
    - Plex-style names (episodes, cleaning, reserved names, years, no two downloads in one file);
    - provider refusals, HLS and web pages, each with its message;
    - pause and resume from the same byte (Range), and a dropped connection resumed by itself;
    - held while watching, the option, reordering taking over, one at a time;
    - removing with and without the file and its subtitles, empty folders (a poster alone doesn't keep one), never the download folder;
    - orphans found and adopted;
    - a moved folder hidden, kept and found again;
    - folder sync (bytes, order, bad names, `sync.json`);
    - `quit` and stdin closing both save, and a restart carries on.
- [x] **8.5 (swap)** The Windows app's sidecar is the Rust binary (2026-11-17).
  - `scripts/tauri-prep.js` builds `server-rs` with cargo and puts it where the Node single executable went, under the same name, so `tauri.conf.json` and `src-tauri/src/main.rs` are unchanged. `--node-server` still builds the old one.
  - Node has left the Windows app. The server program is 4.9 MB instead of about 80 MB.
  - The installer is **53.8 MB** with BtbN's ffmpeg 8.1; with the Node server it would be about 75 MB.
  - The Windows workflows set up Rust (and cache `server-rs`) before the prep step.
- [x] **8.6 Gate (Windows): passed.**
  - [x] Both servers pass the same contract tests: 20 HTTP and 9 RPC, on Linux and Windows.
  - [x] Every Windows suite passes with the Rust sidecar: the app (live TV with AC-3 converted, downloads, sync, window, PiP, mirror, fullscreen, keep-awake), the first start after Electron with the installer, the self-update 14/14, and the media spike.
  - [x] By hand on a real PC with real providers, with v3.1.0-beta.1 (the Rust server and ffmpeg 8.1): the owner reported that everything works (2026-11-17). That covered compatibility mode, Multi view (shared mode too), downloads, subtitles, the guide and trending.
- [ ] **8.7 Android TV:** the crate built for Android (ARM64, ARMv7) with cargo-ndk and started over JNI by the Kotlin shell, instead of nodejs-mobile. Same HTTP API, so the pages, `tv.js` and the ExoPlayer side don't change. Switch on the Test channel after Windows has run the Rust server for a release cycle or two, then delete `server.js`.

### Phase 9: macOS and Linux on Tauri (started 2026-11-17)

Everything the spike found for these platforms is collected here.

**Decisions (owner, 2026-11-17):**
- macOS stays **unsigned**, as today (ad hoc signature, `signingIdentity: "-"`; people open it with right-click → Open the first time).
- Linux ships the **AppImage only**, as today.
- No test devices: macOS and Linux are verified **on CI only** (the media spike and the end-to-end checks), plus whatever testers report from the Test channel.
- The Tauri app stays on the Test channel until every platform has moved (Phase 7).

- [x] **9.1 Re-run the media spike** on both. The macOS and Linux jobs are back in `.github/workflows/media-spike.yml`; results are in `spike/media/RESULTS.md` ("Phase 9.1 re-run"). Still open: the popup spike (0.2) on WKWebView and WebKitGTK.
- [x] **9.2 Compatibility mode on WebKit (blocking on macOS).** Done: `player.js` plays the conversion through MSE on macOS WebKit (`tcAttach`, `ManagedMediaSource` where available), and CI plays both conversions on WKWebView. Still to hear on a real Mac: the sound (CI can't measure sound through MSE on WebKit).
  - WKWebView refuses `/api/transcode` as a plain `<video src>` (media error 4, fMP4 included), because the stream has no byte ranges and no length.
  - Play the conversion through MSE (fetch, then `appendBuffer` into a `SourceBuffer`, or `ManagedMediaSource` on macOS). That works on WebView2 and WebKitGTK, and on macOS since CI run 44196981013.
  - Alternatively, have ffmpeg write HLS (fMP4 segments) and play that natively.
  - The output must be fMP4 on WebKit: Matroska fails there.
- [x] **9.3 Multiview on Linux (blocking on Linux).** Done: in the Linux Tauri app, `multiview.js` plays tiles from the conversion (no MSE) when ffmpeg is there; 4 such tiles played 4/4 on CI (and 4/4 three times locally). Still to try: 4 real channels on a Linux desktop.
  - WebKitGTK can freeze its whole web process when several MSE players run at once; this reproduced on a clean CI runner.
  - Play tiles from the server's progressive output (`/api/transcode?video=copy`) instead of MSE, and verify that this avoids the freeze. If it doesn't, cap Linux at 1–2 tiles.
- [x] **9.4 Mirror.** `video.captureStream()` is missing on both WebKits, so `player.js` draws the `<video>` onto a canvas and sends `canvas.captureStream()` to the mirror window (one stream for as long as the mirror is open). The sound stays in the main window there: getting it into the stream would route the player's own sound through Web Audio, which returns silence for MSE on WKWebView. Settings says so instead of offering the choice. Checked in Chromium with `captureStream` removed (moving picture, a channel change, cleaned up on close). Still unmeasured: CPU cost, and whether the picture keeps up while the main window is hidden (the timer that draws then may be slowed down).
- [ ] **9.5 PiP.** WKWebView has `requestPictureInPicture`; WebKitGTK has no PiP API, so hide the button on Linux unless the opener popup works.
- [x] **9.6 Keep-awake.** `navigator.wakeLock` is denied on both WebKits, so `tauri-shell.js` falls back to the app's `keep_awake` command (`keepawake` crate: a power assertion on macOS; on Linux the session's screensaver inhibit and/or logind's idle inhibit, whichever the system has). Checked on Linux against a stand-in screensaver; on macOS it is compiled and checked with the macOS build (9.8).
- [ ] **9.7 Window chrome and lifecycle.**
  - macOS: `titleBarStyle: "Overlay"` with a traffic-light inset. Keep Tauri's default app menu (Edit shortcuts, Cmd+Q). Optionally `RunEvent::Reopen` and `prevent_exit()`.
  - Linux: HTML buttons as on Windows.
  - Add `tauri-plugin-clipboard-manager` if `navigator.clipboard` needs a gesture that the app's flows don't give.
- [ ] **9.8 Packaging.** Linux is done and checked on CI (`tauri-linux.yml`, run 44201233004: 206 MB AppImage, plain and MSE playback, ffmpeg, keep-awake held, nothing left running); macOS is open.
  - **Linux:** `src-tauri/tauri.linux.conf.json` (AppImage, GStreamer bundled), BtbN's linux64 ffmpeg 8.1 from the same autobuild as Windows (`scripts/tauri-prep.js`; its source joins the same source release, `scripts/ffmpeg-source.sh`). `.github/workflows/tauri-linux.yml` builds it on ubuntu-22.04 and `e2e/tauri-linux.js` checks it: the server and its ffmpeg, H.264/AAC in a plain `<video>` and through MSE inside the bundled WebKitGTK/GStreamer, and nothing left running after closing. On Ubuntu 22.04 the GStreamer plugins that link libsoup 2 are left out (only `libgstwebrtc`) (WebKitGTK 4.1 uses libsoup 3; both in one process kill the web process). About 206 MB built on 22.04 (Electron's: 157 MB): ffmpeg is 168 MB unpacked, WebKitGTK about 120 MB.
  - **Linux, licence (open):** the bundled GStreamer includes Ubuntu's `gst-libav` and the libraries it needs (libavcodec, x264/x265 and others, several under the GPL). They come from Ubuntu's packages, so their source is Ubuntu's source packages at those versions. Before the AppImage is released: list the bundled packages and versions in the release job, and publish their sources (`apt-get source`) next to the ffmpeg source, or point to them in About/README. Leaving out `gstreamer1.0-libav` would avoid this, but then H.264/AAC would need the user's own plugins.
  - **Linux, release (open):** the release job must rename Tauri's `AG Horizon_<v>_amd64.AppImage` to `AG-Horizon-<v>.AppImage` (see below), and the AppImage's updater files come with 9.9.
  - **macOS (open):** where its ffmpeg comes from (BtbN has no macOS builds). The leading option is to build it in CI from pinned sources, with the same libraries, so its source can be published like the others.
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

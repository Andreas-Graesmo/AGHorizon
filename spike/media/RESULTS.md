# Phase 0.1 media spike: results

This is the media spike from `MIGRATION_PLAN.md` Phase 0.1. It tests what each Tauri v2 webview can play when the page is served by AG Horizon's real `server.js` on the app's origin (`http://127.0.0.1:47831`). Playback goes through the same paths the app uses.

- **Runs:**
  - CI [run #2](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44078652026) (commit `0a60d3b`).
  - CI [run #5](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44083465027) (`c34f854`, which adds the MSE variant and the timeouts). In #5, Windows finished, Linux froze, and macOS never got a runner.
  - Repeated local runs on Ubuntu 24.04 WebKitGTK.
- **Harness:**
  - `serve.js`: the app server plus fixtures and a results endpoint.
  - `page/spike.js`: the tests.
  - `tauri/`: a minimal Tauri 2 app with a `remote.urls` capability.
  - `gen-fixtures.js`: 12 s test clips.
  - `.github/workflows/media-spike.yml`: the CI job.

## Phase 9.1 re-run (2026-11-17)

CI [run 44196981013](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44196981013) (`aeb6008`): macOS (WKWebView, arm64) and Linux (WebKitGTK, Ubuntu 22.04), plus a Linux job running only the Multiview conversion test. All jobs finished. The results confirm the two Phase 9 fixes:

- **macOS, compatibility mode through MSE works (finding 1, plan 9.2).** Both conversions appended to a `SourceBuffer` play: "copy via MSE" (TS H.264 + AC-3 → fMP4) and "h264 via MSE" (HEVC → fMP4), at 640×360. The same conversions as a plain `<video src>` still fail with media error 4, as do 4 progressive conversion tiles (0/4). That is the path `player.js` now takes on macOS (`tcAttach`). Sound through MSE is unmeasured on macOS, as for hls.js and mpegts.js (see below).
- **Linux, Multiview tiles from the progressive conversion play (finding 8, plan 9.3).** 4 compatibility-mode pictures at once played 4/4 in the full Linux run and 4/4 in the dedicated job. 2 and 4 mpegts.js pictures and 4 hls.js pictures also passed in this run. `multiview.js` now plays Linux tiles from the conversion when ffmpeg is there.
- **Unchanged:** `video.captureStream()` is missing on both, `canvas.captureStream()` works on both (9.4), and `navigator.wakeLock` is denied on both (9.6).
- **The shipped AppImage:** `e2e/tauri-linux.js` (`.github/workflows/tauri-linux.yml`) checks that H.264/AAC plays inside the AppImage through the GStreamer it bundles, both as a plain `<video>` and through MSE.

## How far to trust these numbers

- **CI machines are not users' machines.** They are VMs with no GPU, no HEVC extension or Dolby decoder on Windows, Xvfb and software GL on Linux, and a virtualised Mac. Hardware decoding (HEVC on Windows) cannot show up here. Treat "plays on CI" as *the path works*, and "fails on CI" as *check on real hardware* unless the cause is structural (for example, an API is missing).
- **Sound on WebKit is only proven when it is heard.** WebKit has no decoded-byte counter, so the spike listens through Web Audio. On WKWebView, and inconsistently on WebKitGTK, that tap returns silence for media that is very likely playing sound. So on WebKit, **"heard" is proof, but "not heard" is unverified.** Chromium/WebView2 sound results are exact, because they use `webkitAudioDecodedByteCount`.
- **The fixture is short.** The "live" fixtures are a 12 s clip sent at its real bitrate. That reproduces mpegts.js live behaviour, but not hours of playback or real provider quirks.

## Results by webview

✅ plays (with sound proven, or Chromium's exact counter) · 🟡 picture plays, sound not proven (see above; the local column's early runs checked the picture only) · ❌ fails · ➖ not available

| | WebView2 (Win, planned flags) | WebView2 (no flags) | WKWebView (macOS runner, arm64) | WebKitGTK (Ubuntu 22.04 CI) | WebKitGTK (Ubuntu 24.04 local) |
|---|---|---|---|---|---|
| Autoplay with sound, no gesture | ✅ | ✅ | ✅ | ✅ | ✅ |
| MP4 H.264/AAC | ✅ | ✅ | ✅ | ✅ | ✅ |
| MKV H.264/AAC | ✅ | ✅ | ❌ | 🟡 | 🟡 |
| MP4 HEVC | ❌ (VM: no HEVC ext.) | ❌ | ✅ | 🟡 | 🟡 |
| MP4 with AC-3 | 🟡 no sound (as in Electron) | 🟡 no sound | ✅ heard | 🟡 | 🟡 |
| `video.audioTracks` (2 tracks) | ✅ 2 | ❌ API missing | ✅ 2 | ✅ 2 | ✅ 2 |
| Native HLS | ✅ | ✅ | 🟡 | ➖ | ➖ |
| hls.js via `/api/stream` | ✅ | ✅ | 🟡 | 🟡 | 🟡 |
| mpegts.js TS H.264/AAC | ✅ | ✅ | 🟡 | ✅ heard | ✅ heard |
| mpegts.js TS HEVC | ❌ (VM) | ❌ | 🟡 | ✅ heard | 🟡 |
| mpegts.js TS AC-3 / E-AC-3 | 🟡 no sound (→ app converts) | 🟡 | 🟡 | ✅ heard | ✅ heard |
| Multiview 4 × mpegts.js | ✅ | ✅ | ✅ | ✅ run #2 / **froze** run #5 | ⚠️ flaky, see below |
| Multiview 4 × hls.js / 4 × MP4 | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ⚠️ / ✅ |
| **Compatibility mode** `/api/transcode` (fMP4, `<video src>`) | ✅ | ✅ | **❌ media error 4, every mode** | 🟡 | ✅ heard |
| `/api/transcode?video=hevc` (Matroska) | ❌ silent fail, no error event | ❌ | ❌ error event fires | 🟡 plays | ✅ |
| App's HEVC choice (`hevcOk` → hevc, else h264) | `hevcOk=false` → h264 ✅ | same ✅ | `hevcOk=true` → error → h264 → ❌ | `hevcOk=true` → hevc 🟡 | ✅ |
| `video.captureStream()` (Mirror) | ✅ | ✅ | ➖ | ➖ | ➖ |
| `canvas.captureStream()` (Mirror fallback) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `requestPictureInPicture` | ✅ (needs gesture) | ✅ | ✅ (needs gesture) | ➖ | ➖ |
| `navigator.wakeLock` | ✅ granted | ✅ | ❌ denied | ❌ denied | ❌ denied |
| `invoke` from `http://127.0.0.1:47831` (`remote.urls`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `/api/*` same-origin guard passes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Compatibility mode **through MSE** (fetch → `SourceBuffer`) | ✅ | ✅ | **pending (no macOS runner)** | (froze earlier) | ✅ heard |

## Findings and what they change in the plan

1. **Compatibility mode is broken on macOS as built.** WKWebView rejects every `/api/transcode` response (media error 4), including plain fragmented-MP4 H.264/AAC. The same bytes play everywhere else. The likely cause is that WebKit's progressive player wants a byte-range-capable resource, while the server sends `Accept-Ranges: none` with no length.
   - The candidate fix is to fetch the same fMP4 and append it to a `SourceBuffer` (MSE). It plays with sound on WebView2 (run #5) and on WebKitGTK (locally).
   - **It has not yet run on macOS**, the one place it matters, because run #5's macOS job never got a runner.
   - **Plan change (task 2.12):** add "compatibility mode via MSE on WebKit". The other option is HLS output from ffmpeg for WebKit.
   - The audit's earlier guess ("Matroska fails on WebKit") was right but only half the story: on macOS, fMP4 fails too.
2. **The HEVC fallback in `player.js` can fail silently.** On Chromium/WebView2, an undecodable HEVC stream (native or Matroska) plays sound with **no picture and no `error` event**, so the `video.onerror` switch to H.264 never fires.
   - Today this only matters where `hevcOk` (MSE `hvc1`) is true but the element can't decode. That was not seen on CI.
   - **Plan change:** add a watchdog to the app (no `videoWidth` after N s → treat it as an error). It is cheap, and it guards Electron too.
3. **WebView2 needs `--enable-blink-features=AudioVideoTracks`.** Without it, `video.audioTracks` is missing and switching sound tracks in a film breaks. Keep the flag in `additional_browser_args` (plan 2.7).
   - Autoplay works in Tauri's WebView2 even without `--autoplay-policy`, but keeping that flag costs nothing.
4. **Mirror picture.** `video.captureStream()` is missing on both WebKits, as expected. `canvas.captureStream()` works everywhere, so the plan's WebKit fallback (draw the `<video>` to a canvas and capture it) is viable. Its A/V sync and CPU cost are still unmeasured.
5. **PiP.** `requestPictureInPicture` exists on WebView2 and WKWebView, but **not on WebKitGTK**. Hide PiP on Linux unless the opener-popup spike (0.2) works.
6. **Keep-awake must be native.** `navigator.wakeLock` is denied on both WebKits, and granted on WebView2. This confirms plan 4.6: use the `keepawake` crate.
7. **WebKitGTK is the most capable at decoding.** It showed the picture for every fixture, HEVC included, both natively and through MSE. Sound was *heard* for AC-3, E-AC-3 and HEVC streams through mpegts.js. This needs the GStreamer plugins (`gst-libav`, `-bad`). On Linux the app can rely on compatibility mode less, but **only if those plugins are present**. That makes `bundleMediaFramework: true` for the AppImage important (plan 0.1 and 5.5).
8. **Linux Multiview can freeze the whole page. This is confirmed, and it is the main Linux risk.** With several MSE pictures at once, WebKitGTK sometimes stops the web process entirely, so even page timers stop and the guard can't report.
   - **Where it froze:**
     - On a clean CI runner, at the first Multiview test (2 × mpegts.js) in run #5. Run #2 passed 4/4.
     - Locally (Ubuntu 24.04, Xvfb, software GL), in the first full run, and in 4 of 6 looped runs.
   - **Without a full freeze,** a single picture sometimes fails: mpegts.js "Failed to push buffer", or hls.js stuck at `readyState 1`.
   - **Progressive MP4 (no MSE) has never failed:** 4/4 in every run.
   - **Candidate mitigation, untested:** on Linux, have Multiview tiles play the server's progressive output (`/api/transcode?video=copy`, which WebKitGTK plays) instead of MSE, or cap Linux Multiview at 1–2 MSE tiles. Also add a per-tile retry.
   - This is still CI and container hardware. Retest on a real Linux desktop with a GPU.
9. **The `remote.urls` IPC design works.** `window.__TAURI__` is injected into the page served by the app's own server, and `invoke` of an app command granted by a capability succeeds. That makes plan option A (keep the origin `http://127.0.0.1:47831`) confirmed on all three webviews (Windows in run #5). The server's same-origin guard accepts the webview on every platform tested.

## Still to check by hand (cannot be automated here)

- Sound on WKWebView for hls.js, mpegts.js and native HLS (expected to work; the harness can't hear MSE on Mac).
- HEVC and AC-3 on a real Windows PC with the HEVC Video Extensions and a GPU.
- Element fullscreen and PiP with a real click (all webviews refuse them without a gesture, which is correct).
- Multiview with 4 or more real channels on a real Linux desktop (see finding 8; CI now passes with the conversion tiles).
- Sound of compatibility mode through MSE on a real Mac (the picture plays on CI; finding 1).

## Re-running

```bash
node spike/media/gen-fixtures.js
```

```bash
node spike/media/serve.js --label my-machine
```

Then run the spike app:

```bash
cd spike/media/tauri && cargo run --release
```

The table prints in the server log, and the raw JSON is written to `spike/media/results/`. Use `SPIKE_URL='http://127.0.0.1:47831/spike/?exit=1&only=multiview'` to run a subset. Push changes under `spike/media/` to `migration/tauri` to run the Windows jobs on CI. The workflow runs macOS and Linux again since Phase 9.1.

## Phase 0.2: popups

**Question:** do picture-in-picture and the Mirror window work as built? Both depend on `window.open` giving a scriptable window linked to the opener.

**Setup:** `page/popup.js` runs what `player.js` and `mirror.js` do, once per answer the Tauri app gives `window.open` (`on_new_window` in `tauri/src/main.rs`). CI: [run #10](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44106426697), job `windows-webview2-popups`, WebView2 on Windows Server.

| Check | No handler / `Deny` (Tauri default) | `Allow` (WebView2's own popup) | **`Create`** (Tauri window), run twice |
|---|---|---|---|
| `window.open('about:blank')` | ❌ `null` → "Picture-in-picture is not available" | ✅ | ✅ ✅ |
| App writes into `w.document` at once, document kept | – | ✅ | ✅ ✅ |
| `movePlayer`: playing `<video>` moved in keeps playing | – | ✅ 3.5 s | ✅ 3.5 s ✅ 3.5 s |
| Frameless, always on top, 480×270 | – | ➖ not controllable | ✅ ✅ |
| `pagehide` on close (app moves the player back) | – | ✅ | ✅ ✅ |
| Tauri window gone after `window.close()` | – | – | ❌ **stays visible** ❌ |
| … after Rust `destroy()` by label | – | – | ✅ ✅ |
| Mirror: `window.opener.tunerMirrorReady`, opener document read | ❌ `null` | ✅ | ✅ ✅ |
| Mirror: `captureStream()` picture shows | – | ✅ 640px | ✅ ✅ |
| Mirror fullscreen from Rust (mirror to a monitor) | – | ➖ | ✅ ✅ |
| `window.moveTo` from the page (Mirror drag) | – | ✅ moves | ❌ no effect → `startDragging()` |

**Verdict: go.** Use `Create`, with fixed labels `pip` and `mirror`, and destroy the window from Rust when the page closes it. `MIGRATION_PLAN.md` 4.3 and 4.4 have the details.

On WebKitGTK (local, Phase 9 notes): `Create` passes the same mechanics, except that there is no `captureStream`, and always-on-top can't be judged under Xvfb. The same close leak shows up there. WebKitGTK also blocks script-opened windows without a click, so the spike enables that setting on Linux; the app opens them on a click anyway.

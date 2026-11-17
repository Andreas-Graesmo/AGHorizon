# Phase 0.1 media spike: results

This is the media spike from `MIGRATION_PLAN.md` Phase 0.1. It tests what each Tauri v2 webview can play when the page is served by AG Horizon's real `server.js` on the app's origin (`http://127.0.0.1:47831`). Playback goes through the same paths the app uses.

- **Runs:** CI [run #2](https://github.com/Andreas-Graesmo/AGHorizon/actions/runs/44078652026) (commit `0a60d3b`) and run #3 (`1574ad2`, MSE and timeout additions), plus repeated local runs on Ubuntu 24.04 WebKitGTK.
- **Harness:**
  - `serve.js`: the app server plus fixtures and a results endpoint.
  - `page/spike.js`: the tests.
  - `tauri/`: a minimal Tauri 2 app with a `remote.urls` capability.
  - `gen-fixtures.js`: 12 s test clips.
  - `.github/workflows/media-spike.yml`: the CI job.

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
| Multiview 4 × mpegts.js | ✅ | ✅ | ✅ | ✅ | ⚠️ flaky, see below |
| Multiview 4 × hls.js / 4 × MP4 | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ | ⚠️ / ✅ |
| **Compatibility mode** `/api/transcode` (fMP4, `<video src>`) | ✅ | ✅ | **❌ media error 4, every mode** | 🟡 | ✅ heard |
| `/api/transcode?video=hevc` (Matroska) | ❌ silent fail, no error event | ❌ | ❌ error event fires | 🟡 plays | ✅ |
| App's HEVC choice (`hevcOk` → hevc, else h264) | `hevcOk=false` → h264 ✅ | same ✅ | `hevcOk=true` → error → h264 → ❌ | `hevcOk=true` → hevc 🟡 | ✅ |
| `video.captureStream()` (Mirror) | ✅ | ✅ | ➖ | ➖ | ➖ |
| `canvas.captureStream()` (Mirror fallback) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `requestPictureInPicture` | ✅ (needs gesture) | ✅ | ✅ (needs gesture) | ➖ | ➖ |
| `navigator.wakeLock` | ✅ granted | ✅ | ❌ denied | ❌ denied | ❌ denied |
| `invoke` from `http://127.0.0.1:47831` (`remote.urls`) | (run #3) | (run #3) | ✅ | ✅ | ✅ |
| `/api/*` same-origin guard passes | (run #3) | (run #3) | ✅ | ✅ | ✅ |

## Findings and what they change in the plan

1. **Compatibility mode is broken on macOS as built.** WKWebView rejects every `/api/transcode` response (media error 4), including plain fragmented-MP4 H.264/AAC. The same bytes play everywhere else. The likely cause is that WebKit's progressive player wants a byte-range-capable resource, while the server sends `Accept-Ranges: none` with no length.
   - Run #3 checks the candidate fix: fetch the same fMP4 and append it to a `SourceBuffer` (MSE). It works on WebKitGTK locally.
   - **Plan change:** add "compatibility mode via MSE on WebKit" to Phase 2/4. The other option is HLS output from ffmpeg for WebKit.
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
8. **Linux Multiview is flaky locally, but not on CI.** On Ubuntu 24.04 under Xvfb with software GL, 4 simultaneous MSE pictures sometimes left one picture dead: mpegts.js "Failed to push buffer" (1 of 4 runs), hls.js stuck at `readyState 1` (2 of 4 runs). Progressive MP4 was always 4/4.
   - Earlier runs also wedged the whole web process, but every one of those happened with stale WebKit processes and an old server still running. In 12 clean runs it did not recur, so it is **unconfirmed**.
   - Ubuntu 22.04 on CI played 4/4 on every path.
   - Next step: repeat on a real Linux desktop with a GPU before treating it as a blocker. Consider a per-tile retry in `multiview.js`, which helps on every platform anyway.
9. **The `remote.urls` IPC design works.** `window.__TAURI__` is injected into the page served by the app's own server, and `invoke` of an app command granted by a capability succeeds. That makes plan option A (keep the origin `http://127.0.0.1:47831`) confirmed on macOS and Linux; Windows is in run #3. The server's same-origin guard accepts the webview on every platform tested.

## Still to check by hand (cannot be automated here)

- Sound on WKWebView for hls.js, mpegts.js and native HLS (expected to work; the harness can't hear MSE on Mac).
- HEVC and AC-3 on a real Windows PC with the HEVC Video Extensions and a GPU.
- Element fullscreen and PiP with a real click (all webviews refuse them without a gesture, which is correct).
- Multiview with 4 or more real channels on a real Linux desktop.

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

The table prints in the server log, and the raw JSON is written to `spike/media/results/`. Use `SPIKE_URL='http://127.0.0.1:47831/spike/?exit=1&only=multiview'` to run a subset. Push changes under `spike/media/` to run all webviews on CI.

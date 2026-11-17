# Phase 0 decisions: ffmpeg, title bar and beta updates

These are recommendations for `MIGRATION_PLAN.md` tasks 0.4, 0.5 and 0.6. They are written for the Windows-first scope, and each one ends with the question that needs your answer. Nothing here is built yet.

---

## 0.4 Which ffmpeg to ship

### What the app ships today

`ffmpeg-static@5.3.0` downloads, at install time, the **gyan.dev "essentials" build of FFmpeg 6.1.1** for Windows. It is mirrored on `github.com/eugeneware/ffmpeg-static`, release `b6.1.1`.

- **Licence:** GPL v3.
- **Contents:** libx264 and TLS (gnutls) are included. The app needs both: `-c:v libx264` for compatibility mode, and https for provider streams.
- **Size:** 79 MB on disk, 28 MB compressed.
- **Already proven:** the spikes used exactly this file on Windows CI, including probe and transcode.

### Options

| | A: keep the same build, as a Tauri sidecar | B: newer full GPL build (BtbN or gyan, FFmpeg 7.x) | C: our own minimal GPL build | D: LGPL build with Windows' own H.264 encoder (`h264_mf`) |
|---|---|---|---|---|
| Behaviour change | **None**: the same binary users run today | New version; would need re-testing against real providers | New build; would need re-testing | Different encoder; quality and speed vary per PC, and it is missing on Windows "N" editions |
| Size (compressed) | 28 MB | ~30–45 MB | ~8–15 MB | ~10–20 MB |
| Effort | Small: download plus checksum in CI | Small | Large: a cross-compile pipeline to maintain | Medium, plus testing on many PCs |
| Licence work | GPL v3 notice and source (below) | Same | Same | LGPL is lighter, but compatibility mode loses `libx264` |

### Recommendation: A, now. Revisit B or C only if size or an FFmpeg bug makes it worth it.

The migration already changes the webview, the shell and the installer. Keeping the exact ffmpeg removes one variable from the media path, and the spike has already proven it.

**How (feeds task 2.3):**
- CI downloads `ffmpeg-win32-x64.gz` from the pinned `b6.1.1` release and checks a **SHA-256 committed in the repo**.
- It unpacks the file to `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`, passed to the server as `FFMPEG_PATH`.
- It no longer comes from `npm install`: the `ffmpeg-static` package and its install-time download leave the Windows build.

### The GPL part (worth doing for the Electron build too)

Shipping a GPL program next to the MIT app is fine: it runs as a separate program. But each release must:
1. include the licence text. The `.LICENSE` file from the same release goes next to the binary, and the About page or README says ffmpeg is GPL v3;
2. make the **corresponding source** available. The build's README only links an FFmpeg commit; the libraries in it, x264 included, have their own sources. The safest practice is to **attach the source archive for that exact build to our own GitHub releases**, or to one pinned `ffmpeg-6.1.1-source` release that every app release links to, rather than relying on a third party's site staying up.

Today's Electron installer already contains the ffmpeg `.LICENSE` file (it comes with `node_modules/ffmpeg-static`), but **no source offer**. That gap exists now, independent of the migration. This isn't legal advice; if compliance matters commercially, have it checked.

**Decision needed:** approve A (keep gyan.dev 6.1.1, pinned and checksummed), and say whether to add the source archive to releases now or with the first Tauri release.

---

## 0.5 Title bar

### What the app does today

Electron draws the native Windows caption buttons (minimise, maximise, close) **over** the app's own 42 px top bar (`titleBarOverlay`). It repaints them in the theme's colours whenever the theme changes (`app:titlebar`, `ui.js:101`). The top bar is a drag region. The buttons give Windows 11's snap-layout menu on hover, because they're native.

Tauri has no equivalent of the overlay.

### Options

| | A: frameless window + HTML buttons | B: A + `tauri-plugin-decorum` | C: native title bar |
|---|---|---|---|
| Looks like today | **Yes**: same single 42 px bar, buttons follow the theme | Yes | **No**: an extra Windows title bar above the app's own top bar, in Windows' colours, not the theme's |
| Drag, double-click to maximise, Aero Snap by dragging | Yes (`data-tauri-drag-region` does both; checked in Tauri 2.12 `drag.js`) | Yes | Yes |
| Windows 11 snap-layout menu on hovering maximise | **No** | Yes | Yes |
| Resize borders, shadow, rounded corners | `shadow(true)`: shadow, plus rounded corners on Windows 11 | Yes | Yes |
| Risk | Our own code: ~40 lines of CSS/JS | Community plugin; a dependency to keep up with Tauri | None |

### Recommendation: A. Add B later only if people miss the snap-layout menu.

It keeps the app looking exactly as it does now, it's fully under our control, and it costs little. Win+Z and Win+arrow keys still snap the window, and so does dragging to the screen edges. Only the hover menu is lost.

**How (feeds task 4.2):**
- `decorations(false)` and `shadow(true)` on `main`.
- Three buttons at the right of `#topbar`, 46×42 px each, the Windows caption-button size. They are rendered **only under Tauri**: the adapter sets a class on `<html>`, so Electron on macOS/Linux keeps its native overlay.
- Hover colours come from the theme, and close turns red on hover as Windows does.
- They call `minimize()`, `toggleMaximize()` and `close()` on the current window. The maximise icon swaps to "restore" when maximised (on `onResized`).
- `aria-label`s on the buttons, and they're reachable by keyboard.
- `#topbar` gets `data-tauri-drag-region` next to the existing `-webkit-app-region: drag`, so both shells drag. The `env(titlebar-area-*)` padding is replaced under Tauri by the width of the three buttons.
- The `app:titlebar` call becomes a no-op in the adapter.
- To check in the Phase 4 gate: resizing from every edge and corner, Aero Snap, maximise on a second monitor, and that the window can't be dragged by its buttons.

**Decision needed:** approve A (HTML buttons, no snap-layout menu for now), or ask for B from the start.

---

## 0.6 Beta update channel

### What the app does today

Settings has a **Stable** and a **Test** channel (`tuner.updChannel`).
- **Stable** gets published normal releases.
- **Test** gets the newest of all published releases, betas *and* stable, so a tester is never left behind (`RELEASING.md:72`).
- The app never downgrades, even when switching from Test back to Stable (`updater.js:23-30`).
- electron-updater reads `latest.yml` (stable) or `beta.yml` (test) from GitHub.
- Releases are built as **drafts**. Betas are published automatically by the `publish-test` job; stable releases are published by hand.

Tauri's updater has no channels. It reads one JSON file (`latest.json`, made per release by tauri-action) from a URL the app chooses at runtime.

### Options

| | A: rolling "updater-beta" release | B: JSON on GitHub Pages | C: the app picks the release (GitHub API) |
|---|---|---|---|
| How Test finds an update | Fixed URL; CI rewrites `beta.json` in a hidden release whenever a release is **published** | Fixed URL; CI commits `updates/beta.json` to the site when a release is published | The app lists `/releases`, takes the newest published one by semver (pre or stable), and uses that release's own `latest.json` |
| How Stable finds an update | `releases/latest/download/latest.json` (all three options) | Same | Same |
| Moving parts | A workflow on `release: published`; an extra pre-release always visible on the releases page | A workflow that pushes to the website branch; Pages deploy delay | None in CI; ~30 lines in Rust (or the adapter's JS) |
| Drafts | Must not be picked up: the workflow runs only on publish | Same | Not visible to the API without a token, so never picked up |
| Failure mode | Workflow didn't run, so testers miss an update | Same | GitHub API limit (60 requests/hour per IP) or offline: falls back to the Stable URL |
| Matches today's code | No | No | **Yes**: `manualCheck` (`updater.js:46-70`) and the Android TV shim (`tv.js:43-90`) already work this way |

### Recommendation: C

- No CI plumbing and nothing extra on the releases page.
- Drafts can't leak by construction.
- Same semantics as today: "newest of all published", never downgrade.
- It reuses logic the app already has and tests (`versions.js` and `test/versions.test.js`; the Rust `semver` crate orders versions the same way).

**How (feeds tasks 5.3 and 5.4):**
- **Stable:** endpoint `https://github.com/Andreas-Graesmo/AGHorizon/releases/latest/download/latest.json`.
- **Test:**
  1. `GET https://api.github.com/repos/Andreas-Graesmo/AGHorizon/releases?per_page=30` (with `User-Agent`).
  2. Skip drafts and releases without a `latest.json` asset; take the highest version.
  3. If it is newer than the running version, call `updater_builder().endpoints([that asset's URL])`.
  4. On any error, use the Stable endpoint.
- **Never downgrade:** keep the updater's default comparator (strictly newer only). Switching from Test 2.6.0-beta.2 back to Stable then waits for 2.6.0, as today.
- **During the mixed period:** only the Windows build reads `latest.json`. The Electron macOS/Linux builds keep reading `latest-mac.yml` / `beta-linux.yml` etc. (plan 5.6).

**Decision needed:** approve C (the app chooses the Test release through the GitHub API, with a Stable fallback).

---

## In short

| Task | Recommendation | Needs from you |
|---|---|---|
| 0.4 ffmpeg | Keep today's gyan.dev 6.1.1 GPL build, pinned and checksummed, as the Tauri sidecar | Approve; and when to add the GPL source archive to releases (now, or with Tauri) |
| 0.5 Title bar | Frameless window with HTML caption buttons in the existing top bar; no snap-layout hover menu for now | Approve, or ask for the decorum plugin from the start |
| 0.6 Beta channel | The app finds the newest published release through the GitHub API (as `manualCheck` does today), falling back to Stable | Approve |

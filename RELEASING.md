# Releasing AG Horizon and updating it from inside the app

How it works: you push a version tag to GitHub → a GitHub Action builds the installers for Windows, macOS and Linux, and the Android TV app, and attaches them to a GitHub *Release* → installed copies of the app find the new release (**Settings → About & updates → Check for updates**, and automatically on start) and update themselves.

Everything below is done once, except "Releasing a new version" at the end.

## 1. One-time setup

You need a free GitHub account, [Git](https://git-scm.com/downloads) and [Node.js 18+](https://nodejs.org).

1. **Create the repository.** On github.com click **+ → New repository**. Name it `ag-horizon`, set it to **Public**, and leave "Add a README" etc. **unticked**. (It must be public: installed apps download updates without logging in.)
2. **Tell the app which repository it belongs to.** Open `package.json` and replace `YOUR-GITHUB-USERNAME` with your GitHub username in **two** places: `repository.url` and `build.publish[0].owner`. If you named the repository something else, change `repo` as well.
3. **Allow the build to publish.** In the repository: **Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**
4. **Upload the code.** In a terminal, in the app folder:
   ```
   git init
   git add .
   git commit -m "AG Horizon 1.5.0"
   git branch -M main
   git remote add origin https://github.com/YOUR-GITHUB-USERNAME/ag-horizon.git
   git push -u origin main
   ```
   Git will ask you to sign in to GitHub the first time (a browser window opens). `node_modules/` and `dist/` are already excluded by `.gitignore`.

## 2. The first release

The version in `package.json` (1.5.0) must match the tag you push:

```
git tag v1.5.0
git push origin v1.5.0
```

Open the **Actions** tab on GitHub and watch the *Release* workflow (about 5–15 minutes; the three systems build in parallel). When it is green, go to **Releases**: there is a **draft** release `v1.5.0` containing the installers. Open it, write a short description of what's new, and press **Publish release**.

> Drafts are invisible to the app. Updates only reach people once you press **Publish**.

Install this first version by hand from the release page (`.exe` for Windows, `.dmg` for macOS, `.AppImage` for Linux). From then on the app can update itself.

## 3. Releasing a new version

1. Make your changes, then commit and push them as usual:
   ```
   git add .
   git commit -m "What changed"
   git push
   ```
2. Bump the version, tag it and push the tag in one go:
   ```
   npm run release:patch     # 1.5.0 → 1.5.1  (fixes)
   npm run release:minor     # 1.5.0 → 1.6.0  (new features)
   npm run release:major     # 1.5.0 → 2.0.0  (a big step, e.g. a redesign)
   ```
   (This runs `npm version`, which edits `package.json`, commits, tags `vX.Y.Z`, and then pushes both. Your working folder must have no uncommitted changes.)
3. Wait for the Action to finish, open **Releases**, edit the new draft's notes and **Publish release**.

**Without a computer (or where tags can't be pushed):** once `package.json` has the new version on the branch (for example committed from the GitHub website, or by Claude), open **Actions → Tag a release → Run workflow**, enter the version (`2.6.0`, or `3.2.0-beta.1`) and the branch (`main`; test versions may also come from `migration/tauri`). It tags the branch's newest commit and starts the release build. It refuses a version `package.json` doesn't have, a tag that exists, and a stable version from any branch but `main`.

## 4. Test versions (the Test update channel)

There are two update channels, chosen in the app under **Settings → About & updates → Update channel**:

- **Stable** (the default) gets only releases you published with **Publish release**.
- **Test** also gets *test versions*, for example `2.5.0-beta.1`. Use it on your own computer, or give it to a few people who want to try things first.

To put out a test version, commit and push your changes as usual, then:
```
npm run release:test-minor   # 2.4.0 → 2.5.0-beta.0   (start testing the next feature version)
npm run release:test         # 2.5.0-beta.0 → 2.5.0-beta.1   (the next test build of it)
npm run release:test-major   # 2.4.0 → 3.0.0-beta.0
```
The Action builds it the same way, and when all three systems are done it **publishes it as a GitHub pre-release by itself**, so you don't have to publish it. (Writing notes on the release is still nice: "What's new?" shows them.) Apps on the Test channel see it; apps on Stable don't.

When the test version is good, release it to everyone with `npm run release:minor` (2.5.0-beta.1 → 2.5.0; use `release:patch` for a 2.4.1-beta.x) and publish the draft as usual. Apps on Test get that too, since 2.5.0 is newer than 2.5.0-beta.1.

- Test versions must use `beta` after the dash (the scripts do this). The updater ignores other names.
- Switching from Test back to Stable never downgrades: someone on 2.5.0-beta.1 stays there until a stable version newer than it is released.
- A pre-release never becomes GitHub's "latest release", so the download link in the README still goes to the latest stable version.
- If a build fails, the test version stays a draft, but it is still marked as a pre-release. Fix it and push a new test version, or publish the draft by hand: it stays a pre-release, so only the Test channel sees it.
- **Never publish a test version as a normal release** (the *Set as a pre-release* box must stay ticked). GitHub then makes it the "latest release", and every installed app, on either channel, is offered it. If it happens: edit the release, tick *Set as a pre-release*, and update it.

## 5. What users see

- On start (if "Check for updates when the app starts" is on) and whenever they press **Check for updates**, the app asks GitHub for the newest published release.
- If one is newer it shows "Version X is available" → **Download update** (progress bar) → **Restart and install**. A downloaded update also installs by itself the next time the app is closed.
- Their playlists, favorites and history are kept; they live in the user data folder, not in the installation.

## 6. Things to know

- **Windows** – works out of the box. Because the installer isn't code-signed, Windows SmartScreen shows "Windows protected your PC" on the *first* install: **More info → Run anyway**. Updates installed from inside the app don't show this again.
- **Linux** – the `.AppImage` updates itself. Make it executable once (`chmod +x`).
- **macOS** – one universal app for Apple silicon and Intel Macs (3.1 and later). It isn't signed by Apple (ad hoc only), so the first time macOS blocks it: **System Settings → Privacy & Security → Open Anyway** (on macOS 14 and earlier, right-click the app → **Open**). It updates itself (Tauri's updater, checked against the release key) once it is in a folder it can write, such as Applications; from the disk image, or where macOS runs it from a hidden copy, it says why it can't and links to the release page. (The 2.x Electron app was for Apple silicon only and could only point to the release page.)
- **Version numbers** must always go up; the app only offers updates with a higher version than the installed one.
- **OpenSubtitles** – the app's API key is a repository secret, not part of the code: **Settings → Secrets and variables → Actions → New repository secret**, name `OPENSUBTITLES_API_KEY`. The release build writes it into the app. Without it, the app works but can't search OpenSubtitles.
- **TMDB (cast photos)** – the same way: a repository secret named `TMDB_API_KEY`, holding the "API Key" from themoviedb.org → Settings → API (free account). Without it, the cast shows initials.
- **Never** put passwords or provider logins in the repository. Playlists are stored inside the app on each computer, not in the code.
- To run the app from source: [Node.js](https://nodejs.org) 18 or newer, [Rust](https://rustup.rs) and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/), then `npm install` and `npm start` (downloads ffmpeg once). For Trending, cast photos and OpenSubtitles, set `TMDB_API_KEY` and `OPENSUBTITLES_API_KEY` in the environment when you run it (they are built in).
- To test an installer on your own machine without GitHub: `npm install`, then `npm run dist` (output in `src-tauri/target/release/bundle/`).
- If the Action fails, open the failed run in the **Actions** tab and read the red step. The most common causes are forgetting step 3 (workflow permissions) or a tag that doesn't match the version in `package.json`.

## 7. Android TV

The same tag also builds the Android TV app: the *Release* workflow's `android-tv` job adds `AG-Horizon-TV-<version>.apk` to the draft release, next to the desktop installers. It takes its version from `package.json`, like they do. Nothing more to do per release.

### The signing key (once)

Android only installs a new version over the old one when both are signed with the same key. So the app needs a key of its own that never changes, kept as repository secrets. **Until you add it, each build is signed with a throwaway key**: it installs, but the next version won't install over it, from inside the app or by hand (people would have to uninstall first, losing their playlists). The workflow says so with a warning. Do this before you hand the first APK to anyone:

1. Make the key. With Java installed (`keytool` comes with it):
   ```
   keytool -genkeypair -v -keystore aghorizon-tv.keystore -alias aghorizon -keyalg RSA -keysize 4096 -validity 20000 -storetype PKCS12 -dname "CN=AG Horizon"
   ```
   It asks for a password; remember it. Without Java, in *Git Bash* (it has `openssl`):
   ```
   openssl req -x509 -newkey rsa:4096 -nodes -keyout key.pem -out cert.pem -days 20000 -subj "/CN=AG Horizon"
   openssl pkcs12 -export -inkey key.pem -in cert.pem -name aghorizon -out aghorizon-tv.keystore
   ```
2. Turn the file into text: `base64 -w0 aghorizon-tv.keystore` (macOS: `base64 -i aghorizon-tv.keystore`; Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("aghorizon-tv.keystore"))`).
3. In the repository: **Settings → Secrets and variables → Actions → New repository secret**, three times:
   - `ANDROID_KEYSTORE_BASE64`: that text
   - `ANDROID_KEYSTORE_PASSWORD`: the password
   - `ANDROID_KEY_ALIAS`: `aghorizon`
4. **Keep the keystore file and its password somewhere safe** (a password manager), and never commit them. If the key is lost, nobody can update the app any more without uninstalling it first. `android/.gitignore` already keeps `*.keystore` and `*.jks` out.

### What people do

They download the `.apk` from the release and install it on the TV once (the README's *Android TV* section says how). From then on the app updates itself much like the desktop app: on start it asks GitHub whether a newer published release (on the Test channel: also a pre-release, see section 4) has an `.apk`, shows a banner, downloads the file and opens Android's installer with it, which asks the person before it installs. The first time, Android also asks whether AG Horizon may install apps. If any of that doesn't work on a TV, the app says where the file is so it can be installed by hand.

### Checking it

- Every push that touches the app's parts runs the *Android TV* workflow: it builds a debug APK and tries it on an emulator (`android/ci/smoke.js`): the app starts, a playlist loads, live TV and a movie play in the TV's player, the remote's keys do what they should, and where a movie stopped is remembered. The APK and the screenshots it took are attached to the run.
- That emulator is not a TV. Before a release, install the APK on a real one and at least: add your playlist with the on-screen keyboard, watch a channel with AC-3 sound, change channel with ▲ ▼, play and resume a movie.

### Building it yourself

You need [Android Studio](https://developer.android.com/studio) (or the Android SDK with the NDK and CMake) and Java 17. Then, in `android/`:

```
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The build copies `public/` into the app and builds the app's server, the Rust server (`server-rs/jni`), for each processor type with [cargo-ndk](https://github.com/bbqsrc/cargo-ndk): it needs Rust with the Android targets (`rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`), `cargo install cargo-ndk`, and the Android NDK (`ANDROID_NDK_HOME`). A debug build's pages can be inspected from Chrome on your computer: `chrome://inspect`. To see the pages in TV mode without a TV, that is the way; in a normal browser they are the desktop app.

### Things to know

- **The server must keep running on Node.js 18 without the Unicode tables.** That is what the app has inside (nodejs-mobile). In `server.js` and `subtitles.js`: no `/\p{…}/u` in a regular expression, no `Intl`, and nothing newer than Node.js 18 without a fallback. The emulator test catches it when the server doesn't start.
- **Processor types.** The APK holds the app for 64-bit and 32-bit ARM, which is every TV box and set; that makes it about 45 MB.
- **Test versions** get the same Android version code as the release they lead up to (2.5.0-beta.1 and 2.5.0 are both 20500). Android installs an equal code over the other, so beta → beta → release works; what stops an older version from being offered is the app's own version check.
- **Not in the Play Store.** Google requires TV apps there to be built for 16 KB memory pages, and Node.js for Android isn't yet; it would also need an app bundle and Google's TV review. Sideloading has none of that.
- **Old TVs.** The pages need *Android System WebView* 111 or newer (March 2023). TVs update it through their app store; the app says so when it is older.

## 8. Windows: the Tauri app's update key

On the `migration/tauri` branch, Windows is built as the Tauri app (`MIGRATION_PLAN.md`). Its updates are accepted only if they are signed with **your** update key. The release workflow signs them; installed apps check the signature against the public key built into them.

- **The public key** is in the repository: `plugins.updater.pubkey` in `src-tauri/tauri.conf.json` (key ID `F074C66F1E88511B`). The Electron apps' hand-over (2.5.0, 2.6.0) has it built in too.
- **The private key** (`aghorizon.key`, made with `npx @tauri-apps/cli signer generate`) and its password are kept by you, with a copy somewhere other than your PC. They are the repository secrets `TAURI_SIGNING_PRIVATE_KEY` (the file's content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. The Windows release build stops with an error if the key is missing.
- **If the private key or its password is lost**, installed copies can never be updated again: everyone would have to download and install the next version by hand, and the new key's public half would have to be built in. Keep the backup.
- **Never** commit the private key, paste it anywhere, or use it in a test: the CI tests (`tauri-update.yml`) make their own throwaway key.
- What a Windows release carries: `AG-Horizon-Setup-<version>.exe`, `AG-Horizon-Setup-<version>.exe.sig` and `latest.json`. No `latest.yml` / `beta.yml` for Windows any more: old Windows Electron apps find the Tauri app only through the bridge version's hand-over (`MIGRATION_PLAN.md` 1.3), so **the bridge version must have been released before the first tag on this branch**.
- Channels work as before: Stable takes GitHub's latest release; Test takes the newest published release, beta or not, that has a `latest.json`. Never a downgrade.
- **A stable release** (no dash in the version) also gets the bridge release's `latest.yml`, `latest-mac.yml` and `latest-linux.yml`, pointing back at the bridge's downloads (`bridge-feed` job, `scripts/bridge-feed.js`; the bridge is `v2.6.0`). Electron apps older than the bridge read those in GitHub's latest release: they update to the bridge, which hands over to the Tauri app. Keep this until no old Electron apps are left (`MIGRATION_PLAN.md` 10.4).

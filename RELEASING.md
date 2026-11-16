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

## 4. What users see

- On start (if "Check for updates when the app starts" is on) and whenever they press **Check for updates**, the app asks GitHub for the newest published release.
- If one is newer it shows "Version X is available" → **Download update** (progress bar) → **Restart and install**. A downloaded update also installs by itself the next time the app is closed.
- Their playlists, favorites and history are kept; they live in the user data folder, not in the installation.

## 5. Things to know

- **Windows** – works out of the box. Because the installer isn't code-signed, Windows SmartScreen shows "Windows protected your PC" on the *first* install: **More info → Run anyway**. Updates installed from inside the app don't show this again.
- **Linux** – the `.AppImage` updates itself. Make it executable once (`chmod +x`).
- **macOS** – the build is for Apple-silicon Macs (M1 and newer). macOS only allows in-app updating for apps that are **signed and notarized** (an Apple Developer account, $99/year). So on a Mac the app only checks for a newer version and offers **Download from GitHub**, where people download the new `.dmg` by hand. First launch of an unsigned app: right-click the app → **Open**. Signing can be added to the workflow later.
- **Intel Macs** – not built. `ffmpeg-static` ships a different binary per processor type, so each needs its own build machine. Ask if you want it added.
- **Version numbers** must always go up; the app only offers updates with a higher version than the installed one.
- **OpenSubtitles** – the app's API key is a repository secret, not part of the code: **Settings → Secrets and variables → Actions → New repository secret**, name `OPENSUBTITLES_API_KEY`. The release build writes it into the app. Without it, the app works but can't search OpenSubtitles. To use it when running from source, create `secrets.json` in the app folder containing `{ "opensubtitlesApiKey": "your key" }` (it is in `.gitignore`).
- **TMDB (cast photos)** – the same way: a repository secret named `TMDB_API_KEY`, holding the "API Key" from themoviedb.org → Settings → API (free account). Without it, the cast shows initials. From source: add `"tmdbApiKey": "your key"` to `secrets.json`.
- **Never** put passwords or provider logins in the repository. Playlists are stored inside the app on each computer, not in the code.
- To run the app from source: [Node.js](https://nodejs.org) 18 or newer, then `npm install` (downloads Electron and ffmpeg once) and `npm start`. For Trending, cast photos and OpenSubtitles, put the API keys in a `secrets.json` next to `server.js`: `{ "tmdbApiKey": "…", "opensubtitlesApiKey": "…" }` (it is never committed).
- To test an installer on your own machine without GitHub: `npm install`, then `npm run dist` (output in `dist/`).
- If the Action fails, open the failed run in the **Actions** tab and read the red step. The most common causes are forgetting step 3 (workflow permissions) or a tag that doesn't match the version in `package.json`.

## 6. Android TV

The same tag also builds the Android TV app: the *Release* workflow's `android-tv` job adds `AG-Horizon-TV-<version>.apk` to the draft release, next to the desktop installers. It takes its version from `package.json`, like they do. Nothing more to do per release.

### The signing key (once)

Android only installs a new version over the old one when both are signed with the same key. So the app needs a key of its own that never changes, kept as repository secrets. **Until you add it, each build is signed with a throwaway key**: it installs, but the next version won't install over it (people would have to uninstall first, losing their playlists). The workflow says so with a warning. Do this before you hand the first APK to anyone:

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

They download the `.apk` from the release and install it on the TV (the README's *Android TV* section says how). The app can't update itself: on start it asks GitHub whether a newer release has an `.apk`, and says so in **Settings › About & updates** and in a banner; they then install the new file over the old one.

### Checking it

- Every push that touches the app's parts runs the *Android TV* workflow: it builds a debug APK and tries it on an emulator (`android/ci/smoke.js`): the app starts, a playlist loads, live TV and a movie play in the TV's player, the remote's keys do what they should, and where a movie stopped is remembered. The APK and the screenshots it took are attached to the run.
- That emulator is not a TV. Before a release, install the APK on a real one and at least: add your playlist with the on-screen keyboard, watch a channel with AC-3 sound, change channel with ▲ ▼, play and resume a movie.

### Building it yourself

You need [Android Studio](https://developer.android.com/studio) (or the Android SDK with the NDK and CMake) and Java 17. Then, in `android/`:

```
./gradlew assembleDebug        # → app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The build copies `server.js`, `subtitles.js` and `public/` into the app, and downloads Node.js for Android once (about 100 MB). A debug build's pages can be inspected from Chrome on your computer: `chrome://inspect`. To see the pages in TV mode without a TV, that is the way; in a normal browser they are the desktop app.

### Things to know

- **The server must keep running on Node.js 18 without the Unicode tables.** That is what the app has inside (nodejs-mobile). In `server.js` and `subtitles.js`: no `/\p{…}/u` in a regular expression, no `Intl`, and nothing newer than Node.js 18 without a fallback. The emulator test catches it when the server doesn't start.
- **Processor types.** The APK holds the app for 64-bit and 32-bit ARM, which is every TV box and set; that makes it about 45 MB.
- **Not in the Play Store.** Google requires TV apps there to be built for 16 KB memory pages, and Node.js for Android isn't yet; it would also need an app bundle and Google's TV review. Sideloading has none of that.
- **Old TVs.** The pages need *Android System WebView* 111 or newer (March 2023). TVs update it through their app store; the app says so when it is older.

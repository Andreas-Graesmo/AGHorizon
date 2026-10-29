# Releasing AG Horizon and updating it from inside the app

How it works: you push a version tag to GitHub → a GitHub Action builds the installers for Windows, macOS and Linux and attaches them to a GitHub *Release* → installed copies of the app find the new release (**Settings → About & updates → Check for updates**, and automatically on start) and update themselves.

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
- **macOS** – the build is for Apple-silicon Macs (M1 and newer). macOS only allows in-app updating for apps that are **signed and notarized** (an Apple Developer account, $99/year). Without that, "Restart and install" fails and the app offers **Open releases page** so people can download the new `.dmg` by hand. First launch of an unsigned app: right-click the app → **Open**. Signing can be added to the workflow later.
- **Intel Macs** – not built. `ffmpeg-static` ships a different binary per processor type, so each needs its own build machine. Ask if you want it added.
- **Version numbers** must always go up; the app only offers updates with a higher version than the installed one.
- **Never** put passwords or provider logins in the repository. Playlists are stored inside the app on each computer, not in the code.
- To test an installer on your own machine without GitHub: `npm install`, then `npm run dist` (output in `dist/`).
- If the Action fails, open the failed run in the **Actions** tab and read the red step. The most common causes are forgetting step 3 (workflow permissions) or a tag that doesn't match the version in `package.json`.

fn main() {
    // The app's own commands, given permissions so the capability can grant them to the page's origin.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["downloads", "sync", "popups", "migration", "updater", "keep_awake"])),
    )
    .expect("tauri-build failed");
    // The app's version is package.json's (tauri.conf.json "version"), built into the program: rebuild when it changes.
    // Without this a build after only a version change kept the old one, and the "new" version offered itself the
    // same update over and over (found by e2e/tauri-update-unix.js).
    println!("cargo:rerun-if-changed=../package.json");
}

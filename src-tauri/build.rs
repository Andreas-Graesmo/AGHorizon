fn main() {
    // The app's own commands, given permissions so the capability can grant them to the page's origin.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["downloads", "sync", "popups", "migration", "updater", "keep_awake"])),
    )
    .expect("tauri-build failed");
}

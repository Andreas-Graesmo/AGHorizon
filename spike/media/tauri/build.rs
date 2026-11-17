fn main() {
    // App commands get permissions (allow-spike-ping, allow-popup-mode, ...) so a capability can grant them to the
    // remote origin http://127.0.0.1:47831, as MIGRATION_PLAN.md 2.8 proposes for the real app.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["spike_ping", "spike_done", "popup_mode", "popup_windows", "popup_fullscreen", "monitors"])),
    )
    .expect("tauri-build failed");
}

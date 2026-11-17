// The app's version, for OpenSubtitles' User-Agent ("AGHorizon v<version>", as subtitles.js sends it): from the
// repository's package.json, the one version source of the desktop and TV apps.
fn main() {
    let pkg = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json");
    println!("cargo:rerun-if-changed={}", pkg.display());
    let text = std::fs::read_to_string(&pkg).unwrap_or_default();
    let version = text
        .split("\"version\"")
        .nth(1)
        .and_then(|rest| rest.split('"').nth(1))
        .unwrap_or("0.0.0")
        .to_string();
    println!("cargo:rustc-env=AGH_APP_VERSION={version}");
}

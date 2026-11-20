import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// One version for every system: the one in the app's package.json. 2.4.1 becomes version code 20401.
val appVersion = (JsonSlurper().parse(rootProject.file("../package.json")) as Map<*, *>)["version"] as String
val versionParts = appVersion.substringBefore('-').split('.').map { it.toInt() }
val appVersionCode = versionParts[0] * 10000 + versionParts[1] * 100 + versionParts[2]

// Release signing: a keystore file and its passwords, from the environment (the release workflow sets them from
// repository secrets). Without them a release build is signed with the debug key, so it still installs.
val keystorePath: String? = System.getenv("ANDROID_KEYSTORE_FILE")?.takeIf { it.isNotBlank() && file(it).exists() }

android {
    namespace = "app.aghorizon.tv"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.aghorizon.tv"
        minSdk = 24            // Android 7, as with Node.js before (MIGRATION_PLAN.md 8.7)
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                // its own password if the key has one (ANDROID_KEY_PASSWORD), else the keystore's. A secret that isn't set arrives as an empty text.
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD")?.takeIf { it.isNotEmpty() } ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        debug {
            ndk { abiFilters += "x86_64" }   // emulators
        }
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    sourceSets["main"].jniLibs.srcDir(layout.buildDirectory.dir("generated/rustServer"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/serverAssets"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { checkReleaseBuilds = false; abortOnError = false }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    val media3 = "1.8.0"
    implementation("androidx.core:core:1.16.0")   // FileProvider: hands a downloaded update to Android's installer
    implementation("androidx.media3:media3-exoplayer:$media3")
    implementation("androidx.media3:media3-exoplayer-hls:$media3")
    implementation("androidx.media3:media3-datasource:$media3")
    implementation("androidx.media3:media3-ui:$media3")
    // sound the device has no decoder of its own for (AC-3, E-AC-3, DTS, MP2…): ffmpeg's, built by the Jellyfin project
    implementation("org.jellyfin.media3:media3-ffmpeg-decoder:$media3+1")
}

/* ── the app's own server: the Rust server (server-rs/jni, MIGRATION_PLAN.md 8.7) and the desktop app's pages ── */
val serverAssets by tasks.registering(Sync::class) {
    from(rootProject.file("..")) {
        include("secrets.json")
        include("public/**")
        exclude("public/mirror.html", "public/mirror.js", "public/vendor/**")   // desktop only: mirror window, the web player's libraries
    }
    into(layout.buildDirectory.dir("generated/serverAssets/server"))
}

// libagh_server.so for each processor type, built with cargo-ndk (needs the Rust targets, cargo-ndk and the NDK;
// android.yml and release.yml install them). Debug builds also for the emulator (x86_64).
val rustServer by tasks.registering(Exec::class) {
    val out = layout.buildDirectory.dir("generated/rustServer")
    val debug = gradle.startParameter.taskNames.any { it.contains("Debug", ignoreCase = true) }
    val abis = listOf("arm64-v8a", "armeabi-v7a") + if (debug) listOf("x86_64") else emptyList()
    inputs.dir(rootProject.file("../server-rs/src"))
    inputs.dir(rootProject.file("../server-rs/jni/src"))
    inputs.files(rootProject.file("../server-rs/Cargo.toml"), rootProject.file("../server-rs/jni/Cargo.toml"))
    inputs.property("abis", abis)
    outputs.dir(out)
    workingDir = rootProject.file("../server-rs/jni")
    commandLine(listOf("cargo", "ndk", "--platform", "24") + abis.flatMap { listOf("-t", it) } + listOf("-o", out.get().asFile.absolutePath, "build", "--release"))
}

tasks.named("preBuild") { dependsOn(serverAssets, rustServer) }

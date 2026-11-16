import groovy.json.JsonSlurper
import java.net.URI
import java.security.MessageDigest
import java.util.Base64

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
        minSdk = 24            // Node.js for Android needs Android 7
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersion
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
        externalNativeBuild { cmake { arguments += "-DANDROID_STL=c++_shared" } }   // libnode.so needs libc++_shared.so
    }

    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: System.getenv("ANDROID_KEYSTORE_PASSWORD")
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

    externalNativeBuild { cmake { path = file("CMakeLists.txt") } }
    sourceSets["main"].jniLibs.srcDir("libnode/bin")
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/nodeAssets"))

    // libnode.so is about 60 MB per processor type: keep it compressed in the APK (a third of the download)
    packaging { jniLibs { useLegacyPackaging = true } }

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

/* ── the app's own server: the same server.js and public/ as the desktop app, packed as assets ── */
val nodeProject by tasks.registering(Sync::class) {
    from(rootProject.file("..")) {
        include("server.js", "subtitles.js", "unicode-ln.js", "package.json", "secrets.json")
        include("public/**")
        exclude("public/mirror.html", "public/mirror.js", "public/vendor/**")   // desktop only: mirror window, the web player's libraries
    }
    from("nodejs")
    into(layout.buildDirectory.dir("generated/nodeAssets/nodejs-project"))
}

/* ── Node.js for Android: libnode.so from the nodejs-mobile project, taken from its npm package (checked against npm's checksum) ── */
val nodeMobileVersion = "18.20.4"
val nodeMobileSha512 = "Lba5nYNwEbw+K9WQnxcyY/9Beagw+NIVbyrCU6burCJZ1p1iKxSXTp5rctgvRxzQb4ARY0r9Uy1k7Dseb1FhVw=="
val libnodeDir = layout.projectDirectory.dir("libnode")
val libnode by tasks.registering {
    val marker = libnodeDir.file("version.txt").asFile
    val abis = listOf("arm64-v8a", "armeabi-v7a", "x86_64")
    val tgz = layout.buildDirectory.file("downloads/nodejs-mobile-$nodeMobileVersion.tgz")
    inputs.property("version", nodeMobileVersion)
    outputs.dir(libnodeDir)
    onlyIf { !(marker.exists() && marker.readText().trim() == nodeMobileVersion && abis.all { libnodeDir.file("bin/$it/libnode.so").asFile.exists() }) }
    doLast {
        val file = tgz.get().asFile
        file.parentFile.mkdirs()
        logger.lifecycle("Downloading Node.js for Android $nodeMobileVersion (about 100 MB, once)…")
        var last: Exception? = null
        for (attempt in 1..3) {
            try {
                URI("https://registry.npmjs.org/nodejs-mobile-react-native/-/nodejs-mobile-react-native-$nodeMobileVersion.tgz").toURL().openStream().use { input ->
                    file.outputStream().use { input.copyTo(it) }
                }
                last = null
                break
            } catch (e: Exception) { last = e; logger.warn("Download failed (try $attempt of 3): ${e.message}"); Thread.sleep(15000) }
        }
        last?.let { throw it }
        val digest = MessageDigest.getInstance("SHA-512")
        file.inputStream().use { input -> val buf = ByteArray(1 shl 20); while (true) { val n = input.read(buf); if (n < 0) break; digest.update(buf, 0, n) } }
        val sum = Base64.getEncoder().encodeToString(digest.digest())
        check(sum == nodeMobileSha512) { "nodejs-mobile download does not match its checksum (got $sum)" }
        delete(libnodeDir)
        copy {
            from(tarTree(resources.gzip(file))) {
                include("package/android/libnode/bin/**/libnode.so", "package/LICENSE")
                eachFile { path = if (name == "LICENSE") "LICENSE" else "bin/" + path.substringAfter("libnode/bin/") }
                includeEmptyDirs = false
            }
            into(libnodeDir)
        }
        marker.writeText(nodeMobileVersion)
        file.delete()
    }
}

tasks.named("preBuild") { dependsOn(nodeProject, libnode) }
tasks.configureEach { if (name.startsWith("configureCMake") || name.startsWith("buildCMake") || name.contains("JniLibFolders")) dependsOn(libnode) }

package app.aghorizon.tv

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The app's own server: the same Rust server as the desktop app (server-rs, MIGRATION_PLAN.md 8.7), inside this
 * process as libagh_server.so, started over JNI. It serves the pages and talks to the providers. (Until 3.x this was
 * server.js on Node.js, from the nodejs-mobile project; the pages and the player didn't change.)
 */
object AppServer {
    // The pages keep playlists in localStorage, which belongs to the address including the port: always the same one.
    const val PORT = 47831
    const val ORIGIN = "http://127.0.0.1:$PORT"
    private const val TAG = "AGHorizon"

    @Volatile private var started = false
    @Volatile private var up = false

    /** Why the server isn't running, once it has failed. */
    @Volatile var failure: String? = null
        private set

    /** Starts the server (server-rs/jni): "" once it listens, else why not. It then runs as long as the process. */
    @JvmStatic private external fun startServer(port: Int, publicDir: String, tmpDir: String, openSubtitlesKey: String, tmdbKey: String): String

    /** Starts the server once per process; returns at once. */
    @Synchronized
    fun ensureStarted(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        Thread({
            try {
                val pages = installPages(app)
                val tmp = File(app.cacheDir, "server-tmp").apply { mkdirs() }
                val keys = readKeys(app)
                System.loadLibrary("agh_server")
                Log.i(TAG, "starting the server on $PORT, pages in $pages")
                val error = startServer(PORT, pages.absolutePath, tmp.absolutePath, keys.optString("opensubtitlesApiKey"), keys.optString("tmdbApiKey"))
                if (error.isEmpty()) up = true else failure = "The app's server could not start: $error"
            } catch (e: Throwable) {
                Log.e(TAG, "the server could not start", e)
                failure = "The app's server could not start: ${e.message ?: e}"
            }
        }, "agh-server-start").start()
    }

    /** Waits until the server answers on its port. False when it failed or didn't come up in time. */
    fun waitUntilUp(timeoutMs: Long = 30_000): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (failure != null) return false
            if (up) {
                try {
                    Socket().use { it.connect(InetSocketAddress("127.0.0.1", PORT), 400) }
                    return true
                } catch (_: Exception) { /* not yet */ }
            }
            Thread.sleep(60)
        }
        return false
    }

    /** The API keys the release build puts in the APK (secrets.json: opensubtitlesApiKey, tmdbApiKey), as the desktop app has them. */
    private fun readKeys(app: Context): JSONObject =
        try { app.assets.open("server/secrets.json").use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) } } catch (_: Exception) { JSONObject() }

    /** The server reads the pages from disk, not from inside the APK: copy them out once per installed version. */
    private fun installPages(app: Context): File {
        val dir = File(app.filesDir, "server-public")
        val stamp = File(app.filesDir, "server-public.stamp")
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        val want = "${info.versionName}:${info.lastUpdateTime}"
        if (dir.isDirectory && stamp.exists() && stamp.readText() == want) return dir
        stamp.delete()
        dir.deleteRecursively()
        File(app.filesDir, "nodejs-project").deleteRecursively()   // what versions with Node.js copied out
        File(app.filesDir, "nodejs-project.stamp").delete()
        copyAssets(app.assets, "server/public", dir)
        stamp.writeText(want)
        return dir
    }

    private fun copyAssets(assets: AssetManager, path: String, out: File) {
        val children = assets.list(path) ?: emptyArray()
        if (children.isEmpty()) {   // a file
            out.parentFile?.mkdirs()
            assets.open(path).use { input -> out.outputStream().use { input.copyTo(it) } }
        } else {
            out.mkdirs()
            for (child in children) copyAssets(assets, "$path/$child", File(out, child))
        }
    }
}

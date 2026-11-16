package app.aghorizon.tv

import android.content.Context
import android.content.res.AssetManager
import android.util.Log
import java.io.File
import java.net.InetSocketAddress
import java.net.Socket

/**
 * The app's own server: the same server.js as the desktop app, run by Node.js inside this process
 * (libnode.so from the nodejs-mobile project). It serves the pages and talks to the providers.
 */
object NodeServer {
    // The pages keep playlists in localStorage, which belongs to the address including the port: always the same one.
    const val PORT = 47831
    const val ORIGIN = "http://127.0.0.1:$PORT"
    private const val TAG = "AGHorizon"

    @Volatile private var started = false

    /** Why the server isn't running, once it has failed. */
    @Volatile var failure: String? = null
        private set

    private external fun startNode(arguments: Array<String>): Int

    /** Starts Node once per process (it can't be started twice); returns at once. */
    @Synchronized
    fun ensureStarted(context: Context) {
        if (started) return
        started = true
        val app = context.applicationContext
        // Node's main thread: V8 expects about 1 MB of stack, so give it more than a Java thread gets by default
        Thread(null, {
            try {
                val project = installProject(app)
                val tmp = File(app.cacheDir, "node-tmp").apply { mkdirs() }
                System.loadLibrary("c++_shared")
                System.loadLibrary("node")
                System.loadLibrary("node-bridge")
                Log.i(TAG, "starting node in $project")
                val code = startNode(arrayOf("node", File(project, "tv-main.js").absolutePath, PORT.toString(), tmp.absolutePath))
                failure = "The app's server stopped (code $code)."
            } catch (e: Throwable) {
                Log.e(TAG, "node could not start", e)
                failure = "The app's server could not start: ${e.message ?: e}"
            }
        }, "node-main", 4L * 1024 * 1024).start()
    }

    /** Waits until the server answers on its port. False when it failed or didn't come up in time. */
    fun waitUntilUp(timeoutMs: Long = 30_000): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (failure != null) return false
            try {
                Socket().use { it.connect(InetSocketAddress("127.0.0.1", PORT), 400) }
                return true
            } catch (_: Exception) {
                Thread.sleep(120)
            }
        }
        return false
    }

    /** Node reads its files from disk, not from inside the APK: copy them out once per installed version. */
    private fun installProject(app: Context): File {
        val dir = File(app.filesDir, "nodejs-project")
        val stamp = File(app.filesDir, "nodejs-project.stamp")
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        val want = "${info.versionName}:${info.lastUpdateTime}"
        if (dir.isDirectory && stamp.exists() && stamp.readText() == want) return dir
        stamp.delete()
        dir.deleteRecursively()
        copyAssets(app.assets, "nodejs-project", dir)
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

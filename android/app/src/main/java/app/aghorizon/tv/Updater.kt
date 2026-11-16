package app.aghorizon.tv

import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * A new version: downloads its APK (the pages found it on the releases page) and hands it to Android's installer,
 * which asks the person and installs it over this one. Android only accepts it when it is signed with the same key.
 * What happens is told to the pages as { state: 'downloading' | 'ready' | 'error', percent, message }.
 */
class Updater(private val activity: Activity, private val emit: (JSONObject) -> Unit) {
    @Volatile private var busy = false
    private val file: File get() = File(File(activity.cacheDir, "update").apply { mkdirs() }, "AG-Horizon-TV.apk")
    private val debuggable: Boolean get() = (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    fun download(url: String) {
        if (busy) return
        // from the releases page, over https (a debug build may also fetch from a test server)
        if (!(url.startsWith("https://") || (debuggable && url.startsWith("http://")))) { tell("error", message = "Not a download address."); return }
        busy = true
        Thread({
            try {
                tell("downloading", 0)
                val part = File(file.path + ".part")
                var address = url
                var conn: HttpURLConnection
                var hops = 0
                while (true) {   // GitHub sends the file from another host: follow it there
                    conn = (URL(address).openConnection() as HttpURLConnection).apply {
                        instanceFollowRedirects = false
                        connectTimeout = 15_000
                        readTimeout = 30_000
                        setRequestProperty("User-Agent", "AG-Horizon-TV")
                        setRequestProperty("Accept", "application/octet-stream")
                    }
                    val code = conn.responseCode
                    if (code in 300..399 && hops++ < 5) {
                        val next = conn.getHeaderField("Location") ?: throw IOException("The download led nowhere.")
                        conn.disconnect()
                        address = URL(URL(address), next).toString()
                        if (!(address.startsWith("https://") || (debuggable && address.startsWith("http://")))) throw IOException("The download led to an unsafe address.")
                        continue
                    }
                    if (code !in 200..299) throw IOException("The download failed (HTTP $code).")
                    break
                }
                val total = conn.contentLengthLong
                conn.inputStream.use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        var done = 0L
                        var shown = 0
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            val pct = if (total > 0) (done * 100 / total).toInt() else 0
                            if (pct != shown) { shown = pct; tell("downloading", pct) }
                        }
                        if (total > 0 && done != total) throw IOException("The download was cut off.")
                    }
                }
                file.delete()
                if (!part.renameTo(file)) throw IOException("The file could not be saved.")
                tell("ready", 100)
            } catch (e: Exception) {
                Log.w(TAG, "update download failed", e)
                tell("error", message = e.message ?: e.toString())
            } finally {
                busy = false
            }
        }, "update-download").start()
    }

    /** Opens Android's installer with the downloaded file. False when there is none, or no installer. */
    fun install(): Boolean {
        if (!file.exists()) return false
        return try {
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", file)
            activity.startActivity(
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true
        } catch (e: Exception) {
            Log.w(TAG, "no installer", e)
            false
        }
    }

    private fun tell(state: String, percent: Int = 0, message: String = "") {
        emit(JSONObject().put("state", state).put("percent", percent).put("message", message))
    }

    companion object {
        private const val TAG = "AGHorizon"
    }
}

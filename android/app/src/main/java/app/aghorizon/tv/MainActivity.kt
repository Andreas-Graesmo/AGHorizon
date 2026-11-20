package app.aghorizon.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * AG Horizon for Android TV: the desktop app's pages in a WebView, served by the app's own server (AppServer, the Rust server),
 * with the TV's own player on top (PlayerController). The pages see this shell as window.AGHorizonTV (Bridge below)
 * and switch to their TV mode (public/js/tv.js).
 */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var splash: View
    private lateinit var splashText: TextView
    private lateinit var player: PlayerController
    private lateinit var updater: Updater
    private val ui = Handler(Looper.getMainLooper())
    private var pageLoaded = false
    private var destroyed = false

    private val prefs by lazy { getSharedPreferences("tv", Context.MODE_PRIVATE) }
    private val debuggable by lazy { (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.main)
        web = findViewById(R.id.web)
        splash = findViewById(R.id.splash)
        splashText = findViewById(R.id.splashText)
        updater = Updater(this) { sendToPage("tvUpdate", it) }
        player = PlayerController(this, findViewById(R.id.playerLayer), { sendToPage("tvNative", it) }) { playing ->
            // while the player is up the remote belongs to it, not to the page underneath
            web.isFocusable = !playing
            web.isFocusableInTouchMode = !playing
            if (!playing) web.requestFocus()
        }
        setUpWeb()
        AppServer.ensureStarted(this)
        loadWhenServerIsUp()
    }

    /* ───────────────────────────────── the pages ───────────────────────────────── */

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWeb() {
        WebView.setWebContentsDebuggingEnabled(debuggable)
        web.setBackgroundColor(Color.rgb(0x0c, 0x0e, 0x12))
        web.isVerticalScrollBarEnabled = false
        web.isHorizontalScrollBarEnabled = false
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true          // playlists, favorites and history live in localStorage
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            textZoom = 100
            setSupportZoom(false)
            setSupportMultipleWindows(false)
            // A TV is looked at from the sofa: lay the pages out as if the screen were CSS_WIDTH wide, whatever its
            // real resolution, so everything is large enough (the pages can ask for another width, see Bridge.setWidth).
            useWideViewPort = false
            loadWithOverviewMode = false
            userAgentString = "$userAgentString AGHorizonTV/${versionName()}"
        }
        applyScale()
        web.addJavascriptInterface(Bridge(), "AGHorizonTV")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                val line = "${m.message()} (${m.sourceId().substringAfterLast('/')}:${m.lineNumber()})"
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR) Log.e(WEB_TAG, line) else Log.i(WEB_TAG, line)
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            // the WebView stays on the app's own pages; there is no browser on a TV to send other links to
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !request.url.toString().startsWith(AppServer.ORIGIN + "/")

            override fun onPageFinished(view: WebView, url: String) {
                pageLoaded = true
                ui.postDelayed({ hideSplash() }, 6000)   // the page says when it has drawn (Bridge.ready); if it never does, show it anyway
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (!request.isForMainFrame) return
                Log.w(TAG, "page failed to load: ${error.description}")
                pageLoaded = false
                showSplash("Starting…")
                ui.postDelayed({ loadWhenServerIsUp() }, 1000)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "the WebView's renderer is gone: start over")
                player.close("stopped")
                recreate()
                return true
            }
        }
    }

    private fun applyScale() {
        val width = prefs.getInt("cssWidth", CSS_WIDTH).coerceIn(800, 1920)
        web.setInitialScale((resources.displayMetrics.widthPixels * 100f / width).roundToInt())
    }

    private fun loadWhenServerIsUp() {
        Thread({
            val up = AppServer.waitUntilUp()
            ui.post {
                if (destroyed) return@post
                if (up) web.loadUrl(AppServer.ORIGIN + "/")
                else showSplash(AppServer.failure ?: "The app's server did not start. Close the app and open it again.")
            }
        }, "wait-for-server").start()
    }

    private fun showSplash(text: String) {
        splashText.text = text
        splash.visibility = View.VISIBLE
    }

    private fun hideSplash() {
        if (!pageLoaded || splash.visibility != View.VISIBLE) return
        splash.visibility = View.GONE
        if (!player.visible) web.requestFocus()
    }

    private fun sendToPage(function: String, event: JSONObject) {
        val js = "window.$function&&window.$function($event)"
        ui.post { if (!destroyed) web.evaluateJavascript(js, null) }
    }

    private fun versionName(): String = packageManager.getPackageInfo(packageName, 0).versionName ?: ""

    /* ───────────────────────────────── the remote ───────────────────────────────── */

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (player.visible) return player.onKey(event) || super.dispatchKeyEvent(event)
        when (event.keyCode) {
            // Back: the page decides (close a dialog, go back a page, leave the app from the first page)
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_UP) {
                    if (!pageLoaded) finish()
                    else web.evaluateJavascript("window.tvBack?window.tvBack():false") { handled -> if (handled != "true") finish() }
                }
                return true
            }
            KeyEvent.KEYCODE_MENU -> {
                if (event.action == KeyEvent.ACTION_UP && pageLoaded) web.evaluateJavascript("window.tvMenu&&window.tvMenu()", null)
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /* ───────────────────────────────── life cycle ───────────────────────────────── */

    override fun onResume() {
        super.onResume()
        web.onResume()
        if (!player.visible) web.requestFocus()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onStop() {
        player.close()   // Home, or another app on top: a TV app stops playing when it leaves the screen
        super.onStop()
    }

    override fun onDestroy() {
        destroyed = true
        ui.removeCallbacksAndMessages(null)
        player.close("stopped")
        web.removeJavascriptInterface("AGHorizonTV")
        web.destroy()
        super.onDestroy()
    }

    /* ─────────────────────── what the pages can ask the shell (window.AGHorizonTV) ─────────────────────── */

    private inner class Bridge {
        /** { version, android, device, width } */
        @JavascriptInterface
        fun info(): String = JSONObject()
            .put("version", versionName())
            .put("android", Build.VERSION.RELEASE)
            .put("sdk", Build.VERSION.SDK_INT)
            .put("device", listOf(Build.MANUFACTURER, Build.MODEL).filter { !it.isNullOrBlank() }.joinToString(" "))
            .put("width", prefs.getInt("cssWidth", CSS_WIDTH))
            .toString()

        /** The first page is drawn: the start-up screen can go. */
        @JavascriptInterface
        fun ready() { ui.post { hideSplash() } }

        /** Play: { token, url, ua, title, sub, live, start (seconds), audioLang, subLang, kind ('hls' | 'file' | '') } */
        @JavascriptInterface
        fun play(json: String) {
            ui.post {
                if (destroyed) return@post
                try { player.play(JSONObject(json)) } catch (e: Exception) { Log.e(TAG, "play failed", e) }
            }
        }

        /** New title lines for what plays: { token, title, sub } */
        @JavascriptInterface
        fun banner(json: String) {
            ui.post { try { player.banner(JSONObject(json)) } catch (e: Exception) { Log.w(TAG, "banner failed", e) } }
        }

        @JavascriptInterface
        fun stop() { ui.post { player.close("stopped") } }

        /** What the player is doing right now, as JSON (state, position, picture size, codecs, decoders). */
        @JavascriptInterface
        fun playerState(): String = player.snapshot

        /** How wide the pages are laid out, in CSS pixels (smaller: everything larger). Takes effect at once. */
        @JavascriptInterface
        fun setWidth(width: Int) {
            prefs.edit().putInt("cssWidth", width).apply()
            ui.post { if (!destroyed) { applyScale(); web.reload() } }
        }

        /** A new version: download its APK (the pages hear how it goes through window.tvUpdate)… */
        @JavascriptInterface
        fun updateDownload(url: String) { updater.download(url) }

        /** …and open Android's installer with it. False when that can't be done. */
        @JavascriptInterface
        fun updateInstall(): Boolean = updater.install()

        /** Back on the first page: leave the app. */
        @JavascriptInterface
        fun exit() { ui.post { finish() } }
    }

    companion object {
        private const val TAG = "AGHorizon"
        private const val WEB_TAG = "AGHorizonWeb"
        private const val CSS_WIDTH = 1120
    }
}

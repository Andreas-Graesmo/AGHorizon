package app.aghorizon.tv

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.Util
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.PlayerView
import androidx.media3.ui.SubtitleView
import org.json.JSONObject
import java.util.Date

/**
 * The TV's player: ExoPlayer, full screen over the app's pages, with its own controls for the remote.
 * The pages decide what plays (play / stop); the player tells them what happened (see [emit]):
 *   time   – where a movie or episode is now (every few seconds, and when it pauses)
 *   ended  – a movie or episode played to its end
 *   closed – the person left the player (Back)
 *   error  – it could not be played (the message is on screen until Back)
 *   zap    – another channel is wanted: delta +1 (next) or -1 (previous)
 *   skip   – another episode is wanted: delta +1 or -1
 *   digit  – a number key was pressed while a channel plays: n
 * Every event carries the token of the play request it belongs to.
 */
class PlayerController(
    private val activity: Activity,
    private val layer: ViewGroup,
    private val emit: (JSONObject) -> Unit,
    private val onVisibility: (Boolean) -> Unit,
) {
    private class Request(json: JSONObject) {
        val token: Int = json.optInt("token")
        val url: String = json.getString("url")
        val ua: String = json.optString("ua")
        val title: String = json.optString("title")
        val sub: String = json.optString("sub")
        val live: Boolean = json.optBoolean("live")
        val startMs: Long = (json.optDouble("start", 0.0) * 1000).toLong()
        val audioLang: String = json.optString("audioLang")
        val subLang: String = json.optString("subLang")
        var hls: Boolean = json.optString("kind").let { k -> if (k.isEmpty()) looksLikeHls(url) else k == "hls" }
        var triedOtherKind = false
        var retries = 0
        var subsChecked = false
    }

    private val playerView: PlayerView = layer.findViewById(R.id.playerView)
    private val banner: View = layer.findViewById(R.id.banner)
    private val bannerNum: TextView = layer.findViewById(R.id.bannerNum)
    private val bannerTitle: TextView = layer.findViewById(R.id.bannerTitle)
    private val bannerSub: TextView = layer.findViewById(R.id.bannerSub)
    private val clock: TextView = layer.findViewById(R.id.clock)
    private val message: TextView = layer.findViewById(R.id.playerMessage)
    private val controls = PlayerControls(layer) { onControls(it) }
    private val handler = Handler(Looper.getMainLooper())
    private var player: ExoPlayer? = null
    private var req: Request? = null

    val visible: Boolean get() = layer.visibility == View.VISIBLE

    /** What the player is doing, as JSON: for the stream details and for tests. Kept up to date on the main thread, read from any. */
    @Volatile var snapshot: String = "{}"
        private set
    private var audioDecoder = ""
    private var videoDecoder = ""
    private var lastError = ""

    init {
        playerView.isFocusable = true
        playerView.isFocusableInTouchMode = true
        playerView.descendantFocusability = ViewGroup.FOCUS_AFTER_DESCENDANTS
        // CC › Appearance… (#29): the subtitles on screen change at once, and the page keeps the choice (Settings)
        controls.onLook = { l ->
            subLook(l)
            req?.let { r -> emit(JSONObject().put("type", "subLook").put("token", r.token).put("look", l.optJSONObject("cur"))) }
        }
    }

    /** The title shows with the controls (and for a moment when something starts, see showBanner). */
    private fun onControls(shown: Boolean) {
        if (shown) {
            showClock()
            banner.visibility = View.VISIBLE
        } else {
            if (SystemClock.uptimeMillis() >= bannerUntil) banner.visibility = View.GONE
            playerView.requestFocus()
        }
        titleLines(shown)
        updateSnapshot()
    }

    /** With the controls, one line as in the desktop player ("Marshals · S01E01 · …"); a channel's programme is in
     *  the controls then, so it isn't repeated up here. Without them, the title and the line under it. */
    private fun titleLines(shown: Boolean) {
        val (title, sub) = bannerText
        val vod = req?.live == false
        bannerTitle.text = if (shown && vod && sub.isNotEmpty() && !title.contains(sub)) "$title  ·  $sub" else title   // not "Film (2024) · 2024"
        bannerSub.visibility = if (sub.isEmpty() || shown) View.GONE else View.VISIBLE
    }

    /* ───────────────────────────── what the pages ask for ───────────────────────────── */

    fun play(json: JSONObject) {
        val r = Request(json)
        req = r
        handler.removeCallbacks(hideLayer)
        playerView.videoSurfaceView?.visibility = View.VISIBLE   // hidden when the last one closed (see close)
        if (!visible) {
            layer.visibility = View.VISIBLE
            onVisibility(true)
        }
        playerView.requestFocus()
        controls.reset(r.live, json.optString("accent"))
        controls.programme(json.optJSONArray("now"), json.optJSONArray("next"))
        subLook(json.optJSONObject("subLook"))
        setBanner(r.title, r.sub, json.optString("num"))
        showBanner()
        // the sound and subtitles picked for the last title are not for this one
        player?.let { p -> p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().clearOverrides().build() }
        start(r, r.startMs)
    }

    /**
     * How subtitles look, as chosen in the app's Settings › Languages › Subtitles (#29; subLookForTv() in
     * subtitles.js): size, colour, background and its opacity, height, and the kind of font. The person's choice wins
     * over a subtitle file's own styling, as on a computer. Nothing given (an older page): ExoPlayer's own look.
     */
    private fun subLook(l: JSONObject?) {
        controls.look = l   // CC › Appearance… in the player changes it from there
        val view = playerView.subtitleView ?: return
        if (l == null) {
            view.setUserDefaultStyle()
            view.setUserDefaultTextSize()
            view.setBottomPaddingFraction(SubtitleView.DEFAULT_BOTTOM_PADDING_FRACTION)
            view.setApplyEmbeddedStyles(true)
            view.setApplyEmbeddedFontSizes(true)
            return
        }
        val color = parse(l.optString("color"), Color.WHITE)
        val alpha = (l.optDouble("opacity", 0.6).coerceIn(0.0, 1.0) * 255).toInt()
        val bg = (parse(l.optString("bg"), Color.BLACK) and 0x00ffffff) or (alpha shl 24)
        // with little or no background, an outline keeps the text readable on bright pictures (as --sub-shadow)
        val edge = if (alpha < 90) CaptionStyleCompat.EDGE_TYPE_OUTLINE else CaptionStyleCompat.EDGE_TYPE_NONE
        val face = when (l.optString("font")) { "serif" -> Typeface.SERIF; "monospace" -> Typeface.MONOSPACE; else -> Typeface.SANS_SERIF }
        view.setStyle(CaptionStyleCompat(color, bg, Color.TRANSPARENT, edge, Color.BLACK, face))
        view.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * l.optDouble("scale", 1.0).toFloat().coerceIn(0.5f, 2f))
        view.setBottomPaddingFraction(l.optDouble("raise", 0.08).toFloat().coerceIn(0f, 0.3f))
        view.setApplyEmbeddedStyles(false)
        view.setApplyEmbeddedFontSizes(false)
    }

    private fun parse(css: String, fallback: Int) = try { Color.parseColor(css) } catch (_: Exception) { fallback }

    /** New text for the title lines (the programme changed, the guide arrived, a channel number is typed). */
    fun banner(json: JSONObject) {
        val r = req ?: return
        if (json.optInt("token") != r.token) return
        if (json.has("now")) controls.programme(json.optJSONArray("now"), json.optJSONArray("next"))
        setBanner(json.optString("title", r.title), json.optString("sub"), json.optString("num"))
        if (json.optBoolean("show")) showBanner()
    }

    /** Stop and hide. reason "closed": the person left; "stopped": the pages asked (nothing is reported back). */
    fun close(reason: String = "closed") {
        val r = req
        if (r != null && reason == "closed") emit(event("closed", r))
        req = null
        handler.removeCallbacksAndMessages(null)
        controls.hide()
        controls.player = null
        player?.let { p ->
            // The picture is on a surface of its own (on many TVs a hardware video plane), which kept showing the last
            // frame over the page for a moment after the player went away: take it off the surface and hide the
            // surface first, and the player's black for a frame, then the page.
            p.clearVideoSurface()
            playerView.player = null
            p.removeListener(listener)
            p.release()
        }
        player = null
        playerView.videoSurfaceView?.visibility = View.INVISIBLE
        message.visibility = View.GONE
        banner.visibility = View.GONE
        layer.keepScreenOn = false
        if (visible) handler.post(hideLayer)
        updateSnapshot()
    }
    private val hideLayer = Runnable {
        if (req == null && visible) {
            layer.visibility = View.GONE
            onVisibility(false)
        }
    }

    /* ───────────────────────────────── playing ───────────────────────────────── */

    private fun ensurePlayer(): ExoPlayer {
        player?.let { return it }
        // sound the device can't decode itself (AC-3, DTS, MP2…) goes to the ffmpeg decoder that comes with the app
        val renderers = DefaultRenderersFactory(activity)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
            .setEnableDecoderFallback(true)
        val audio = AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build()
        val p = ExoPlayer.Builder(activity, renderers)
            .setSeekBackIncrementMs(15_000)   // 15 s both ways, as the desktop player (and its ⟲15 ⟳15 buttons)
            .setSeekForwardIncrementMs(15_000)
            .setAudioAttributes(audio, true)
            .build()
        p.addListener(listener)
        p.addAnalyticsListener(analytics)
        playerView.player = p
        controls.player = p
        player = p
        return p
    }

    private fun start(r: Request, positionMs: Long) {
        val p = ensurePlayer()
        message.visibility = View.GONE
        lastError = ""
        audioDecoder = ""
        videoDecoder = ""
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent(r.ua.ifBlank { DEFAULT_UA })
            .setAllowCrossProtocolRedirects(true)
            .setConnectTimeoutMs(15_000)
            .setReadTimeoutMs(20_000)
        // broadcast streams often start in the middle of a picture group and leave out what a file would have
        val extractors = DefaultExtractorsFactory()
            .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS)
        val sources = DefaultMediaSourceFactory(DefaultDataSource.Factory(activity, http), extractors)
        val item = MediaItem.Builder().setUri(r.url).apply { if (r.hls) setMimeType(MimeTypes.APPLICATION_M3U8) }.build()

        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setPreferredAudioLanguage(r.audioLang.ifBlank { null })
            .setPreferredTextLanguage(r.subLang.ifBlank { null })
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .build()
        val source = sources.createMediaSource(item)
        if (positionMs > 0 && !r.live) p.setMediaSource(source, positionMs) else p.setMediaSource(source)
        p.playWhenReady = true
        p.prepare()
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, TICK_MS)
    }

    private val tick = object : Runnable {
        private var n = 0
        override fun run() {
            val r = req ?: return
            val p = player ?: return
            controls.update()
            if (banner.visibility == View.VISIBLE) showClock()
            updateSnapshot()
            if (++n % 5 == 0 && !r.live && p.isPlaying) emit(event("time", r))
            handler.postDelayed(this, TICK_MS)
        }
    }

    private val analytics = object : AnalyticsListener {
        override fun onAudioDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
            audioDecoder = decoderName
            updateSnapshot()
        }

        override fun onVideoDecoderInitialized(eventTime: AnalyticsListener.EventTime, decoderName: String, initializedTimestampMs: Long, initializationDurationMs: Long) {
            videoDecoder = decoderName
            updateSnapshot()
        }
    }

    private fun updateSnapshot() {
        val r = req
        val p = player
        val json = JSONObject().put("visible", visible)
        if (r != null && p != null) {
            val dur = p.duration
            json.put("token", r.token).put("live", r.live).put("hls", r.hls)
                .put("state", p.playbackState).put("playing", p.isPlaying)
                .put("pos", p.currentPosition / 1000.0).put("dur", if (dur == C.TIME_UNSET || dur <= 0) 0.0 else dur / 1000.0)
                .put("width", p.videoSize.width).put("height", p.videoSize.height)
                .put("video", p.videoFormat?.let { "${it.sampleMimeType} ${it.codecs ?: ""}".trim() } ?: "")
                .put("audio", p.audioFormat?.let { "${it.sampleMimeType} ${it.language ?: ""}".trim() } ?: "")
                .put("videoDecoder", videoDecoder).put("audioDecoder", audioDecoder)
                .put("controls", controls.visible)
                .put("banner", banner.visibility == View.VISIBLE)
                .put("error", lastError)
        }
        snapshot = json.toString()
    }

    private val listener = object : Player.Listener {
        override fun onPlaybackStateChanged(state: Int) {
            val r = req ?: return
            updateSnapshot()
            if (state == Player.STATE_READY) {
                r.retries = 0
                message.visibility = View.GONE
            } else if (state == Player.STATE_ENDED) {
                if (r.live) { if (!retryLive(r)) fail(r, "The stream ended.") } else emit(event("ended", r))
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            layer.keepScreenOn = isPlaying
            controls.update()
            val r = req ?: return
            if (!isPlaying && !r.live && player?.playbackState == Player.STATE_READY) emit(event("time", r))   // paused: remember where
        }

        override fun onTracksChanged(tracks: Tracks) {
            controls.tracksChanged()
            // "Turn on subtitles automatically" is for what you don't understand: not when it is spoken in that language
            val r = req ?: return
            if (r.subsChecked || r.subLang.isBlank() || tracks.isEmpty) return
            r.subsChecked = true
            val spoken = tracks.groups.firstOrNull { it.type == C.TRACK_TYPE_AUDIO && it.isSelected }
                ?.let { g -> (0 until g.length).firstOrNull { g.isTrackSelected(it) }?.let { g.getTrackFormat(it).language } }
            if (spoken != null && sameLanguage(spoken, r.subLang)) {
                player?.let { p -> p.trackSelectionParameters = p.trackSelectionParameters.buildUpon().setPreferredTextLanguage(null).build() }
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            val r = req ?: return
            val p = player ?: return
            Log.w(TAG, "player error ${error.errorCodeName} for token ${r.token}", error)
            val code = error.errorCode
            // an address without ".m3u8" can still be an HLS playlist, and one with it can be a plain stream: try the other way once
            val wrongKind = code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED ||
                code == PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED ||
                code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED ||
                code == PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED
            if (wrongKind && !r.triedOtherKind) {
                r.triedOtherKind = true
                r.hls = !r.hls
                start(r, if (r.live) 0 else p.currentPosition)
                return
            }
            if (code == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW) {
                p.seekToDefaultPosition()
                p.prepare()
                return
            }
            if (r.live && retryLive(r)) return
            fail(r, friendly(error))
        }
    }

    /** Live streams drop now and then: connect again a few times before giving up. True when it will try again; the caller fails when not. */
    private fun retryLive(r: Request): Boolean {
        if (r.retries >= LIVE_RETRIES) return false
        r.retries++
        handler.postDelayed({
            if (req === r) player?.let { p -> p.seekToDefaultPosition(); p.prepare() }
        }, 1200L * r.retries)
        return true
    }

    private fun fail(r: Request, why: String) {
        val what = if (r.live) "Couldn't play this channel" else "Couldn't play this video"
        val hint = if (r.live) "The stream may be offline, or your subscription may have hit its connection limit."
        else "The stream may be offline, or your provider's connection limit may be used up."
        message.text = "$what\n$why\n$hint\n\nPress Back to return."
        message.visibility = View.VISIBLE
        lastError = why
        updateSnapshot()
        emit(event("error", r).put("message", why))
    }

    private fun friendly(e: PlaybackException): String {
        val http = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<HttpDataSource.InvalidResponseCodeException>().firstOrNull()
        if (http != null) return "The provider answered with an error (HTTP ${http.responseCode})."
        return when (e.errorCode) {
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED -> "Could not reach the provider."
            PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT -> "The provider took too long to respond."
            PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED, PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
            PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED, PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED -> "The stream is in a format the player doesn't know."
            PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_DECODING_FAILED,
            PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED, PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES -> "This device can't decode this video."
            else -> "Playback failed (${e.errorCodeName})."
        }
    }

    private fun event(type: String, r: Request): JSONObject {
        val p = player
        val dur = p?.duration ?: C.TIME_UNSET
        return JSONObject()
            .put("type", type)
            .put("token", r.token)
            .put("pos", (p?.currentPosition ?: 0L) / 1000.0)
            .put("dur", if (dur == C.TIME_UNSET || dur <= 0) 0.0 else dur / 1000.0)
    }

    /* ───────────────────────────────── title lines ───────────────────────────────── */

    private var bannerText = "" to ""

    private fun setBanner(title: String, sub: String, num: String) {
        bannerText = title to sub
        bannerSub.text = sub
        titleLines(controls.visible)
        bannerNum.text = num
        bannerNum.visibility = if (num.isEmpty()) View.GONE else View.VISIBLE
        bannerNum.background = GradientDrawable().apply { setColor(controls.accent); cornerRadius = 8 * activity.resources.displayMetrics.density }
    }

    private fun showClock() { clock.text = DateFormat.getTimeFormat(activity).format(Date()) }

    private var bannerUntil = 0L   // the title stays up until then, also when the controls go away meanwhile
    private val hideBanner = Runnable { if (!controls.visible) banner.visibility = View.GONE }

    private fun showBanner() {
        bannerUntil = SystemClock.uptimeMillis() + BANNER_MS
        showClock()
        banner.visibility = View.VISIBLE
        handler.removeCallbacks(hideBanner)
        handler.postDelayed(hideBanner, BANNER_MS)
    }

    /* ───────────────────────────────── the remote ───────────────────────────────── */

    /**
     * Keys while the player is up, before the views see them. True: handled here.
     * With the controls hidden: ▲ ▼ change channel (live), ◀ ▶ skip back and forward and bring up the controls
     * (movies, episodes), OK brings up the controls. With them up, the arrows move between them (PlayerControls).
     * Back closes the list of tracks, then hides the controls, then leaves the player.
     */
    fun onKey(e: KeyEvent): Boolean {
        val r = req ?: run { if (e.action == KeyEvent.ACTION_UP && isBack(e.keyCode)) close(); return true }
        val down = e.action == KeyEvent.ACTION_DOWN
        val first = down && e.repeatCount == 0
        val shown = controls.visible
        val failed = message.visibility == View.VISIBLE
        val p = player
        when (e.keyCode) {
            KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_ESCAPE -> {
                if (e.action == KeyEvent.ACTION_UP && !controls.back()) { if (shown && !failed) controls.hide() else close() }
                return true
            }
            KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { if (first && p != null && !failed) { if (p.playWhenReady) p.pause() else p.play(); controls.show(focusPlay = !p.playWhenReady) }; return true }
            KeyEvent.KEYCODE_MEDIA_PLAY -> { if (first && !failed) { p?.play(); controls.show() }; return true }
            KeyEvent.KEYCODE_MEDIA_PAUSE -> { if (first && !failed) { p?.pause(); controls.show(focusPlay = true) }; return true }
            KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { if (down && !r.live && !failed) { p?.seekForward(); controls.show() }; return true }
            KeyEvent.KEYCODE_MEDIA_REWIND -> { if (down && !r.live && !failed) { p?.seekBack(); controls.show() }; return true }
            KeyEvent.KEYCODE_MEDIA_STOP -> { if (first) close(); return true }
            KeyEvent.KEYCODE_CHANNEL_UP, KeyEvent.KEYCODE_PAGE_UP -> { if (first) other(r, 1); return true }
            KeyEvent.KEYCODE_CHANNEL_DOWN, KeyEvent.KEYCODE_PAGE_DOWN -> { if (first) other(r, -1); return true }
            KeyEvent.KEYCODE_MEDIA_NEXT -> { if (first) other(r, 1); return true }
            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> { if (first) other(r, -1); return true }
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> if (r.live) {   // a channel number, digit by digit
                if (first) emit(JSONObject().put("type", "digit").put("token", r.token).put("n", e.keyCode - KeyEvent.KEYCODE_0))
                return true
            }
        }
        if (failed) return true   // nothing to steer: Back leaves
        if (shown) {
            if (controls.onKey(e)) return true
            // ▲ ▼ still change channel with the controls up (the buttons are one row), but not in the list of tracks
            val zap = r.live && !controls.picking && (e.keyCode == KeyEvent.KEYCODE_DPAD_UP || e.keyCode == KeyEvent.KEYCODE_DPAD_DOWN)
            if (!zap) return false
        }
        if (p == null) return false
        when (e.keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> { if (first) { if (r.live) other(r, -1) else controls.show() }; return true }
            KeyEvent.KEYCODE_DPAD_DOWN -> { if (first) { if (r.live) other(r, 1) else controls.show() }; return true }
            KeyEvent.KEYCODE_DPAD_LEFT -> if (!r.live) { if (down) { p.seekBack(); controls.show() }; return true }
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (!r.live) { if (down) { p.seekForward(); controls.show() }; return true }
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { if (first) controls.show(); return true }
        }
        return false
    }

    private fun other(r: Request, delta: Int) {
        emit(JSONObject().put("type", if (r.live) "zap" else "skip").put("token", r.token).put("delta", delta))
    }

    private fun isBack(code: Int) = code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_ESCAPE

    companion object {
        private const val TAG = "AGHorizon"
        private const val TICK_MS = 1000L
        private const val LIVE_RETRIES = 3
        private const val BANNER_MS = 4000L
        const val DEFAULT_UA = "VLC/3.0.20 LibVLC/3.0.20"   // the same as server.js

        fun looksLikeHls(url: String): Boolean {
            val path = url.substringBefore('?').lowercase()
            return path.endsWith(".m3u8") || path.endsWith(".m3u") || url.lowercase().contains("m3u8")
        }

        /** "en", "eng" and "en-GB" name the same language. */
        fun sameLanguage(a: String, b: String): Boolean {
            val x = Util.normalizeLanguageCode(a.trim()).substringBefore('-')
            val y = Util.normalizeLanguageCode(b.trim()).substringBefore('-')
            return x.isNotEmpty() && x == y
        }
    }
}

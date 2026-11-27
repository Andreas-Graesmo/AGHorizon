package app.aghorizon.tv

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.StateListDrawable
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.DefaultTrackNameProvider
import org.json.JSONArray
import org.json.JSONObject
import java.util.Date

/**
 * The player's controls for the remote, laid out like the desktop app's player (public/index.html, #player): the bar
 * with the times at its ends, sound and subtitles on the left, back 15 s / play-pause / forward 15 s in the middle,
 * LIVE on the right. For a channel with a guide, the bar is how far the programme has come, with what's next above it.
 * Sound and subtitles open a menu like the desktop app's, with the tracks named by language, channels and kind of sound.
 * PlayerController owns the player and decides when the controls come and go; this draws them and steers them.
 */
class PlayerControls(layer: ViewGroup, private val onVisible: (Boolean) -> Unit) {
    private val res = layer.resources
    private val panel: View = layer.findViewById(R.id.controls)
    private val progRow: View = layer.findViewById(R.id.progRow)
    private val progTitle: TextView = layer.findViewById(R.id.progTitle)
    private val progNext: TextView = layer.findViewById(R.id.progNext)
    private val seekRow: View = layer.findViewById(R.id.seekRow)
    private val seek: SeekBar = layer.findViewById(R.id.seek)
    private val timeLeft: TextView = layer.findViewById(R.id.timeLeft)
    private val timeRight: TextView = layer.findViewById(R.id.timeRight)
    private val btnAudio: View = layer.findViewById(R.id.btnAudio)
    private val btnSubs: View = layer.findViewById(R.id.btnSubs)
    private val btnBack: View = layer.findViewById(R.id.btnBack)
    private val btnPlay: ImageView = layer.findViewById(R.id.btnPlay)
    private val btnFwd: View = layer.findViewById(R.id.btnFwd)
    private val liveBadge: TextView = layer.findViewById(R.id.liveBadge)
    private val tracks: View = layer.findViewById(R.id.tracks)
    private val tracksTitle: TextView = layer.findViewById(R.id.tracksTitle)
    private val tracksList: LinearLayout = layer.findViewById(R.id.tracksList)
    private val handler = Handler(Looper.getMainLooper())
    private val names = DefaultTrackNameProvider(res)

    var player: ExoPlayer? = null
        set(v) {
            field = v
            if (v == null) liveTicker.removeCallbacksAndMessages(null)   // closed: nothing to measure until the next reset()
        }
    private var live = false
    private var now: JSONArray? = null    // [start ms, end ms, title] of what is on now, for a channel
    private var next: JSONArray? = null
    var accent = DEFAULT_ACCENT
        private set
    private var pickingFrom: View? = null

    /** How subtitles look (the page's subLookForTv(): the look, what is chosen, the choices); set for each title. */
    var look: JSONObject? = null
    /** CC › Appearance… changed the look: draw it, and let the page keep it. */
    var onLook: (JSONObject) -> Unit = {}
    private var level = 0          // the menu that is open: 0 the tracks, 1 Appearance, 2 one of its settings
    private var lookKey = ""       // …which one

    val visible: Boolean get() = panel.visibility == View.VISIBLE
    val picking: Boolean get() = tracks.visibility == View.VISIBLE

    init {
        btnPlay.setOnClickListener { togglePlay() }
        btnBack.setOnClickListener { player?.seekBack(); update() }
        btnFwd.setOnClickListener { player?.seekForward(); update() }
        btnAudio.setOnClickListener { pick(C.TRACK_TYPE_AUDIO, it) }
        btnSubs.setOnClickListener { pick(C.TRACK_TYPE_TEXT, it) }
        liveBadge.setOnClickListener { goLive() }
        seek.max = 1000
        seek.nextFocusDownId = R.id.btnPlay
        restyle()
    }

    /** Something new plays. accent: the app's accent colour as CSS gives it ("#6ea1ff"), or blank. */
    fun reset(live: Boolean, accent: String) {
        this.live = live
        this.accent = parseColor(accent) ?: DEFAULT_ACCENT
        now = null
        next = null
        hide()
        restyle()
        seek.isFocusable = !live   // live TV can't seek: there the bar only shows the programme
        btnBack.visibility = if (live) View.GONE else View.VISIBLE
        btnFwd.visibility = btnBack.visibility
        liveBadge.visibility = if (live) View.VISIBLE else View.GONE
        btnPlay.tag = null
        liveTicker.removeCallbacksAndMessages(null)
        liveReset()
        if (live) liveTicker.post(liveTick)
        tracksChanged()
    }

    /* ───────────── live TV: how far behind live (#18), as the desktop player measures it ───────────── */
    // HLS: ExoPlayer knows how far behind the live edge it plays (currentLiveOffset); the delay is how much more that
    // is than when it was live. Other streams (MPEG-TS over HTTP): the wall-clock time gone by minus the picture time
    // played since it was last live. While it plays normally the reference follows it; a pause or a stall holds it.
    private val liveTicker = Handler(Looper.getMainLooper())   // not `handler`: hide() clears that one
    private val liveTick = object : Runnable {
        override fun run() {
            if (!live) return   // not live TV: stops until the next reset()
            tickLive()
            liveTicker.postDelayed(this, 500)
        }
    }
    private var anchorWall = 0L
    private var anchorPos = 0L
    private var anchorOffset = C.TIME_UNSET
    private var held = false
    private var lagMs = 0L
    private var liveShown = ""

    private fun liveReset() { anchorWall = 0L; held = false; lagMs = 0L; liveShown = ""; renderLive(false) }

    private fun anchor(p: ExoPlayer) {
        anchorWall = SystemClock.elapsedRealtime()
        anchorPos = p.currentPosition
        anchorOffset = p.currentLiveOffset
        held = false
        lagMs = 0L
    }

    private fun tickLive() {
        val p = player ?: return
        if (!live) return
        val playing = p.isPlaying
        if (anchorWall == 0L) { if (playing) anchor(p); renderLive(false); return }   // live from its first picture
        if (!playing) held = true   // paused, or buffering
        val offset = p.currentLiveOffset
        val lag = if (offset != C.TIME_UNSET && anchorOffset != C.TIME_UNSET) offset - anchorOffset
            else (SystemClock.elapsedRealtime() - anchorWall) - (p.currentPosition - anchorPos)
        if (!held || (playing && lag < 500)) anchor(p) else lagMs = lag
        renderLive(!p.playWhenReady || (held && lagMs >= LIVE_BEHIND_MS))
    }

    /** LIVE in red, or a grey GO LIVE with how far behind, which OK takes back to live. */
    private fun renderLive(behind: Boolean) {
        val text = if (!behind) "●  LIVE" else if (lagMs >= 1000) "GO LIVE   −${hms(lagMs)}" else "GO LIVE"
        if (text == liveShown) return
        liveShown = text
        liveBadge.text = text
        liveBadge.background = StateListDrawable().apply {
            if (behind) addState(intArrayOf(android.R.attr.state_focused), round(Color.parseColor("#ff5a63"), 5f).apply { setStroke(dp(2), Color.WHITE) })
            addState(intArrayOf(), round(if (behind) 0x38ffffff else Color.parseColor("#ff5a63"), 5f))
        }
        liveBadge.isFocusable = behind
        if (!behind && liveBadge.hasFocus()) btnPlay.requestFocus()
    }

    /** Back to live: an HLS stream jumps to its live edge; anything else is tuned in again, which is live. */
    private fun goLive() {
        val p = player ?: return
        if (p.isCurrentMediaItemLive) p.seekToDefaultPosition() else { p.stop(); p.prepare() }
        p.play()
        liveReset()
        btnPlay.requestFocus()
    }

    /** What is on now and next on the channel (from the page's guide). */
    fun programme(now: JSONArray?, next: JSONArray?) {
        this.now = now?.takeIf { it.length() >= 2 }
        this.next = next?.takeIf { it.length() >= 3 }
        if (visible) update()
    }

    /** focusPlay: playback was just paused, so the focus goes to play/pause (to carry on with OK), not the scrub bar. */
    fun show(focusPlay: Boolean = false) {
        if (!visible) {
            panel.visibility = View.VISIBLE
            update()
            (if (!live && !focusPlay) seek else btnPlay).requestFocus()
            onVisible(true)
        } else if (focusPlay && !picking) btnPlay.requestFocus()
        hideLater()
    }

    fun hide() {
        closePicker()
        handler.removeCallbacksAndMessages(null)
        if (visible) {
            panel.visibility = View.GONE
            onVisible(false)
        }
    }

    /** Keys while the controls are up (Back and the media keys are PlayerController's). True: handled here. */
    fun onKey(e: KeyEvent): Boolean {
        hideLater()
        val down = e.action == KeyEvent.ACTION_DOWN
        if (picking) {
            // the menu goes up and down; nothing to its sides
            return e.keyCode == KeyEvent.KEYCODE_DPAD_LEFT || e.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT
        }
        if (seek.hasFocus()) {
            val p = player ?: return false
            when (e.keyCode) {
                KeyEvent.KEYCODE_DPAD_LEFT -> { if (down) { p.seekBack(); update() }; return true }
                KeyEvent.KEYCODE_DPAD_RIGHT -> { if (down) { p.seekForward(); update() }; return true }
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                    if (down && e.repeatCount == 0) togglePlay()
                    return true
                }
                KeyEvent.KEYCODE_DPAD_UP -> return true
            }
        }
        return false
    }

    /** Back with the menu of tracks open: close it. False when it wasn't open. */
    fun back(): Boolean {
        if (!picking) return false
        when (level) {
            2 -> appearance(lookKey)                                  // a setting: back to Appearance
            1 -> pick(C.TRACK_TYPE_TEXT, pickingFrom ?: btnSubs)      // Appearance: back to the subtitles
            else -> closePicker()
        }
        return true
    }

    /** The stream's tracks are known or changed: the sound and subtitle buttons only show when there is a choice. */
    fun tracksChanged() {
        btnAudio.visibility = if (choices(C.TRACK_TYPE_AUDIO).size > 1) View.VISIBLE else View.GONE
        btnSubs.visibility = if (choices(C.TRACK_TYPE_TEXT).isNotEmpty()) View.VISIBLE else View.GONE
        if (visible && panel.findFocus() == null && !picking) btnPlay.requestFocus()
    }

    /** Draw the bar, the times and play / pause again (every second while the controls are up). */
    fun update() {
        if (!visible) return
        val p = player ?: return
        if (live) updateLive() else {
            val dur = p.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L
            val pos = p.currentPosition
            progRow.visibility = View.GONE
            seekRow.visibility = View.VISIBLE
            seek.progress = if (dur > 0) (pos * 1000 / dur).toInt() else 0
            seek.secondaryProgress = if (dur > 0) (p.bufferedPosition * 1000 / dur).toInt() else 0
            timeLeft.text = hms(pos)
            timeRight.text = if (dur > 0) hms(dur) else "–:––"
        }
        val playing = p.playWhenReady
        if (btnPlay.tag != playing) {
            btnPlay.tag = playing
            btnPlay.setImageResource(if (playing) R.drawable.ic_p_pause else R.drawable.ic_p_play)
        }
    }

    private fun updateLive() {
        val n = now
        if (n == null) {
            progRow.visibility = View.GONE
            seekRow.visibility = View.GONE
            return
        }
        val start = n.optLong(0)
        val end = n.optLong(1)
        progTitle.text = n.optString(2)
        progNext.text = next?.let { "Next  ${clock(it.optLong(0))}  ${it.optString(2)}" } ?: ""
        progRow.visibility = View.VISIBLE
        seekRow.visibility = View.VISIBLE
        seek.progress = if (end > start) ((System.currentTimeMillis() - start) * 1000 / (end - start)).toInt().coerceIn(0, 1000) else 0
        seek.secondaryProgress = 0
        timeLeft.text = clock(start)
        timeRight.text = clock(end)
    }

    private fun togglePlay() {
        val p = player ?: return
        if (p.playWhenReady) p.pause() else p.play()   // not isPlaying: that is false while it buffers, and pause would do nothing
        update()
        if (!p.playWhenReady && !picking) btnPlay.requestFocus()   // paused from the scrub bar: OK on play/pause carries on
        hideLater()
    }

    /* ───────────────────────────── sound and subtitles ───────────────────────────── */

    private class Choice(val group: Tracks.Group, val index: Int) {
        val format: Format get() = group.getTrackFormat(index)
        val selected: Boolean get() = group.isTrackSelected(index)
    }

    private fun choices(type: Int): List<Choice> {
        val p = player ?: return emptyList()
        return p.currentTracks.groups.filter { it.type == type }
            .flatMap { g -> (0 until g.length).filter { g.isTrackSupported(it, true) }.map { Choice(g, it) } }
    }

    private fun pick(type: Int, from: View) {
        val list = choices(type)
        val audio = type == C.TRACK_TYPE_AUDIO
        tracksTitle.text = if (audio) "Audio" else "Subtitles"
        tracksList.removeAllViews()
        var focus: View? = null
        // Appearance… first: the list of subtitles can be long, and it shouldn't have to be scrolled through to get
        // to it (the focus still starts on the track that is on)
        if (!audio && look?.optJSONObject("choices") != null) {   // how they look, as CC › Appearance… on a computer (#29)
            addItem("Appearance…", false) { appearance() }
            addLine()
        }
        if (!audio) {
            val off = list.none { it.selected }
            focus = addItem("Off", off) { choose(type, null) }.takeIf { off }
        }
        for (c in list) {
            val item = addItem(trackName(c.format), c.selected) { choose(type, c) }
            if (c.selected && focus == null) focus = item
        }
        level = 0
        pickingFrom = from
        tracks.visibility = View.VISIBLE
        handler.removeCallbacks(autoHide)
        (focus ?: tracksList.getChildAt(0))?.requestFocus()
    }

    private fun choose(type: Int, c: Choice?) {
        val p = player ?: return
        val b = p.trackSelectionParameters.buildUpon()
        if (c == null) b.setTrackTypeDisabled(type, true)
        else b.setTrackTypeDisabled(type, false).setOverrideForType(TrackSelectionOverride(c.group.mediaTrackGroup, c.index))
        p.trackSelectionParameters = b.build()
        closePicker()
    }

    /* ── CC › Appearance…: size, text colour, background and height, changed while it plays (#29) ── */

    private fun appearance(focusKey: String? = null) {
        val l = look ?: return
        val cur = l.optJSONObject("cur") ?: return
        val choices = l.optJSONObject("choices") ?: return
        level = 1
        tracksTitle.text = "Subtitle appearance"
        tracksList.removeAllViews()
        var focus: View? = null
        for ((key, name) in LOOK_ROWS) {
            val list = choices.optJSONArray(key) ?: continue
            val now = list.entries().firstOrNull { same(key, it.opt(0), cur.opt(key), list) }?.optString(1) ?: ""
            val item = addItem("$name:  $now  ›", false) { lookOption(key) }
            if (key == focusKey || focus == null) focus = item
        }
        focus?.requestFocus()
    }

    private fun lookOption(key: String) {
        val l = look ?: return
        val cur = l.optJSONObject("cur") ?: return
        val list = l.optJSONObject("choices")?.optJSONArray(key) ?: return
        level = 2
        lookKey = key
        tracksTitle.text = LOOK_ROWS.first { it.first == key }.second
        tracksList.removeAllViews()
        var focus: View? = null
        for (e in list.entries()) {
            val on = same(key, e.opt(0), cur.opt(key), list)
            val item = addItem(e.optString(1), on) { setLook(key, e); appearance(key) }
            if (on) focus = item
        }
        (focus ?: tracksList.getChildAt(0))?.requestFocus()
    }

    /** One choice made: the look the player draws is worked out again from what is chosen. */
    private fun setLook(key: String, choice: JSONArray) {
        val l = look ?: return
        val cur = l.optJSONObject("cur") ?: return
        cur.put(key, choice.opt(0))
        when (key) {
            "size" -> l.put("scale", choice.optDouble(2, 1.0))
            "color" -> l.put("color", choice.optString(0))
            "opacity" -> l.put("opacity", choice.optDouble(0, 60.0) / 100.0)
            "pos" -> l.put("raise", choice.optDouble(2, 0.08))
        }
        onLook(l)
    }

    /** Whether a choice is the one chosen; the background by the nearest step (Settings has a slider, this a list). */
    private fun same(key: String, v: Any?, cur: Any?, list: JSONArray): Boolean {
        if (key != "opacity") return v?.toString() == cur?.toString()
        val c = (cur as? Number)?.toDouble() ?: cur?.toString()?.toDoubleOrNull() ?: return false
        val nearest = list.entries().minByOrNull { kotlin.math.abs(it.optDouble(0) - c) } ?: return false
        return nearest.optDouble(0) == (v as? Number)?.toDouble()
    }

    private fun JSONArray.entries(): List<JSONArray> = (0 until length()).mapNotNull { optJSONArray(it) }

    /** A thin line between groups in the menu, as the desktop app's. */
    private fun addLine() {
        val line = View(tracksList.context).apply { setBackgroundColor(Color.parseColor("#2c3550")) }
        tracksList.addView(line, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(1)).apply { setMargins(dp(6), dp(5), dp(6), dp(5)) })
    }

    private fun closePicker() {
        if (!picking) return
        tracks.visibility = View.GONE
        tracksList.removeAllViews()
        pickingFrom?.takeIf { it.visibility == View.VISIBLE && visible }?.requestFocus()
        pickingFrom = null
        hideLater()
    }

    /** A line in the menu, marked as the desktop app's are: "✓  English" and "      Norwegian". */
    private fun addItem(text: String, selected: Boolean, onClick: () -> Unit): TextView {
        val item = TextView(tracksList.context).apply {
            this.text = (if (selected) "✓  " else "      ") + text
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(Color.parseColor("#e7eaf3"))
            setPadding(dp(14), 0, dp(20), 0)
            minHeight = dp(44)
            gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            isClickable = true
            background = StateListDrawable().apply {
                addState(intArrayOf(android.R.attr.state_focused), round(Color.parseColor("#283049"), 8f).apply { setStroke(dp(2), accent) })
                addState(intArrayOf(), round(Color.TRANSPARENT, 8f))
            }
            setOnClickListener { onClick() }
        }
        tracksList.addView(item, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return item
    }

    /** "English, 5.1 surround sound · Dolby TrueHD", "Norwegian · Forced". */
    private fun trackName(f: Format): String {
        val parts = mutableListOf(names.getTrackName(f))
        codecName(f.sampleMimeType)?.let { parts += it }
        if (f.selectionFlags and C.SELECTION_FLAG_FORCED != 0) parts += "Forced"
        return parts.joinToString(" · ")
    }

    /* ───────────────────────────────── looks ───────────────────────────────── */

    private val autoHide = Runnable { if (!picking && (live || player?.playWhenReady != false)) hide() else hideLater() }

    private fun hideLater() {
        handler.removeCallbacks(autoHide)
        handler.postDelayed(autoHide, HIDE_MS)
    }

    /** The desktop player's looks, with a focus a TV needs: the icon in the accent colour, a ring round play / pause. */
    private fun restyle() {
        // the sound, subtitle and skip buttons: no circle behind them; the icon (and the skip's "15") turns the
        // accent colour with the focus (owner's request)
        // (set by hand as the focus comes and goes: the views inside the skip buttons don't get the button's focused
        // state when it is asked for after the layout is built, so a colour list for "focused" never applied there)
        for (b in listOf(btnAudio, btnSubs, btnBack, btnFwd)) {
            b.background = null
            if (android.os.Build.VERSION.SDK_INT >= 26) b.defaultFocusHighlightEnabled = false
            tintIn(b, if (b.hasFocus()) accent else Color.WHITE)
            b.setOnFocusChangeListener { v, has -> tintIn(v, if (has) accent else Color.WHITE) }
        }
        // play / pause: white at rest, the accent colour with the focus (#34), as the desktop player
        btnPlay.background = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), oval(accent).apply { setStroke(dp(3), Color.WHITE) })
            addState(intArrayOf(), oval(Color.WHITE))
        }
        btnPlay.imageTintList = ColorStateList(
            arrayOf(intArrayOf(android.R.attr.state_focused), intArrayOf()),
            intArrayOf(INK, Color.parseColor("#0b0f19")),
        )
        // the bar: what has played and the dot in white; with the focus both in the accent colour, the dot larger (#35;
        // owner's request: the whole bar, handle included). Set as the focus comes and goes, like the buttons above.
        seek.thumb = StateListDrawable().apply {
            addState(intArrayOf(android.R.attr.state_focused), oval(accent).apply { setSize(dp(22), dp(22)) })
            addState(intArrayOf(), oval(Color.WHITE).apply { setSize(dp(22), dp(22)); setStroke(dp(5), Color.TRANSPARENT) })
        }
        val barColour = { has: Boolean -> seek.progressTintList = ColorStateList.valueOf(if (has) accent else Color.WHITE) }
        barColour(seek.hasFocus())
        seek.setOnFocusChangeListener { _, has -> barColour(has) }
        seek.background = null
    }

    private fun oval(color: Int) = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(color) }

    /** The icons and text in v (the button, or the views it is made of) in this colour. */
    private fun tintIn(v: View, color: Int) {
        when (v) {
            is android.widget.ImageView -> v.imageTintList = ColorStateList.valueOf(color)
            is TextView -> v.setTextColor(color)
            is ViewGroup -> for (i in 0 until v.childCount) tintIn(v.getChildAt(i), color)
        }
    }

    private fun round(color: Int, radiusDp: Float) = GradientDrawable().apply { setColor(color); cornerRadius = radiusDp * res.displayMetrics.density }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), res.displayMetrics).toInt()

    private fun clock(ms: Long): String = DateFormat.getTimeFormat(panel.context).format(Date(ms))

    companion object {
        private const val HIDE_MS = 5000L
        private const val LIVE_BEHIND_MS = 1500L
        private val LOOK_ROWS = listOf("size" to "Size", "color" to "Text colour", "opacity" to "Background", "pos" to "Height")   // from here on, and whenever paused, LIVE becomes GO LIVE
        private val DEFAULT_ACCENT = Color.parseColor("#ff7a59")
        private val INK = Color.parseColor("#06142b")   // --accent-ink: the play / pause sign on the accent

        fun parseColor(css: String): Int? = runCatching { Color.parseColor(css.trim()) }.getOrNull()

        /** 3725000 → "1:02:05", 65000 → "1:05". */
        fun hms(ms: Long): String {
            val s = (ms / 1000).coerceAtLeast(0)
            return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
        }

        fun codecName(mime: String?): String? = when (mime) {
            MimeTypes.AUDIO_AC3 -> "Dolby Digital"
            MimeTypes.AUDIO_E_AC3, MimeTypes.AUDIO_E_AC3_JOC -> "Dolby Digital Plus"
            MimeTypes.AUDIO_TRUEHD -> "Dolby TrueHD"
            MimeTypes.AUDIO_AC4 -> "Dolby AC-4"
            MimeTypes.AUDIO_DTS, MimeTypes.AUDIO_DTS_HD, MimeTypes.AUDIO_DTS_EXPRESS -> "DTS"
            MimeTypes.AUDIO_AAC -> "AAC"
            MimeTypes.AUDIO_MPEG, MimeTypes.AUDIO_MPEG_L2 -> "MPEG"
            MimeTypes.AUDIO_OPUS -> "Opus"
            MimeTypes.AUDIO_FLAC -> "FLAC"
            else -> null
        }
    }
}

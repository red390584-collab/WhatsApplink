package com.hybrid.webchat

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * Hybrid WhatsApp client.
 *
 * The single WebView loads the OFFICIAL https://web.whatsapp.com so the user can link
 * by QR code or by the phone-number pairing code. The WebView is a normal
 * (non-incognito) instance, so cookies + DOM storage + IndexedDB persist and the linked
 * session survives app restarts. Every cold start re-loads the official page (the engine
 * restores the session from its own storage) - restoring a saved navigation state was
 * what used to leave a black, empty screen after the process had been killed.
 *
 * After every page load we inject the WPPConnect (wa-js) bundle from assets and watch
 * for WhatsApp Web finishing initialization (the #pane-side chat pane appears and the
 * connection reports an authenticated session => the user is linked). At that point the
 * official UI is hidden with CSS ONLY - it is never removed from the DOM and the page is
 * never reloaded, so the WhatsApp engine keeps running - and the custom mobile UI is
 * injected on top, driven by the WPP bridge. If the engine ever logs out, the overlay is
 * removed and the official linking screen is loaded again.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "HybridWA"
        private const val HOME_URL = "https://web.whatsapp.com"
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"

        private val PAIRING_CODE_REGEX = Regex("^[A-Z0-9]{4}-[A-Z0-9]{4}$")

        /**
         * Linking monitor, evaluated inside the WhatsApp page.
         *
         * - hooks the wa-js loader + connection events (wa-js 4.x has no WPP.webpack)
         * - scans the page for the XXXX-XXXX phone-number pairing code and forwards it
         *   to the native banner (the official page is left completely untouched)
         * - polls for #pane-side / [data-testid=chat-list] together with the engine's
         *   authenticated state (rendered only once the user is actually linked) and
         *   then notifies Kotlin, which injects our custom UI
         * - self-heals: if the chat UI ever disappears from the DOM (e.g. an internal
         *   WhatsApp re-render) it asks Kotlin to mount it again
         * - reports a logout/unlink so Kotlin can fall back to the official QR screen
         *
         * Everything is guarded so a second onPageFinished cannot double-subscribe.
         */
        private const val MONITOR_JS = """
(function () {
  if (window.__wvmon) { return; }
  window.__wvmon = true;
  var bridge = window.Android;
  function log(m) { try { if (bridge) { bridge.log(String(m)); } } catch (e) {} }

  // Keep WhatsApp's IndexedDB (the linked session) from being evicted under
  // storage pressure - that is what silently logs the device out.
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      navigator.storage.persist();
    }
  } catch (e) {}

  var linked = false;
  var lastCode = '';
  var lastMountAt = 0;
  var lastUnlinkAt = 0;
  var paneMisses = 0;
  var wppHooked = false;

  function emitCode(code) {
    var c = String(code || '').toUpperCase();
    if (c === lastCode) { return; }
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(c)) { return; }
    lastCode = c;
    try { if (bridge) { bridge.onPairingCode(c); } } catch (e) { log('code bridge error ' + e); }
  }

  function scanForCode() {
    try {
      var txt = (document.body && document.body.innerText) ? document.body.innerText : '';
      var flat = txt.replace(/\s+/g, '');
      var m = flat.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
      if (m) { emitCode(m[0]); }
    } catch (e) { log('scan error ' + e); }
  }

  function mainPane() {
    try {
      return document.querySelector('#pane-side') ||
        document.querySelector('[data-testid="chat-list"]');
    } catch (e) { return null; }
  }

  function engineAuthenticated() {
    try {
      var w = window.WPP;
      if (w && w.conn && typeof w.conn.isAuthenticated === 'function') {
        return w.conn.isAuthenticated() !== false;
      }
    } catch (e) {}
    return true;
  }

  // The chat list container is the primary signal, but the engine itself is the
  // fallback: if WhatsApp ever renames its panes we still take over a linked session.
  function engineHasChats() {
    try {
      var w = window.WPP;
      var store = w && w.whatsapp;
      if (store && store.ChatStore && typeof store.ChatStore.getModelsArray === 'function') {
        return store.ChatStore.getModelsArray().length > 0;
      }
    } catch (e) {}
    return false;
  }

  function engineMainLoaded() {
    try {
      var w = window.WPP;
      if (w && w.conn && typeof w.conn.isMainLoaded === 'function') {
        return w.conn.isMainLoaded() === true;
      }
    } catch (e) {}
    return false;
  }

  function isLinked() {
    if (!engineAuthenticated()) { return false; }
    if (mainPane()) { return true; }
    return engineMainLoaded() && engineHasChats();
  }

  function ensureHideStyle() {
    if (document.getElementById('wv-style')) { return; }
    try {
      var st = document.createElement('style');
      st.id = 'wv-style';
      st.textContent = 'body > *:not(#wv-root) { display: none !important; }';
      document.head.appendChild(st);
    } catch (e) { log('hide style failed ' + e); }
  }

  function askMount() {
    try { if (bridge) { bridge.onWppReady(); } } catch (e) { log('mount bridge error ' + e); }
  }

  function askUnlink(reason) {
    var now = Date.now();
    if (now - lastUnlinkAt < 10000) { return; }
    lastUnlinkAt = now;
    linked = false;
    log('unlinked: ' + reason);
    try { if (bridge) { bridge.onUnlinked(); } } catch (e) { log('unlink bridge error ' + e); }
  }

  function check() {
    if (window.__wvHold) {
      // The official WhatsApp Web UI is in front on purpose (the user opened its
      // settings / profile). Never re-mount or re-hide it - only watch for a real
      // unlink so the app can fall back to the linking screen.
      if (linked) {
        paneMisses++;
        if (paneMisses >= 8 && !engineAuthenticated()) { askUnlink('session ended'); }
      }
      return;
    }
    if (isLinked()) {
      paneMisses = 0;
      if (!linked) {
        linked = true;
        log('linked: WhatsApp main pane is up');
      }
      if (document.getElementById('wv-root')) { ensureHideStyle(); return; }
      // Never spam the mount, but keep retrying: a page can finish loading before
      // the engine is able to render our overlay.
      var now = Date.now();
      if (now - lastMountAt < 2500) { return; }
      lastMountAt = now;
      askMount();
      return;
    }
    if (linked) {
      // WhatsApp re-renders its panes all the time, so only treat a long absence of the
      // chat pane together with an unauthenticated engine as a real unlink.
      paneMisses++;
      if (paneMisses >= 8 && !engineAuthenticated() && document.getElementById('wv-root')) {
        askUnlink('session ended');
      }
      return;
    }
    scanForCode();
  }

  // wa-js 4.x has no window.WPP.webpack: hook the loader and the connection events.
  function hookWpp() {
    if (wppHooked) { return; }
    var w = window.WPP;
    if (!w || typeof w.on !== 'function') { return; }
    wppHooked = true;
    try {
      w.on('conn.main_ready', function () { log('conn main_ready'); check(); });
      w.on('conn.authenticated', function () { check(); });
      w.on('conn.stream_mode_changed', function (mode) { if (mode === 'MAIN') { check(); } });
      w.on('conn.auth_code_change', function (code) { emitCode(String(code)); });
      w.on('conn.logout', function () { askUnlink('conn.logout'); });
    } catch (e) { log('wpp hook error ' + e); }
    try {
      if (w.loader && typeof w.loader.onReady === 'function') {
        w.loader.onReady(function () { log('wpp loader ready'); check(); }, 300);
      }
    } catch (e) {}
  }

  setInterval(function () { hookWpp(); check(); }, 1500);
  hookWpp();
  check();
})();
"""

        // Big assets are read once, not on every page load / on the UI thread.
        private var cachedWpp: String? = null
        private var cachedHtml: String? = null
        private var cachedCss: String? = null
        private var cachedUiJs: String? = null
    }

    private lateinit var webView: WebView
    private lateinit var codeBanner: TextView
    private lateinit var errorView: TextView
    private lateinit var backToApp: TextView
    private var lastPairingCode: String? = null

    /** "web" while the official UI is in front, "list"/"chat"/"pane" once our UI drives it. */
    private var uiState: String = "web"

    /** True while the official WhatsApp Web page is deliberately shown (Settings escape hatch). */
    private var officialMode = false

    /** Which of our panes was in front before the official page was opened. */
    private var uiStateBeforeOfficial: String = "list"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)
        codeBanner = findViewById(R.id.codeBanner)
        errorView = findViewById(R.id.errorView)
        backToApp = findViewById(R.id.btnBackToApp)

        // Return from the official WhatsApp Web UI to the custom chat UI.
        backToApp.setOnClickListener { backToCustomUi() }

        // CRITICAL: cookies keep the WhatsApp Web session alive across restarts.
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        // Tap the pairing-code card to put the code on the clipboard.
        codeBanner.setOnClickListener {
            val code = lastPairingCode ?: return@setOnClickListener
            copyToClipboard(code, getString(R.string.pairing_code_copied))
        }

        errorView.setOnClickListener {
            errorView.visibility = View.GONE
            webView.loadUrl(HOME_URL)
        }

        configureWebView()

        // Always load the official page. The linked session lives in the WebView's
        // cookie jar + IndexedDB and is restored by WhatsApp Web itself; restoring a
        // stale navigation state instead is what left a black, empty screen after the
        // app had been killed in the background.
        webView.loadUrl(HOME_URL)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configureWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            userAgentString = DESKTOP_UA
            javaScriptCanOpenWindowsAutomatically = true
            mediaPlaybackRequiresUserGesture = false
            useWideViewPort = true
            loadWithOverviewMode = true
            setSupportZoom(false)
        }
        webView.setBackgroundColor(0xFF0B141A.toInt())

        webView.addJavascriptInterface(Bridge(), "Android")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (url != null && url.startsWith("http")) {
                    uiState = "web"
                    officialMode = false
                    backToApp.visibility = View.GONE
                    errorView.visibility = View.GONE
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.i(TAG, "page finished: $url")
                if (url != null && url.contains("web.whatsapp.com")) {
                    // Persist the session cookies now, so an abrupt process kill cannot
                    // lose the link the user just approved.
                    CookieManager.getInstance().flush()
                    injectWppConnect(view)
                }
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: android.webkit.WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame != true) return
                Log.e(TAG, "main frame load error: ${error?.description}")
                if (!isFinishing && !isDestroyed) {
                    errorView.visibility = View.VISIBLE
                }
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val host = request?.url?.host ?: return false
                // Keep the session strictly inside WhatsApp properties.
                val allowed = host == "web.whatsapp.com" ||
                    host.endsWith(".whatsapp.com") ||
                    host.endsWith(".whatsapp.net")
                return !allowed
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(consoleMessage: ConsoleMessage?): Boolean {
                Log.d(TAG, "js: ${consoleMessage?.message()}")
                return true
            }
        }
    }

    // ---------------------------------------------------------------------
    // Injection
    // ---------------------------------------------------------------------

    /** Step 3: inject the WPPConnect bundle + the linking monitor. */
    private fun injectWppConnect(view: WebView?) {
        val target = view ?: return
        if (isFinishing || isDestroyed) return
        val source = cachedWpp ?: readAsset("wppconnect-wa.js").also { cachedWpp = it }
        if (source.isEmpty()) {
            Log.e(TAG, "wppconnect-wa.js asset missing")
            return
        }
        // The bundle assigns self.WPP; wrapping it keeps the page scope clean and the
        // window.__wvpkg guard makes repeated onPageFinished calls harmless.
        val pkgScript = "(function () {\n" +
            "  try {\n" +
            "    if (window.__wvpkg) { return; }\n" +
            "    window.__wvpkg = true;\n" +
            source +
            "\n  } catch (e) { if (window.Android) { try { Android.log('pkg: ' + e); } catch (x) {} } }" +
            "})();"
        target.evaluateJavascript(pkgScript) {
            if (!isFinishing && !isDestroyed) {
                target.evaluateJavascript(MONITOR_JS, null)
            }
        }
    }

    /**
     * Step 4: inject the custom UI into the LIVE page (never navigate/reload).
     *
     * Safe to call repeatedly: the JS side returns early when #wv-root already exists
     * (mount guard) or when custom-ui.js has already been evaluated (window.CustomUI).
     */
    private fun injectCustomUI() {
        if (isFinishing || isDestroyed) return
        uiState = "list"
        codeBanner.visibility = View.GONE

        val html = cachedHtml ?: readAsset("custom-ui.html").also { cachedHtml = it }
        val css = cachedCss ?: readAsset("custom-ui.css").also { cachedCss = it }
        val js = cachedUiJs ?: readAsset("custom-ui.js").also { cachedUiJs = it }
        if (html.isEmpty() || js.isEmpty()) {
            Log.e(TAG, "custom UI assets missing")
            return
        }

        // The hide rule is part of the injected stylesheet: the official UI is only
        // covered/hidden, its DOM (and therefore the WhatsApp engine) keeps running.
        val fullCss = "body > *:not(#wv-root) { display: none !important; }\n" + css

        // One single evaluate call so the overlay is created and styled atomically:
        // no flash of the official UI in between.
        val mountScript = "(function () {\n" +
            "  try {\n" +
            "    if (document.getElementById('wv-root')) { return; }\n" +
            "    var st = document.createElement('style');\n" +
            "    st.id = 'wv-style';\n" +
            "    st.textContent = " + JSONObject.quote(fullCss) + ";\n" +
            "    document.head.appendChild(st);\n" +
            "    var root = document.createElement('div');\n" +
            "    root.id = 'wv-root';\n" +
            "    root.innerHTML = " + JSONObject.quote(html) + ";\n" +
            "    try {\n" +
            "      var t = window.localStorage.getItem('wv.theme');\n" +
            "      var w = window.localStorage.getItem('wv.wall');\n" +
            "      var dark = (t === 'dark') || (!t && window.matchMedia && " +
            "window.matchMedia('(prefers-color-scheme: dark)').matches);\n" +
            "      root.setAttribute('data-theme', dark ? 'dark' : 'light');\n" +
            "      root.setAttribute('data-wall', w || 'default');\n" +
            "    } catch (e2) {}\n" +
            "    document.body.appendChild(root);\n" +
            "  } catch (e) { if (window.Android) { try { Android.log('mount: ' + e); } catch (x) {} } }" +
            "})();"

        val uiScript = "(function () {\n" +
            "  try {\n" +
            "    if (window.__wvcui) { return; }\n" +
            "    window.__wvcui = true;\n" +
            js +
            "\n  } catch (e) { if (window.Android) { try { Android.log('ui: ' + e); } catch (x) {} } }" +
            "})();"

        webView.evaluateJavascript(mountScript) {
            if (isFinishing || isDestroyed) return@evaluateJavascript
            webView.evaluateJavascript(uiScript) {
                if (isFinishing || isDestroyed) return@evaluateJavascript
                // If this DOM was rebuilt after the official UI was shown, the listeners
                // of the previous #wv-root died with it: let the still-alive CustomUI
                // re-bind itself to the fresh nodes (it is a no-op on a normal mount).
                webView.evaluateJavascript(
                    "(function () { try { if (window.CustomUI && CustomUI.remount) { CustomUI.remount(); } } catch (e) {} })();",
                    null
                )
            }
        }
    }

    /** Undo the overlay + hide rule so the official UI is visible/usable again. */
    private fun removeCustomUi() {
        if (isFinishing || isDestroyed) return
        try {
            webView.evaluateJavascript(
                "(function () { try {\n" +
                    "  var r = document.getElementById('wv-root');\n" +
                    "  if (r && r.parentNode) { r.parentNode.removeChild(r); }\n" +
                    "  var s = document.getElementById('wv-style');\n" +
                    "  if (s && s.parentNode) { s.parentNode.removeChild(s); }\n" +
                    "} catch (e) {} })();",
                null
            )
        } catch (e: Exception) {
            Log.e(TAG, "removeCustomUi failed", e)
        }
    }

    private fun readAsset(fileName: String): String = try {
        assets.open(fileName).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        Log.e(TAG, "readAsset($fileName) failed", e)
        ""
    }

    private fun copyToClipboard(text: String, toastText: String) {
        try {
            val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("WhatsApp Hybrid", text))
            Toast.makeText(this, toastText, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Log.e(TAG, "clipboard failed", e)
        }
    }

    // ---------------------------------------------------------------------
    // JS bridge
    // ---------------------------------------------------------------------

    inner class Bridge {

        /** Step 3 -> 4: linking is complete, take over the screen. */
        @JavascriptInterface
        fun onWppReady() {
            runOnUiThread { injectCustomUI() }
        }

        /**
         * The custom UI asked for the official WhatsApp Web page (its settings,
         * profile, privacy and status screens). The overlay is only hidden - never
         * removed - so the WhatsApp engine and our UI state both stay intact.
         */
        @JavascriptInterface
        fun openOfficialUi() {
            runOnUiThread { showOfficialUi() }
        }

        /**
         * The linked device was logged out / the session expired. Drop our overlay and
         * go back to the official linking screen instead of showing a dead chat list.
         */
        @JavascriptInterface
        fun onUnlinked() {
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                uiState = "web"
                officialMode = false
                backToApp.visibility = View.GONE
                lastPairingCode = null
                codeBanner.visibility = View.GONE
                removeCustomUi()
                webView.loadUrl(HOME_URL)
            }
        }

        /** Phone-number pairing code detected on the (untouched) official page. */
        @JavascriptInterface
        fun onPairingCode(code: String?) {
            val normalized = code?.trim()?.uppercase() ?: return
            if (!PAIRING_CODE_REGEX.matches(normalized)) return
            runOnUiThread {
                lastPairingCode = normalized
                if (codeBanner.visibility == View.VISIBLE &&
                    codeBanner.text.toString().contains(normalized)
                ) return@runOnUiThread
                Log.i(TAG, "pairing code: $normalized")
                codeBanner.text = getString(R.string.pairing_code_banner, normalized)
                codeBanner.visibility = View.VISIBLE
            }
        }

        /** Custom UI asks to copy a message / number to the clipboard. */
        @JavascriptInterface
        fun copyText(text: String?) {
            val value = text?.trim() ?: return
            if (value.isEmpty()) return
            runOnUiThread {
                copyToClipboard(value, getString(R.string.text_copied))
                if (isFinishing || isDestroyed) return@runOnUiThread
                // Acknowledge so the UI can close its action sheet with feedback.
                try {
                    webView.evaluateJavascript(
                        "(function(){ try { if (window.CustomUI && CustomUI.onCopied) { CustomUI.onCopied(); } } catch (e) {} })();",
                        null
                    )
                } catch (e: Exception) {
                    Log.e(TAG, "copy ack failed", e)
                }
            }
        }

        /** Copy the pairing code from inside the page (same as tapping the banner). */
        @JavascriptInterface
        fun copyPairingCode() {
            val code = lastPairingCode ?: return
            runOnUiThread { copyToClipboard(code, getString(R.string.pairing_code_copied)) }
        }

        /** The custom UI is stuck (engine unreachable): reload the whole WhatsApp page. */
        @JavascriptInterface
        fun reloadPage() {
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                uiState = "web"
                errorView.visibility = View.GONE
                webView.loadUrl(HOME_URL)
            }
        }

        /** Custom UI reports which pane is in front so hardware-back can be routed. */
        @JavascriptInterface
        fun onUiState(state: String?) {
            if (state == "list" || state == "chat" || state == "pane" || state == "web") {
                uiState = state
            }
        }

        @JavascriptInterface
        fun log(message: String?) {
            Log.i(TAG, "js: $message")
        }
    }

    // ---------------------------------------------------------------------
    // Lifecycle / back handling
    // ---------------------------------------------------------------------

    /**
     * Show the untouched official WhatsApp Web UI on top of our (still mounted, but
     * hidden) overlay so its settings, profile and status screens stay reachable.
     */
    private fun showOfficialUi() {
        if (isFinishing || isDestroyed) return
        if (!officialMode) {
            uiStateBeforeOfficial = if (uiState == "web") "list" else uiState
            officialMode = true
            uiState = "web"
            backToApp.visibility = View.VISIBLE
        }
        // One rule, one element: only #wv-root is hidden, everything else stays as it was.
        val script =                "(function () {\n" +
                "  try {\n" +
                "    var s = document.getElementById('wv-style');\n" +
                "    var r = document.getElementById('wv-root');\n" +
                "    if (!s || !r) { return false; }\n" +
                "    window.__wvHold = true;\n" +
                "    s.textContent = " +
                JSONObject.quote("#wv-root { display: none !important; }") + ";\n" +
                "    return true;\n" +
                "  } catch (e) { return false; }\n" +
                "})();"
        webView.evaluateJavascript(script) { result ->
            if (isFinishing || isDestroyed) return@evaluateJavascript
            if (result != "true") {
                // Style element gone (page re-rendered): load the official page normally.
                officialMode = false
                backToApp.visibility = View.GONE
                uiState = "web"
                webView.loadUrl(HOME_URL)
            }
        }
    }

    /** Put the custom chat UI back in front after the official page was used. */
    private fun backToCustomUi() {
        if (isFinishing || isDestroyed) return
        officialMode = false
        backToApp.visibility = View.GONE
        val probe =
            "(function () { try { window.__wvHold = false; } catch (e) {} " +
                "return !!(document.getElementById('wv-root') && document.getElementById('wv-style')); })();"
        webView.evaluateJavascript(probe) { result ->
            if (isFinishing || isDestroyed) return@evaluateJavascript
            if (result != "true") {
                injectCustomUI()
                return@evaluateJavascript
            }
            val css = cachedCss ?: readAsset("custom-ui.css").also { cachedCss = it }
            val fullCss = "body > *:not(#wv-root) { display: none !important; }\n" + css
            val restore =
                "(function () {\n" +
                    "  try {\n" +
                    "    var s = document.getElementById('wv-style');\n" +
                    "    if (s) { s.textContent = " + JSONObject.quote(fullCss) + "; }\n" +
                    "    if (window.CustomUI && CustomUI.resume) { CustomUI.resume(); }\n" +
                    "  } catch (e) {}\n" +
                    "})();"
            webView.evaluateJavascript(restore, null)
            uiState = when (uiStateBeforeOfficial) {
                "chat", "pane" -> uiStateBeforeOfficial
                else -> "list"
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (officialMode) {
                // The official page is in front: back returns to our chat UI.
                backToCustomUi()
                return true
            }
            when (uiState) {
                "chat", "pane" -> {
                    // Close a sheet / viewer / sub-pane / conversation inside our UI.
                    webView.evaluateJavascript(
                        "(function () { try { if (window.CustomUI && CustomUI.handleBack) { return CustomUI.handleBack() ? '1' : '0'; } } catch (e) {} return '0'; })();",
                        null
                    )
                    return true
                }
                "list" -> return super.onKeyDown(keyCode, event)
            }
            if (webView.canGoBack()) {
                webView.goBack()
                return true
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onPause() {
        super.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onStop() {
        super.onStop()
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        try {
            webView.destroy()
        } catch (e: Exception) {
            Log.e(TAG, "webView.destroy failed", e)
        }
        super.onDestroy()
    }
}

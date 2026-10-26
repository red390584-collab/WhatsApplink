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
 * session survives app restarts; saveState/restoreState keeps the navigation on top.
 *
 * After every page load we inject the WPPConnect (wa-js) bundle from assets and watch
 * for WhatsApp Web finishing initialization (the #pane-side chat pane appears => the
 * user is linked). At that point the official UI is hidden with CSS ONLY - it is never
 * removed from the DOM and the page is never reloaded, so the WhatsApp engine keeps
 * running - and the custom mobile UI is injected on top, driven by the WPP bridge.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "HybridWA"
        private const val HOME_URL = "https://web.whatsapp.com"
        private const val DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

        private val PAIRING_CODE_REGEX = Regex("^[A-Z0-9]{4}-[A-Z0-9]{4}$")

        /**
         * Linking monitor, evaluated inside the WhatsApp page.
         *
         * - waits for WPP.webpack.onReady to subscribe to connection events
         * - scans the page for the XXXX-XXXX phone-number pairing code and forwards it
         *   to the native banner (the official page is left completely untouched)
         * - polls for #pane-side (rendered only once the user is actually linked) and
         *   then notifies Kotlin, which hides the official UI and injects our custom UI
         * - self-heals: if the chat UI ever disappears from the DOM (e.g. an internal
         *   WhatsApp re-render) it asks Kotlin to mount it again
         *
         * Everything is guarded so a second onPageFinished cannot double-subscribe.
         */
        private const val MONITOR_JS = """
(function () {
  if (window.__wvmon) { return; }
  window.__wvmon = true;
  var bridge = window.Android;
  function log(m) { try { if (bridge) { bridge.log(String(m)); } } catch (e) {} }
  var wppReady = false;
  var linked = false;
  var lastCode = '';
  var mounts = 0;

  function emitCode(code) {
    if (!code || code === lastCode) { return; }
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) { return; }
    lastCode = code;
    try { if (bridge) { bridge.onPairingCode(code); } } catch (e) { log('code bridge error ' + e); }
  }

  function scanForCode() {
    try {
      var txt = (document.body && document.body.innerText) ? document.body.innerText : '';
      var flat = txt.replace(/\s+/g, '');
      var m = flat.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
      if (m) { emitCode(m[0].toUpperCase()); }
    } catch (e) { log('scan error ' + e); }
  }

  function askMount() {
    if (mounts >= 25) { return; }
    mounts++;
    try { if (bridge) { bridge.onWppReady(); } } catch (e) { log('bridge missing ' + e); }
  }

  function check() {
    var pane = null;
    try { pane = document.querySelector('#pane-side'); } catch (e) {}
    if (pane) {
      if (!linked) {
        linked = true;
        log('linked: WhatsApp main pane is up');
      }
      // Re-arm only when our overlay is really gone (never fights an existing mount).
      if (!document.getElementById('wv-root')) { askMount(); }
      return;
    }
    scanForCode();
  }

  function startWpp() {
    if (wppReady) { return; }
    if (!window.WPP || !window.WPP.webpack || typeof window.WPP.webpack.onReady !== 'function') { return; }
    try {
      WPP.webpack.onReady(function () {
        if (wppReady) { return; }
        wppReady = true;
        log('wpp loader ready');
        try {
          WPP.on('conn.stream_mode_changed', function (mode) {
            log('stream mode ' + mode);
            if (mode === 'MAIN') { check(); }
          });
        } catch (e) { log('stream subscription error ' + e); }
        try {
          WPP.on('conn.auth_code_change', function (code) { emitCode(String(code)); });
        } catch (e) {}
        check();
      }, 300);
    } catch (e) { log('startWpp error ' + e); }
  }

  setInterval(function () { startWpp(); check(); }, 1500);
  startWpp();
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
    private var lastPairingCode: String? = null

    /** "web" while the official UI is in front, "list"/"chat" once our UI drives it. */
    private var uiState: String = "web"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        webView = findViewById(R.id.webView)
        codeBanner = findViewById(R.id.codeBanner)

        // CRITICAL: cookies keep the WhatsApp Web session alive across restarts.
        val cookieManager = CookieManager.getInstance()
        cookieManager.setAcceptCookie(true)
        cookieManager.setAcceptThirdPartyCookies(webView, true)

        // Tap the pairing-code card to put the code on the clipboard.
        codeBanner.setOnClickListener {
            val code = lastPairingCode ?: return@setOnClickListener
            copyToClipboard(code, getString(R.string.pairing_code_copied))
        }

        configureWebView()

        val restored = savedInstanceState != null && webView.restoreState(savedInstanceState) != null
        if (!restored) {
            webView.loadUrl(HOME_URL)
        }
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
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                Log.i(TAG, "page finished: $url")
                if (url != null && url.contains("web.whatsapp.com")) {
                    injectWppConnect(view)
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

        webView.evaluateJavascript(mountScript, null)
        webView.evaluateJavascript(uiScript, null)
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

        /** Custom UI reports which pane is in front so hardware-back can be routed. */
        @JavascriptInterface
        fun onUiState(state: String?) {
            if (state == "list" || state == "chat") {
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

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            when (uiState) {
                "chat" -> {
                    // Close the conversation (or a sheet) inside our UI instead of leaving.
                    webView.evaluateJavascript(
                        "(function () { try { if (window.CustomUI && CustomUI.handleBack) { return CustomUI.handleBack() ? '1' : '0'; } if (window.CustomUI && CustomUI.closeChat) { return CustomUI.closeChat() ? '1' : '0'; } } catch (e) {} return '0'; })();",
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

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
        CookieManager.getInstance().flush()
    }

    override fun onPause() {
        super.onPause()
        webView.onPause()
        CookieManager.getInstance().flush()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
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

# WhatsApp Hybrid (Android, Kotlin + WebView)

A hybrid WhatsApp client:

1. A single Kotlin `WebView` loads the **official** [https://web.whatsapp.com](https://web.whatsapp.com)
   with a desktop Chrome user agent, so you can link by **QR code** or by
   **phone-number pairing code**.
2. The session stays alive in the WebView (cookies + DOM storage + IndexedDB of the
   normal, non-incognito WebView profile, plus `WebView.saveState`/`restoreState`), so
   requesting and entering a pairing code never logs you out.
3. After the page loads, the **WPPConnect `wa-js` bundle**
   (`@wppconnect/wa-js@4.3.0`, vendored in `app/src/main/assets/wppconnect-wa.js`) is
   injected into the live page and we wait for `WPP.webpack.onReady` /
   the WhatsApp main UI (`#pane-side`) to appear — that means linking is complete.
4. The official UI is then **hidden with CSS only** (the WhatsApp engine keeps running
   in the page — nothing is removed from the DOM and the page is never reloaded) and a
   **custom mobile chat UI** (`custom-ui.html` / `custom-ui.css` / `custom-ui.js`) is
   injected on top, driven by `WPP.chat.list()`, `WPP.chat.getMessages()`,
   `WPP.chat.sendTextMessage()`, `WPP.on('chat.new_message')` and
   `WPP.on('chat.unread_count_changed')`.

## Project layout

```
app/src/main/java/com/hybrid/webchat/MainActivity.kt   # WebView + persistence + injection
app/src/main/assets/wppconnect-wa.js                   # WPPConnect wa-js 4.3.0 (vendored UMD bundle)
app/src/main/assets/custom-ui.html                     # injected mobile chat UI markup
app/src/main/assets/custom-ui.css                      # injected WhatsApp-style theme
app/src/main/assets/custom-ui.js                       # WPP bridge + rendering + sending
.github/workflows/build-apk.yml                        # CI: builds app-debug APK artifact
```

## Build

CI builds on every push to `main`:

```bash
./gradlew assembleDebug --stacktrace --no-daemon
# APK: app/build/outputs/apk/debug/app-debug.apk  (artifact "app-debug" in Actions)
```

Requires JDK 17. No external Android dependencies are used.

## How linking works

- **QR code** — the official QR renders in the WebView; scan it with your phone.
- **Phone number** — when WhatsApp Web shows the *link with phone number* flow, a
  polling scanner picks the `XXXX-XXXX` pairing code out of the page and shows it in a
  native banner at the top of the screen, while the WebView session stays untouched.
- When the link completes, `#pane-side` (the chat pane) appears, the official UI is
  hidden and the custom UI takes over automatically.

## Disclaimer

Unofficial project. It drives your own linked WhatsApp Web session via the community
WPPConnect library; it is not affiliated with WhatsApp/Meta and may break when
WhatsApp Web changes.

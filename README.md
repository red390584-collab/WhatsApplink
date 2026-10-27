# WhatsApp Hybrid (Android, Kotlin + WebView)

A hybrid WhatsApp client:

1. A single Kotlin `WebView` loads the **official** [https://web.whatsapp.com](https://web.whatsapp.com)
   with a desktop Chrome user agent, so you can link by **QR code** or by
   **phone-number pairing code**.
2. The session stays alive in the WebView (cookies + DOM storage + IndexedDB of the
   normal, non-incognito WebView profile). Every cold start re-loads the official page
   so WhatsApp Web restores the linked session itself; the cookies are flushed on
   pause/stop and persistent storage is requested so the session's IndexedDB is not
   evicted. Requesting and entering a pairing code therefore never logs you out.
3. After the page loads, the **WPPConnect `wa-js` bundle**
   (`@wppconnect/wa-js@4.7.2`, vendored in `app/src/main/assets/wppconnect-wa.js`) is
   injected into the live page. wa-js 4.x has no `WPP.webpack`: the loader (`WPP.loader`),
   the connection events (`conn.main_ready`, `conn.authenticated`, `conn.logout`) and the
   WhatsApp main UI (`#pane-side`) are used to detect that linking is complete.
4. The official UI is then **hidden with CSS only** (the WhatsApp engine keeps running
   in the page — nothing is removed from the DOM and the page is never reloaded) and a
   **custom mobile chat UI** (`custom-ui.html` / `custom-ui.css` / `custom-ui.js`) is
   injected on top, driven by `WPP.chat.list()`, `WPP.chat.getMessages()`,
   `WPP.chat.sendTextMessage()`, `WPP.on('chat.new_message')`,
   `WPP.on('chat.msg_ack_change')` and `WPP.on('chat.unread_count_changed')`.
5. The overlay can be **handed back to the official page** at any time (menu → *Open
   WhatsApp Web*) so the real WhatsApp settings, profile, privacy and linked-device
   screens stay reachable; a native *Back to chats* button returns to the custom UI.
   The engine keeps running underneath, so no session is lost in either direction.

### What the custom UI does

- **Themes** — Light / Dark / **System** plus a chat wallpaper choice (Default, Bright,
  Dim, Monochrome), stored in `localStorage` and applied to `#wv-root[data-theme]`
  before first paint so a dark-mode device never flashes white.
- **Conversation** — outgoing bubbles on the right, incoming on the left (bubbles
  shrink-wrap their content), day separators, group sender names, delivery ticks with
  live `msg_ack_change` updates and unread badges.
- **Swipe to reply** — dragging a bubble right (or *Reply* in the long-press sheet) puts
  a quoted preview over the composer; the message is sent with
  `WPP.chat.sendTextMessage(id, text, { quotedMsg: key })` and falls back to a plain
  send if the engine refuses the quote. Quoted blocks inside bubbles are hydrated with
  `WPP.chat.getQuotedMsg()`.
- **Status** — a Status row on the chat list plus a Status pane and a full-screen
  viewer (segmented progress bars, tap left/right to navigate, auto-advance) built from
  `WPP.whatsapp.StatusV3Store` with a `status@broadcast` fallback; media is fetched with
  `WPP.chat.downloadMedia()` and read receipts are sent with `WPP.status.sendReadStatus()`.
- **Settings** — theme/wallpaper pickers, my profile (name, number, about, picture via
  `WPP.profile`) and the *WhatsApp Web settings* escape hatch.
- **Contact / group info** — opened from the chat header: phone number, about text from
  `WPP.contact.getStatus()` and the participant list from `WPP.group.getParticipants()`.
- **No twin bubbles** — a sent message shows exactly once: the optimistic bubble is
  *adopted* by the engine's own echo, whether that echo arrives before the send promise
  resolves, under a different id form (`@c.us` vs `@lid`), or re-keyed by the server.

Conversations are read from every source the engine offers — `WPP.chat.getMessages()`
(anchored, then unanchored, on both the `@c.us` and `@lid` id of the chat) and the live
stores (`ChatStore`/`MsgStore`) — merged and de-duplicated. If a thread still comes back
empty the hidden official UI is asked to open that chat so WhatsApp hydrates it. Sends go
through `WPP.chat.sendTextMessage()` and are retried against the `@c.us`/`@lid`
counterpart and `WPP.chat.find()` before a bubble is ever marked "Not sent" (with the
engine's own error text), so a failed send can no longer look successful.

## Staying alive while you link

The whole app is one long-lived WebView, which Android is happy to kill within seconds
of the user switching away - and the first thing you do when linking by phone number is
switch to WhatsApp to type the code. So `KeepAliveService` runs as a silent foreground
service (`dataSync` type, `START_STICKY`) from the moment the app opens, lifting the
process to a perceptible priority so the page, its pairing code and the linked session
all survive the trip to WhatsApp and back. The pairing code is additionally persisted to
`SharedPreferences` and restored on `onCreate`, so even a genuine process reclaim comes
back to the code banner instead of a blank screen; coming back to the app never reloads
the page, it only forces an immediate link check (`window.__wvmonCheck`) so a pairing
that completed in the background is picked up instantly.

## Project layout

```
app/src/main/java/com/hybrid/webchat/MainActivity.kt   # WebView + persistence + injection
app/src/main/java/com/hybrid/webchat/KeepAliveService.kt # foreground keep-alive service
app/src/main/assets/wppconnect-wa.js                   # WPPConnect wa-js 4.7.2 (vendored UMD bundle)
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
- If the phone unlinks this device (`conn.logout`, or the chat pane disappears while the
  engine reports an unauthenticated session), the overlay is removed and the official
  linking screen is shown again instead of a dead chat list.

## Disclaimer

Unofficial project. It drives your own linked WhatsApp Web session via the community
WPPConnect library; it is not affiliated with WhatsApp/Meta and may break when
WhatsApp Web changes.

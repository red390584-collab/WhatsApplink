/**
 * custom-ui.js — the logic of the injected mobile chat UI.
 *
 * Runs inside the LIVE web.whatsapp.com page (the official UI is merely hidden, the
 * WhatsApp engine keeps running) and talks to the engine through the WPPConnect
 * (wa-js 4.3.0) bridge:
 *
 *   WPP.chat.list()                              -> populate the chat list
 *   WPP.chat.getMessages(chatId, {count: 40})    -> render a conversation
 *   WPP.chat.sendTextMessage(chatId, text)       -> send from the composer
 *   WPP.chat.markIsRead(chatId)                  -> clear unread state
 *   WPP.on('chat.new_message', ...)              -> live incoming/outgoing messages
 *   WPP.on('chat.unread_count_changed', ...)     -> live unread badges
 *
 * MainActivity wraps this file in a try/catch before evaluating it.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // tiny helpers
  // ---------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function log(m) {
    try { if (window.Android && Android.log) { Android.log(String(m)); } } catch (e) {}
  }

  function toast(msg, ms) {
    var el = $('wa-toast');
    if (!el) { return; }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, ms || 2600);
  }

  function idStr(x) {
    if (!x) { return ''; }
    if (typeof x === 'string') { return x; }
    if (x._serialized) { return x._serialized; }
    return String(x);
  }

  function userOf(jid) {
    return String(jid || '').split('@')[0].split(':')[0].replace(/^\+/, '');
  }

  function wpp() { return window.WPP || null; }

  function chatApi() {
    var w = wpp();
    return (w && w.chat) ? w.chat : null;
  }

  // ---------------------------------------------------------------------
  // state
  // ---------------------------------------------------------------------

  var chats = [];
  var chatById = Object.create(null);
  var openChatId = null;
  var filterText = '';
  var subscribed = false;
  var seenMsgKeys = Object.create(null);
  var loadAttempts = 0;
  var softRefreshTimer = null;

  var AVATAR_COLORS = [
    '#00a884', '#1f8f74', '#2563a6', '#6b4fa8',
    '#b4573f', '#8a6d1f', '#3f6f8f', '#a8427a'
  ];

  function avatarColor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) {
      h = (h * 31 + id.charCodeAt(i)) >>> 0;
    }
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initialOf(name) {
    var s = String(name || '?').replace(/[^0-9A-Za-z\u00C0-\uFFFF]+/g, ' ').trim();
    return (s ? s.charAt(0) : '?').toUpperCase();
  }

  // ---------------------------------------------------------------------
  // formatting
  // ---------------------------------------------------------------------

  function toDate(ts) {
    if (!ts) { return null; }
    return (ts < 1e12) ? new Date(ts * 1000) : new Date(ts);
  }

  function pad(n) { return ('0' + n).slice(-2); }

  function fmtTime(ts) {
    var d = toDate(ts);
    if (!d || isNaN(d.getTime())) { return ''; }
    var now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    if (d.getFullYear() === now.getFullYear()) {
      return pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    }
    return String(d.getFullYear()).slice(-2) + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
  }

  function dayLabel(ts) {
    var d = toDate(ts);
    if (!d || isNaN(d.getTime())) { return ''; }
    var now = new Date();
    var yesterday = new Date(now.getTime() - 86400000);
    if (d.toDateString() === now.toDateString()) { return 'TODAY'; }
    if (d.toDateString() === yesterday.toDateString()) { return 'YESTERDAY'; }
    try {
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric'
      }).toUpperCase();
    } catch (e) {
      return pad(d.getMonth() + 1) + '/' + pad(d.getDate());
    }
  }

  /** Human text for a message (or chat preview), including media labels. */
  function msgText(m) {
    var body = (m && m.body) || '';
    switch (m && m.type) {
      case 'image': return body || '📷 Photo';
      case 'video': return body || '📹 Video';
      case 'audio':
      case 'ptt': return body || '🎤 Voice message';
      case 'sticker': return body || 'Sticker';
      case 'location':
      case 'live_location': return body || '📍 Location';
      case 'vcard':
      case 'multi_vcard': return body || '👤 Contact card';
      case 'document': return body || ('📎 ' + ((m && m.filename) || 'Document'));
      case 'revoke': return '❌ This message was deleted';
      case 'call_log': return body || '📞 Call';
      case 'template': return body || 'Template message';
      default: return body;
    }
  }

  function previewOf(m) { return m ? msgText(m) : ''; }

  // ---------------------------------------------------------------------
  // normalization
  // ---------------------------------------------------------------------

  function normalizeChat(c) {
    var id = idStr(c.id);
    var lm = c.lastMessage || null;
    return {
      id: id,
      user: userOf(id),
      name: c.name || c.formattedTitle ||
        (c.contact && (c.contact.pushname || c.contact.name || c.contact.formattedName)) ||
        userOf(id) || 'Unknown',
      isGroup: !!c.isGroup || /@g\.us$/.test(id),
      unread: c.unreadCount || 0,
      pinned: !!c.pinned,
      ts: c.t || (lm && (lm.t || lm.timestamp)) || 0,
      preview: previewOf(lm),
      obj: c
    };
  }

  function normalizeMsg(m) {
    m = m || {};
    var id = m.id || {};
    var key = id._serialized ||
      ((id.remote ? idStr(id.remote) : '') + '|' + (id.id || '')) ||
      ('k-' + (m.t || 0) + '-' + String(m.body || '').length + '-' + String(m.body || '').slice(0, 16));
    return {
      key: key,
      fromMe: !!m.fromMe,
      body: m.body || '',
      text: msgText(m),
      ts: m.t || m.timestamp || Math.floor(Date.now() / 1000),
      type: m.type || 'chat',
      sender: m.author || m.from || m.to || ''
    };
  }

  function byPinnedThenTs(a, b) {
    var pa = a.pinned ? 1 : 0;
    var pb = b.pinned ? 1 : 0;
    if (pa !== pb) { return pb - pa; }
    return (b.ts || 0) - (a.ts || 0);
  }

  // ---------------------------------------------------------------------
  // chat list rendering
  // ---------------------------------------------------------------------

  function renderList() {
    var listEl = $('chat-list');
    if (!listEl) { return; }
    var q = filterText.toLowerCase().trim();
    var items = chats.filter(function (c) {
      if (!q) { return true; }
      return (c.name || '').toLowerCase().indexOf(q) >= 0 ||
        (c.preview || '').toLowerCase().indexOf(q) >= 0 ||
        (c.user || '').indexOf(q) >= 0;
    });
    listEl.textContent = '';
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'wa-empty';
      empty.textContent = chats.length ? 'No chats found' : 'No chats yet';
      listEl.appendChild(empty);
      return;
    }
    var frag = document.createDocumentFragment();
    items.forEach(function (c) { frag.appendChild(buildRow(c)); });
    listEl.appendChild(frag);
  }

  function buildRow(c) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'wa-row' + (c.unread ? ' wa-row-unread' : '');

    var av = document.createElement('span');
    av.className = 'wa-avatar';
    av.style.backgroundColor = avatarColor(c.id);
    av.textContent = initialOf(c.name);
    row.appendChild(av);

    var mid = document.createElement('span');
    mid.className = 'wa-row-mid';
    var name = document.createElement('span');
    name.className = 'wa-row-name';
    name.textContent = c.name + (c.isGroup ? ' 👥' : '');
    var prev = document.createElement('span');
    prev.className = 'wa-row-prev';
    prev.textContent = c.preview || '';
    mid.appendChild(name);
    mid.appendChild(prev);
    row.appendChild(mid);

    var right = document.createElement('span');
    right.className = 'wa-row-right';
    var time = document.createElement('span');
    time.className = 'wa-row-time';
    time.textContent = fmtTime(c.ts);
    right.appendChild(time);
    if (c.unread) {
      var badge = document.createElement('span');
      badge.className = 'wa-badge';
      badge.textContent = c.unread > 99 ? '99+' : String(c.unread);
      right.appendChild(badge);
    }
    row.appendChild(right);

    row.addEventListener('click', function () { openChat(c.id); });
    return row;
  }

  // ---------------------------------------------------------------------
  // loading chats
  // ---------------------------------------------------------------------

  function loadChats() {
    var api = chatApi();
    if (!api || typeof api.list !== 'function') {
      scheduleRetry();
      return Promise.resolve([]);
    }
    var p;
    try {
      p = api.list();
    } catch (e) {
      log('WPP.chat.list threw: ' + e);
      scheduleRetry();
      return Promise.resolve([]);
    }
    return Promise.resolve(p).then(function (raw) {
      loadAttempts = 0;
      var next = (raw || []).map(normalizeChat).filter(function (c) { return !!c.id; });
      next.sort(byPinnedThenTs);
      chats = next;
      chatById = Object.create(null);
      chats.forEach(function (c) { chatById[c.id] = c; });
      renderList();
      return chats;
    }).catch(function (e) {
      log('loadChats error: ' + e);
      scheduleRetry();
      return [];
    });
  }

  function scheduleRetry() {
    loadAttempts++;
    if (loadAttempts <= 40) {
      setTimeout(loadChats, 1500);
    } else {
      toast('Could not reach the WhatsApp engine. Tap ↻ to retry.', 4000);
    }
  }

  function scheduleSoftRefresh() {
    clearTimeout(softRefreshTimer);
    softRefreshTimer = setTimeout(loadChats, 1200);
  }

  // ---------------------------------------------------------------------
  // conversation
  // ---------------------------------------------------------------------

  function openChat(id) {
    var c = chatById[id];
    if (!c) {
      toast('Chat not found');
      return;
    }
    openChatId = id;
    seenMsgKeys = Object.create(null);

    $('chat-pane').hidden = false;
    $('list-pane').hidden = true;
    $('btn-back').hidden = false;
    $('btn-refresh').hidden = true;
    $('header-title').textContent = c.name;
    var sub = $('header-subtitle');
    if (c.isGroup) {
      sub.textContent = 'Group';
      sub.hidden = false;
    } else if (c.user) {
      sub.textContent = '+' + c.user;
      sub.hidden = false;
    } else {
      sub.hidden = true;
    }
    setUiState('chat');

    var msgsEl = $('messages');
    msgsEl.textContent = '';
    msgsEl.removeAttribute('data-day');
    var loading = document.createElement('div');
    loading.className = 'wa-empty';
    loading.textContent = 'Loading messages…';
    msgsEl.appendChild(loading);

    var input = $('msg-input');
    if (input) { input.value = ''; }

    markRead(id);
    loadMessages(id);
    renderList();
  }

  function closeChat() {
    if (!openChatId) { return false; }
    openChatId = null;
    $('chat-pane').hidden = true;
    $('list-pane').hidden = false;
    $('btn-back').hidden = true;
    $('btn-refresh').hidden = false;
    $('header-title').textContent = 'WhatsApp';
    $('header-subtitle').hidden = true;
    setUiState('list');
    renderList();
    return true;
  }

  function markRead(id) {
    var api = chatApi();
    try {
      if (api && typeof api.markIsRead === 'function') {
        Promise.resolve(api.markIsRead(id)).catch(function () {});
      }
    } catch (e) {}
    var c = chatById[id];
    if (c && c.unread) {
      c.unread = 0;
    }
  }

  function loadMessages(id) {
    var api = chatApi();
    var msgsEl = $('messages');
    if (!api || typeof api.getMessages !== 'function') {
      msgsEl.textContent = '';
      toast('Messaging API unavailable');
      return;
    }
    var p;
    try {
      p = api.getMessages(id, { count: 40 });
    } catch (e) {
      log('WPP.chat.getMessages threw: ' + e);
      return;
    }
    Promise.resolve(p).then(function (raw) {
      if (openChatId !== id) { return; }
      seenMsgKeys = Object.create(null);
      msgsEl.textContent = '';
      msgsEl.removeAttribute('data-day');
      var msgs = (raw || []).map(normalizeMsg).filter(function (m) { return !!m.body || !!m.text; });
      msgs.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      msgs.forEach(function (m) { appendBubble(m, false); });
      scrollToEnd();
    }).catch(function (e) {
      log('getMessages error: ' + e);
      if (openChatId !== id) { return; }
      msgsEl.textContent = '';
      var err = document.createElement('div');
      err.className = 'wa-empty';
      err.textContent = 'Could not load messages';
      msgsEl.appendChild(err);
    });
  }

  function appendBubble(m, isTmp) {
    var msgsEl = $('messages');
    if (!msgsEl) { return; }
    if (!isTmp) {
      if (seenMsgKeys[m.key]) { return; }
      seenMsgKeys[m.key] = true;
    }
    var placeholder = msgsEl.querySelector('.wa-empty');
    if (placeholder) { placeholder.parentNode.removeChild(placeholder); }

    var day = dayLabel(m.ts);
    if (day && msgsEl.getAttribute('data-day') !== day) {
      msgsEl.setAttribute('data-day', day);
      var sep = document.createElement('div');
      sep.className = 'wa-day-sep';
      var sepText = document.createElement('span');
      sepText.textContent = day;
      sep.appendChild(sepText);
      msgsEl.appendChild(sep);
    }

    var wrap = document.createElement('div');
    wrap.className = 'wa-bubble ' + (m.fromMe ? 'wa-out' : 'wa-in') + (m.failed ? ' wa-failed' : '');
    if (m.type && m.type !== 'chat' && m.type !== 'text') {
      wrap.className += ' wa-media';
    }

    var open = chatById[openChatId];
    if (!m.fromMe && open && open.isGroup && m.sender) {
      var lbl = document.createElement('div');
      lbl.className = 'wa-sender';
      lbl.textContent = '+' + userOf(m.sender);
      wrap.appendChild(lbl);
    }

    var body = document.createElement('div');
    body.className = 'wa-bubble-text';
    body.textContent = m.text || m.body || '';
    wrap.appendChild(body);

    var meta = document.createElement('div');
    meta.className = 'wa-bubble-meta';
    var t = document.createElement('span');
    t.className = 'wa-bubble-time';
    t.textContent = fmtTime(m.ts) + (m.fromMe ? (m.failed ? ' ⚠' : ' ✓✓') : '');
    meta.appendChild(t);
    wrap.appendChild(meta);

    if (isTmp) { wrap.setAttribute('data-tmp', '1'); }
    msgsEl.appendChild(wrap);
  }

  function scrollToEnd() {
    var msgsEl = $('messages');
    if (msgsEl) { msgsEl.scrollTop = msgsEl.scrollHeight; }
  }

  // ---------------------------------------------------------------------
  // sending
  // ---------------------------------------------------------------------

  function sendMessage() {
    var input = $('msg-input');
    if (!input || !openChatId) { return; }
    var text = (input.value || '').trim();
    if (!text) { return; }
    var api = chatApi();
    if (!api || typeof api.sendTextMessage !== 'function') {
      toast('Engine not ready yet');
      return;
    }
    input.value = '';
    var now = Math.floor(Date.now() / 1000);
    var tmp = {
      key: 'tmp-' + now + '-' + text.length,
      fromMe: true,
      body: text,
      text: text,
      ts: now,
      type: 'chat',
      sender: '',
      failed: false
    };
    appendBubble(tmp, true);
    scrollToEnd();

    var p;
    try {
      p = api.sendTextMessage(openChatId, text);
    } catch (e) {
      log('sendTextMessage threw: ' + e);
      markLastBubbleFailed();
      input.value = text;
      return;
    }
    Promise.resolve(p).then(function () {
      var c = chatById[openChatId];
      if (c) {
        c.preview = text;
        c.ts = Math.floor(Date.now() / 1000);
      }
      loadChats();
    }).catch(function (e) {
      log('sendTextMessage error: ' + e);
      toast('Message not sent');
      markLastBubbleFailed();
      input.value = text;
    });
  }

  function markLastBubbleFailed() {
    var msgsEl = $('messages');
    var last = msgsEl ? msgsEl.lastElementChild : null;
    if (last && last.classList && last.classList.contains('wa-bubble')) {
      last.classList.add('wa-failed');
    }
  }

  // ---------------------------------------------------------------------
  // live events
  // ---------------------------------------------------------------------

  function resolveChatId(msg) {
    var cands = [];
    function add(x) {
      var s = idStr(x);
      if (s && cands.indexOf(s) < 0) { cands.push(s); }
    }
    add(msg.chatId);
    if (msg.chat && msg.chat.id) { add(msg.chat.id); }
    if (msg.id && msg.id.remote) { add(msg.id.remote); }
    add(msg.fromMe ? msg.to : msg.from);
    add(msg.from);
    add(msg.to);

    var i;
    for (i = 0; i < cands.length; i++) {
      if (chatById[cands[i]]) { return cands[i]; }
    }
    // Fallback: match on the bare user part (handles +/- and JID formatting quirks).
    var users = Object.create(null);
    for (i = 0; i < cands.length; i++) {
      var u = userOf(cands[i]);
      if (u) { users[u] = true; }
    }
    var keys = Object.keys(chatById);
    for (i = 0; i < keys.length; i++) {
      var c = chatById[keys[i]];
      if (c.user && users[c.user]) { return c.id; }
    }
    return null;
  }

  function onNewMessage(msg) {
    try {
      var m = normalizeMsg(msg);
      var cid = resolveChatId(msg);
      var c = cid ? chatById[cid] : null;
      if (!c) {
        // New/unknown chat (or LID mapping): refresh the whole list.
        scheduleSoftRefresh();
        return;
      }
      c.preview = previewOf(msg) || c.preview;
      c.ts = m.ts || c.ts;
      if (!m.fromMe && cid !== openChatId) {
        c.unread = (c.unread || 0) + 1;
      }
      chats.sort(byPinnedThenTs);
      if (cid === openChatId) {
        appendBubble(m, false);
        scrollToEnd();
        if (!m.fromMe) { markRead(cid); }
      }
      renderList();
    } catch (e) {
      log('onNewMessage error: ' + e);
    }
  }

  function subscribe() {
    if (subscribed) { return; }
    var w = wpp();
    if (!w || typeof w.on !== 'function') { return; }
    subscribed = true;
    w.on('chat.new_message', function (msg) { onNewMessage(msg); });
    try {
      w.on('chat.unread_count_changed', function (e) {
        try {
          var id = idStr(e && e.chat && e.chat.id);
          var c = chatById[id];
          if (c && typeof e.unreadCount === 'number' && e.unreadCount !== c.unread) {
            c.unread = e.unreadCount;
            renderList();
          }
        } catch (err) {}
      });
    } catch (e) {}
    log('custom UI subscribed to WPP events');
  }

  // ---------------------------------------------------------------------
  // chrome <-> bridge
  // ---------------------------------------------------------------------

  function setUiState(state) {
    try {
      if (window.Android && Android.onUiState) { Android.onUiState(state); }
    } catch (e) {}
  }

  function bindUi() {
    $('btn-back').addEventListener('click', closeChat);
    $('btn-refresh').addEventListener('click', function () {
      toast('Refreshing…', 900);
      loadChats();
    });
    $('btn-send').addEventListener('click', sendMessage);
    $('msg-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
      }
    });
    $('search-input').addEventListener('input', function (e) {
      filterText = (e.target && e.target.value) || '';
      renderList();
    });

    // Keep the fixed overlay in sync with the on-screen keyboard.
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var adjust = function () {
        var root = document.getElementById('wv-root');
        if (!root) { return; }
        root.style.top = vv.offsetTop + 'px';
        root.style.height = vv.height + 'px';
      };
      vv.addEventListener('resize', adjust);
      vv.addEventListener('scroll', adjust);
      adjust();
    }
  }

  // ---------------------------------------------------------------------
  // boot
  // ---------------------------------------------------------------------

  function init() {
    if (!$('chat-list') || !$('msg-input')) {
      setTimeout(init, 120);
      return;
    }
    bindUi();
    (function tryLoad() {
      loadAttempts++;
      var api = chatApi();
      if (!api || typeof api.list !== 'function') {
        if (loadAttempts <= 60) {
          setTimeout(tryLoad, 1200);
        } else {
          toast('Could not reach the WhatsApp engine. Tap ↻ to retry.', 4000);
          renderList();
        }
        return;
      }
      subscribe();
      loadChats();
    })();
  }

  // Public handles usable from Kotlin via evaluateJavascript.
  window.CustomUI = {
    refresh: function () { return loadChats(); },
    closeChat: function () { return closeChat(); },
    openChat: function (id) { openChat(String(id || '')); },
    isOpen: function () { return !!openChatId; }
  };

  setUiState('list');
  init();
  log('custom UI booted');
})();

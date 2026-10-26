/**
 * custom-ui.js — the logic of the injected mobile chat UI.
 *
 * Runs inside the LIVE web.whatsapp.com page (the official UI is merely hidden, the
 * WhatsApp engine keeps running) and talks to the engine through the WPPConnect
 * (wa-js 4.3.0) bridge:
 *
 *   WPP.chat.list()                                    -> populate the chat list
 *   WPP.chat.getMessages(chatId, {count: 40})          -> render a conversation
 *   WPP.chat.sendTextMessage(chatId, text)             -> send from the composer
 *   WPP.chat.markIsRead(chatId)                        -> clear unread state
 *   WPP.contact.list()                                 -> "new chat" picker
 *   WPP.contact.getProfilePictureUrl(chatId, false)    -> avatars
 *   WPP.on('chat.new_message', ...)                    -> live incoming/outgoing
 *   WPP.on('chat.unread_count_changed', ...)           -> live unread badges
 *
 * MainActivity wraps this file in a try/catch before evaluating it, and evaluates it at
 * most once per document.
 */
(function () {
  'use strict';

  if (window.CustomUI) { return; }

  // ---------------------------------------------------------------------
  // helpers
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
    toast._t = setTimeout(function () { el.hidden = true; }, ms || 2400);
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

  function isGroupId(id) { return /@g\.us$/.test(String(id || '')); }

  function wpp() { return window.WPP || null; }

  /** Full page reload: the only way out when the engine itself is wedged. */
  function reloadPage() {
    try {
      if (window.Android && Android.reloadPage) { Android.reloadPage(); return true; }
    } catch (e) {}
    try { window.location.reload(); return true; } catch (e) {}
    return false;
  }

  function chatApi() {
    var w = wpp();
    return (w && w.chat) ? w.chat : null;
  }

  function contactApi() {
    var w = wpp();
    return (w && w.contact) ? w.contact : null;
  }

  function waStore() {
    var w = wpp();
    return (w && w.whatsapp) ? w.whatsapp : null;
  }

  /** The live engine chat model (ChatStore), independent of the WPP wrapper. */
  function chatModelOf(id) {
    if (!id) { return null; }
    var w = wpp();
    if (!w) { return null; }
    try {
      if (w.chat && typeof w.chat.get === 'function') {
        var c = w.chat.get(id);
        if (c) { return c; }
      }
    } catch (e) {}
    try {
      var store = waStore();
      if (store && store.ChatStore && typeof store.ChatStore.get === 'function') {
        var c2 = store.ChatStore.get(id);
        if (c2) { return c2; }
      }
    } catch (e) {}
    return null;
  }

  /**
   * 1:1 chats are addressed either by phone number (@c.us) or by the newer linked
   * id (@lid). The list and the message/send APIs disagree on which one they use,
   * so every engine call is given all known variants of the same chat.
   */
  function chatIds(id) {
    var ids = [];
    function add(x) {
      var s = idStr(x);
      if (s && ids.indexOf(s) < 0) { ids.push(s); }
    }
    add(id);
    var model = chatModelOf(id);
    if (model) {
      add(model.id);
      try { if (model.contact && model.contact.id) { add(model.contact.id); } } catch (e) {}
    }
    return ids;
  }

  // Same as chatIds() plus the @lid <-> @c.us counterpart, which may need a server
  // round-trip: only used as a fallback so opening a chat stays instant.
  function chatIdsWithLid(id) {
    var ids = chatIds(id);
    var api = contactApi();
    if (!api || typeof api.getPnLidEntry !== 'function') { return Promise.resolve(ids); }
    return Promise.resolve()
      .then(function () { return api.getPnLidEntry(id); })
      .then(function (entry) {
        [entry && entry.phoneNumber, entry && entry.lid].forEach(function (x) {
          var s = idStr(x);
          if (s && ids.indexOf(s) < 0) { ids.push(s); }
        });
        return ids;
      })
      .catch(function () { return ids; });
  }

  function withTimeout(make, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) { return; }
        settled = true;
        reject(new Error('timeout'));
      }, ms);
      Promise.resolve()
        .then(make)
        .then(function (value) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }, function (err) {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  var ICONS = {
    tick: '<svg viewBox="0 0 20 14" width="16" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M1 8.2 4.3 11.5 12.6 3"/></svg>',
    tick2: '<svg viewBox="0 0 20 14" width="18" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M1 8.2 4.3 11.5 12.6 3"/><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M7.3 8.2 10.6 11.5 18.9 3"/></svg>',
    clock: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><circle cx="8" cy="8" r="6.1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.7V8l2.3 1.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.5 2h5v2h-1.2l2.2 6.1-3.6 3.6H13v6.1l-1 1.2-1-1.2V13.7H7.1L3.5 10.1 5.7 4H4.5V2h10z"/></svg>'
  };

  /** Static-markup icon element (never built from user data). */
  function icon(name, cls) {
    var span = document.createElement('span');
    span.className = 'wa-tick' + (cls ? ' ' + cls : '');
    span.innerHTML = ICONS[name] || '';
    return span;
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
  var pendingSends = [];
  // Confirmed sends are kept briefly so a late / re-keyed engine echo of our own
  // message is adopted by the bubble that is already on screen instead of added again.
  var sentCache = [];
  var locallyRead = Object.create(null); // id -> true while the engine still reports unread
  var sheetText = '';
  var sheetMsg = null;                     // message behind the open action sheet
  var view = 'list'; // 'list' | 'chat' | 'contacts' | 'settings' | 'info' | 'status'

  var avatarCache = Object.create(null);   // id -> url | null | 'pending'
  var avatarWaiters = Object.create(null); // id -> [nodes]
  var bubbleNodes = Object.create(null);   // message key -> rendered bubble
  var msgByKey = Object.create(null);      // message key -> normalized message
  var loadToken = 0;                       // drops stale conversation fetches

  // ---- swipe-to-reply -------------------------------------------------
  var replyTo = null;                      // normalized message being replied to

  // ---- themes ---------------------------------------------------------
  var THEME_KEY = 'wv.theme';
  var WALL_KEY = 'wv.wall';
  var themePref = 'system';                // 'system' | 'light' | 'dark'
  var wallPref = 'default';                // 'default' | 'bright' | 'dim' | 'mono'

  // ---- status viewer ---------------------------------------------------
  var statusData = [];                     // [{ id, name, me, msgs: [] }]
  var statusSeen = Object.create(null);    // id -> true while viewed this session
  var statusMedia = Object.create(null);   // status msg key -> object URL
  var viewerState = { entries: [], gi: 0, mi: 0, timer: null, dur: 5200, running: false };
  var STATUS_TTL = 86400;                  // statuses older than 24h are not shown
  var meWid = null;

  var AVATAR_COLORS = [
    '#00a884', '#1f8f74', '#2563a6', '#6b4fa8',
    '#b4573f', '#8a6d1f', '#3f6f8f', '#a8427a'
  ];

  function avatarColor(id) {
    var h = 0;
    for (var i = 0; i < id.length; i++) { h = (h * 31 + id.charCodeAt(i)) >>> 0; }
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function initialOf(name) {
    var s = String(name || '?').replace(/[^0-9A-Za-z\u00C0-\uFFFF]+/g, ' ').trim();
    return (s ? s.charAt(0) : '?').toUpperCase();
  }

  // ---------------------------------------------------------------------
  // themes (light / dark / system + wallpaper choice)
  // ---------------------------------------------------------------------

  function storeGet(key, fallback) {
    try {
      var v = window.localStorage ? window.localStorage.getItem(key) : null;
      return v || fallback;
    } catch (e) { return fallback; }
  }

  function storeSet(key, value) {
    try {
      if (window.localStorage) { window.localStorage.setItem(key, value); }
    } catch (e) {}
  }

  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }

  function resolvedTheme() {
    if (themePref === 'light' || themePref === 'dark') { return themePref; }
    return systemPrefersDark() ? 'dark' : 'light';
  }

  function applyTheme() {
    var root = document.getElementById('wv-root');
    if (!root) { return; }
    root.setAttribute('data-theme', resolvedTheme());
    root.setAttribute('data-wall', wallPref);
    paintChips();
  }

  function paintChips() {
    var set = function (containerId, attr, value) {
      var box = document.getElementById(containerId);
      if (!box) { return; }
      var chips = box.querySelectorAll('.wa-chip');
      for (var i = 0; i < chips.length; i++) {
        var on = chips[i].getAttribute(attr) === value;
        chips[i].classList.toggle('wa-chip-on', on);
      }
    };
    set('theme-chips', 'data-theme', themePref);
    set('wall-chips', 'data-wall', wallPref);
  }

  function initTheme() {
    var t = storeGet(THEME_KEY, 'system');
    var w = storeGet(WALL_KEY, 'default');
    themePref = (t === 'light' || t === 'dark') ? t : 'system';
    wallPref = (w === 'bright' || w === 'dim' || w === 'mono') ? w : 'default';
    applyTheme();
    try {
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        var onChange = function () { if (themePref === 'system') { applyTheme(); } };
        if (mq.addEventListener) { mq.addEventListener('change', onChange); }
        else if (mq.addListener) { mq.addListener(onChange); }
      }
    } catch (e) {}
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
      engineId: id,
      user: userOf(id),
      name: c.name || c.formattedTitle ||
        (c.contact && (c.contact.pushname || c.contact.name || c.contact.formattedName)) ||
        userOf(id) || 'Unknown',
      isGroup: !!c.isGroup || isGroupId(id),
      unread: c.unreadCount || 0,
      pinned: !!c.pinned,
      ts: c.t || (lm && (lm.t || lm.timestamp)) || 0,
      preview: previewOf(lm),
      lastFromMe: !!(lm && lm.fromMe),
      lastAck: lm ? lm.ack : undefined,
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
      ack: (typeof m.ack === 'number') ? m.ack : undefined,
      sender: m.author || m.from || m.to || '',
      quoted: readQuoted(m)
    };
  }

  /** Quoted (replied-to) message info carried on a WhatsApp message. */
  function readQuoted(m) {
    try {
      var q = m.quotedMsg || null;
      if (q) {
        return {
          key: idStr(q.id) || '',
          fromMe: !!q.fromMe,
          text: msgText(q) || '',
          name: '',
          sender: q.author || q.from || ''
        };
      }
      if (m.quotedStanzaID) {
        var key = '';
        try { key = idStr(m.quotedMsgId) || ''; } catch (e1) { key = ''; }
        return {
          key: key,
          fromMe: !!m.quotedFromMe,
          text: '',
          name: '',
          sender: m.quotedParticipant || ''
        };
      }
    } catch (e) { log('readQuoted failed: ' + e); }
    return null;
  }

  function byPinnedThenTs(a, b) {
    var pa = a.pinned ? 1 : 0;
    var pb = b.pinned ? 1 : 0;
    if (pa !== pb) { return pb - pa; }
    return (b.ts || 0) - (a.ts || 0);
  }

  // ---------------------------------------------------------------------
  // avatars
  // ---------------------------------------------------------------------

  function setAvatarImg(node, url) {
    if (!node || !url) { return; }
    // Waiters are either an avatar wrapper <span> or a bare <img> (chat header).
    var img = (node.tagName === 'IMG') ? node : node.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      node.appendChild(img);
    }
    img.onerror = function () { img.hidden = true; };
    img.hidden = false;
    img.src = url;
  }

  /** Header avatar uses a single dedicated <img>, so it needs its own loader. */
  function loadHeaderAvatar(id) {
    var img = $('hdr-avatar-img');
    if (!img || !id) { return; }
    img.hidden = true;
    img.removeAttribute('src');
    var known = avatarCache[id];
    if (known && known !== 'pending') { img.src = known; img.hidden = false; return; }
    if (known === null) { return; }
    var api = contactApi();
    if (!api || typeof api.getProfilePictureUrl !== 'function') {
      avatarCache[id] = null;
      return;
    }
    if (known === 'pending') {
      // A row already started the fetch: subscribe to its result instead of refetching.
      // The shim only hands back the <img> while this chat is still the open one.
      (avatarWaiters[id] = avatarWaiters[id] || []).push({
        isConnected: true,
        tagName: 'SPAN',
        querySelector: function () { return openChatId === id ? img : null; }
      });
      return;
    }
    avatarCache[id] = 'pending';
    Promise.resolve()
      .then(function () { return api.getProfilePictureUrl(id, false); })
      .then(function (url) {
        avatarCache[id] = url || null;
        var node = $('hdr-avatar-img');
        if (!url || !node || openChatId !== id) { return; }
        setAvatarImg(node, url);
      })
      .catch(function () { avatarCache[id] = null; });
  }

  function attachAvatar(node, id) {
    if (!node || !id) { return; }
    var known = avatarCache[id];
    if (known === null) { return; }
    if (known && known !== 'pending') { setAvatarImg(node, known); return; }
    if (known === 'pending') {
      (avatarWaiters[id] = avatarWaiters[id] || []).push(node);
      return;
    }
    var api = contactApi();
    if (!api || typeof api.getProfilePictureUrl !== 'function') {
      avatarCache[id] = null;
      return;
    }
    avatarCache[id] = 'pending';
    // The node that started the fetch is a waiter too, otherwise the very first
    // render would never receive the picture it asked for.
    (avatarWaiters[id] = avatarWaiters[id] || []).push(node);
    Promise.resolve()
      .then(function () { return api.getProfilePictureUrl(id, false); })
      .then(function (url) {
        avatarCache[id] = url || null;
        var waiters = avatarWaiters[id] || [];
        delete avatarWaiters[id];
        if (url) {
          waiters.forEach(function (n) { if (n.isConnected) { setAvatarImg(n, url); } });
        }
      })
      .catch(function () { avatarCache[id] = null; });
  }

  // ---------------------------------------------------------------------
  // header
  // ---------------------------------------------------------------------

  function setHeader(opts) {
    opts = opts || {};
    var btnBack = $('btn-back');
    var title = $('hdr-title');
    var sub = $('hdr-sub');
    var avatar = $('hdr-avatar');
    var initial = $('hdr-avatar-initial');
    var img = $('hdr-avatar-img');

    if (btnBack) { btnBack.hidden = !opts.back; }
    if ($('btn-search')) { $('btn-search').hidden = !opts.search; }
    if ($('btn-refresh')) { $('btn-refresh').hidden = !opts.refresh; }
    if ($('btn-menu')) { $('btn-menu').hidden = !opts.menu; }
    if ($('btn-info')) { $('btn-info').hidden = !opts.info; }
    if (title) { title.textContent = opts.title || 'WhatsApp'; }

    if (sub) {
      if (opts.sub) { sub.textContent = opts.sub; sub.hidden = false; }
      else { sub.hidden = true; }
    }

    if (avatar) {
      if (opts.avatar) {
        avatar.hidden = false;
        avatar.style.backgroundColor = avatarColor(opts.avatar.id || '');
        if (initial) { initial.textContent = initialOf(opts.avatar.name); }
        if (img) { img.hidden = true; img.removeAttribute('src'); }
        loadHeaderAvatar(opts.avatar.id);
      } else {
        avatar.hidden = true;
      }
    }
  }

  // ---------------------------------------------------------------------
  // chat list rendering
  // ---------------------------------------------------------------------

  function emptyState(title, text) {
    var wrap = document.createElement('div');
    wrap.className = 'wa-empty';
    var t = document.createElement('div');
    t.className = 'wa-empty-title';
    t.textContent = title;
    wrap.appendChild(t);
    var p = document.createElement('div');
    p.className = 'wa-empty-text';
    p.textContent = text;
    return wrap;
  }

  function renderList() {
    var listEl = $('chat-list');
    if (!listEl) { return; }
    var scrolledTop = listEl.scrollTop;
    var q = filterText.toLowerCase().trim();
    var items = chats.filter(function (c) {
      if (!q) { return true; }
      return (c.name || '').toLowerCase().indexOf(q) >= 0 ||
        (c.preview || '').toLowerCase().indexOf(q) >= 0 ||
        (c.user || '').indexOf(q) >= 0;
    });

    listEl.textContent = '';
    if (!items.length) {
      listEl.appendChild(chats.length
        ? emptyState('No chats found', 'Try a different name or number.')
        : emptyState('No chats yet', 'Start a conversation with the + button.'));
      return;
    }

    var frag = document.createDocumentFragment();
    // Rendering is capped so accounts with thousands of stored chats stay responsive;
    // search still runs over the full list.
    items.slice(0, 500).forEach(function (c) { frag.appendChild(buildRow(c)); });
    listEl.appendChild(frag);
    listEl.scrollTop = scrolledTop;
  }

  function avatarNode(id, name, isGroup) {
    var av = document.createElement('span');
    av.className = 'wa-avatar';
    av.style.backgroundColor = avatarColor(id);
    av.textContent = initialOf(name);
    if (isGroup) { av.setAttribute('data-group', '1'); }
    attachAvatar(av, id);
    return av;
  }

  function buildRow(c) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'wa-row' + (c.unread ? ' wa-row-unread' : '');

    row.appendChild(avatarNode(c.id, c.name, c.isGroup));

    var mid = document.createElement('span');
    mid.className = 'wa-row-mid';

    var top = document.createElement('span');
    top.className = 'wa-row-top';
    var name = document.createElement('span');
    name.className = 'wa-row-name';
    name.textContent = c.name;
    top.appendChild(name);
    if (c.pinned) { top.appendChild(icon('pin', 'wa-pin')); }
    var time = document.createElement('span');
    time.className = 'wa-row-time';
    time.textContent = fmtTime(c.ts);
    top.appendChild(time);

    var bottom = document.createElement('span');
    bottom.className = 'wa-row-bottom';
    var prev = document.createElement('span');
    prev.className = 'wa-row-prev';
    if (c.lastFromMe) {
      var tick = icon(c.lastAck !== undefined && c.lastAck >= 2 ? 'tick2' : 'tick',
        c.lastAck !== undefined && c.lastAck >= 3 ? 'wa-tick-read' : '');
      prev.appendChild(tick);
    }
    var prevText = document.createElement('span');
    prevText.className = 'wa-row-prev-text';
    prevText.textContent = c.preview || (c.unread ? 'New messages' : '');
    prev.appendChild(prevText);

    bottom.appendChild(prev);
    if (c.unread) {
      var badge = document.createElement('span');
      badge.className = 'wa-badge';
      badge.textContent = c.unread > 99 ? '99+' : String(c.unread);
      bottom.appendChild(badge);
    }

    mid.appendChild(top);
    mid.appendChild(bottom);
    row.appendChild(mid);

    row.addEventListener('click', function () { openChat(c.id, c.name, c.isGroup); });
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
      var next = (raw || [])
        .map(normalizeChat)
        .filter(function (c) {
          if (!c.id) { return false; }
          return !/status@broadcast|@broadcast|@newsletter/.test(c.id);
        });
      next.forEach(function (c) { if (locallyRead[c.id]) { c.unread = 0; } });
      next.sort(byPinnedThenTs);
      chats = next;
      chatById = Object.create(null);
      chats.forEach(function (c) { chatById[c.id] = c; });
      if (view === 'list') { renderList(); }
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
    softRefreshTimer = setTimeout(loadChats, 1000);
  }

  // ---------------------------------------------------------------------
  // panes
  // ---------------------------------------------------------------------

  function showList() {
    view = 'list';
    openChatId = null;
    if ($('list-pane')) { $('list-pane').hidden = false; }
    if ($('chat-pane')) { $('chat-pane').hidden = true; }
    if ($('contacts-pane')) { $('contacts-pane').hidden = true; }
    if ($('settings-pane')) { $('settings-pane').hidden = true; }
    if ($('info-pane')) { $('info-pane').hidden = true; }
    if ($('status-pane')) { $('status-pane').hidden = true; }
    clearReply();
    setHeader({ title: 'WhatsApp', back: false, search: true, refresh: true, menu: true });
    setUiState('list');
    renderList();
  }

  function hideAllPanes() {
    if ($('list-pane')) { $('list-pane').hidden = true; }
    if ($('chat-pane')) { $('chat-pane').hidden = true; }
    if ($('contacts-pane')) { $('contacts-pane').hidden = true; }
    if ($('settings-pane')) { $('settings-pane').hidden = true; }
    if ($('info-pane')) { $('info-pane').hidden = true; }
    if ($('status-pane')) { $('status-pane').hidden = true; }
    if ($('searchwrap')) { $('searchwrap').hidden = true; }
  }

  function showContacts() {
    view = 'contacts';
    hideAllPanes();
    if ($('contacts-pane')) { $('contacts-pane').hidden = false; }
    setHeader({ title: 'New chat', back: true, search: false, refresh: false });
    setUiState('pane');
    loadContacts();
  }

  function showSettings() {
    view = 'settings';
    hideAllPanes();
    if ($('settings-pane')) { $('settings-pane').hidden = false; }
    setHeader({ title: 'Settings', back: true, search: false, refresh: false });
    setUiState('pane');
    paintChips();
    loadMyProfile();
  }

  /** Contact / group details for the open chat. The chat pane stays mounted so
   *  coming back restores the conversation exactly where it was. */
  function showInfo() {
    var id = openChatId;
    if (!id) { return; }
    var c = chatById[id] || ensureChat(id);
    view = 'info';
    if ($('chat-pane')) { $('chat-pane').hidden = true; }
    if ($('info-pane')) { $('info-pane').hidden = false; }
    if ($('list-pane')) { $('list-pane').hidden = true; }
    setHeader({ title: c.isGroup ? 'Group info' : 'Contact info', back: true, search: false, refresh: false });
    setUiState('pane');
    renderInfo(c);
  }

  /** Back out of the info pane into the conversation that is still mounted. */
  function backFromInfo() {
    if (openChatId) {
      view = 'chat';
      if ($('info-pane')) { $('info-pane').hidden = true; }
      if ($('chat-pane')) { $('chat-pane').hidden = false; }
      var c = chatById[openChatId];
      if (c) { showChatHeader(c); }
      setUiState('chat');
      return true;
    }
    showList();
    return true;
  }

  function showStatus() {
    view = 'status';
    hideAllPanes();
    if ($('status-pane')) { $('status-pane').hidden = false; }
    setHeader({ title: 'Status', back: true, search: false, refresh: true });
    setUiState('pane');
    var listEl = $('status-list');
    if (listEl) {
      listEl.textContent = '';
      listEl.appendChild(emptyState('Loading status…', 'Fetching the latest updates from your contacts.'));
    }
    loadStatuses().then(function () { renderStatusList(); });
  }

  function showChatHeader(c) {
    setHeader({
      title: c.name,
      sub: c.isGroup ? 'Group' : ('+' + c.user),
      back: true,
      search: false,
      refresh: false,
      info: true,
      avatar: { id: c.id, name: c.name }
    });
  }

  // ---------------------------------------------------------------------
  // conversation
  // ---------------------------------------------------------------------

  function ensureChat(id, name, isGroup) {
    var c = chatById[id];
    if (!id) { return null; }
    if (c) {
      if (name) { c.name = name; }
      return c;
    }
    c = {
      id: id,
      engineId: id,
      user: userOf(id),
      name: name || userOf(id) || 'Chat',
      isGroup: isGroup === undefined ? isGroupId(id) : !!isGroup,
      unread: 0,
      pinned: false,
      ts: 0,
      preview: '',
      lastFromMe: false,
      obj: null
    };
    chatById[id] = c;
    return c;
  }

  function openChat(id, name, isGroup) {
    var c = ensureChat(id, name, isGroup);
    if (!c) { toast('Chat not found'); return; }
    openChatId = id;
    seenMsgKeys = Object.create(null);
    view = 'chat';
    clearReply();

    if ($('searchwrap')) { $('searchwrap').hidden = true; }
    $('chat-pane').hidden = false;
    $('list-pane').hidden = true;
    $('contacts-pane').hidden = true;
    showChatHeader(c);
    setUiState('chat');

    var msgsEl = $('messages');
    msgsEl.textContent = '';
    msgsEl.removeAttribute('data-day');
    var loading = emptyState('Loading messages…', 'Fetching from the linked account.');
    loading.className = 'wa-empty';
    msgsEl.appendChild(loading);
    if ($('btn-scroll-down')) { $('btn-scroll-down').hidden = true; }

    var input = $('msg-input');
    if (input) { input.value = ''; }

    markRead(id);
    loadMessages(id);
  }

  function closeChat() {
    if (view !== 'chat') { return false; }
    showList();
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
    if (c && c.unread) { c.unread = 0; }
    locallyRead[id] = true;
    if (view === 'list') { renderList(); }
  }

  function loadMessages(id, attempt) {
    attempt = attempt || 0;
    var msgsEl = $('messages');
    if (!msgsEl || openChatId !== id) { return; }
    var api = chatApi();
    if (!api || typeof api.getMessages !== 'function') {
      // The engine is still booting: keep polling instead of giving up on a blank thread.
      if (attempt < 45) {
        setTimeout(function () {
          if (openChatId === id) { loadMessages(id, attempt + 1); }
        }, 1200);
      } else {
        renderLoadError('The WhatsApp engine is still starting.');
      }
      return;
    }
    var token = ++loadToken;
    var ids = chatIds(id);
    var alive = function () { return token === loadToken && openChatId === id; };

    fetchMessages(api, ids, newestKey(ids)).then(function (raw) {
      if (!alive()) { return null; }
      var merged = mergeMessages([storeMessages(ids), raw]);
      if (merged.length) { renderThread(merged); return null; }
      // Nothing loaded: try the @lid/@c.us counterpart of the chat.
      return chatIdsWithLid(id).then(function (more) {
        if (!alive()) { return null; }
        return fetchMessages(api, more.slice(ids.length), null).then(function (raw2) {
          if (!alive()) { return null; }
          var again = mergeMessages([storeMessages(more), raw2]);
          if (again.length) { renderThread(again); return null; }
          // Still nothing: let the hidden official UI open the chat so the engine
          // hydrates it, then read the store once more.
          return nudgeOfficialChat(more).then(function () {
            if (!alive()) { return null; }
            var last = mergeMessages([storeMessages(more)]);
            if (last.length) { renderThread(last); } else { renderThread([]); }
            return null;
          });
        });
      });
    }).catch(function (e) {
      if (!alive()) { return; }
      log('loadMessages(' + id + ') failed: ' + e);
      renderLoadError(String((e && e.message) || e || 'unknown error'));
    });
  }

  function asMessageArray(raw) {
    if (Array.isArray(raw)) { return raw; }
    if (raw && Array.isArray(raw.messages)) { return raw.messages; }
    return [];
  }

  /** Messages the engine already holds for these chat ids (no DB round-trip). */
  function storeMessages(ids) {
    var want = Object.create(null);
    (ids || []).forEach(function (x) { if (x) { want[x] = true; } });
    var out = [];
    var seen = Object.create(null);

    function push(m) {
      if (!m) { return; }
      var key = '';
      try { key = m.id ? idStr(m.id) : ''; } catch (e) { key = ''; }
      if (key && seen[key]) { return; }
      if (key) { seen[key] = true; }
      out.push(m);
    }

    var model = null;
    for (var i = 0; i < (ids || []).length && !model; i++) { model = chatModelOf(ids[i]); }
    if (model) {
      try {
        var collection = model.msgs;
        var list = null;
        if (collection) {
          if (typeof collection.getModelsArray === 'function') { list = collection.getModelsArray(); }
          else if (Array.isArray(collection.models)) { list = collection.models; }
        }
        if (list) { list.forEach(push); }
        if (model.lastMessage) { push(model.lastMessage); }
      } catch (e) { log('chat.msgs scan failed: ' + e); }
    }

    try {
      var store = waStore();
      var msgStore = store && store.MsgStore;
      if (msgStore && typeof msgStore.getModelsArray === 'function') {
        var all = msgStore.getModelsArray();
        for (var j = 0; j < all.length; j++) {
          var remote = '';
          try { remote = all[j] && all[j].id ? idStr(all[j].id.remote) : ''; } catch (e2) { remote = ''; }
          if (remote && want[remote]) { push(all[j]); }
        }
      }
    } catch (e3) { log('MsgStore scan failed: ' + e3); }

    return out;
  }

  /** Newest loaded message key, used as an explicit pagination anchor. */
  function newestKey(ids) {
    var best = null;
    var bestTs = -1;
    storeMessages(ids).forEach(function (m) {
      var ts = Number((m && (m.t || m.timestamp)) || 0);
      var key = '';
      try { key = m && m.id ? idStr(m.id) : ''; } catch (e) { key = ''; }
      if (key && ts >= bestTs) { bestTs = ts; best = key; }
    });
    return best;
  }

  /** Merge raw messages from several sources into one de-duplicated list. */
  function mergeMessages(lists) {
    var byKey = Object.create(null);
    var order = [];
    (lists || []).forEach(function (list) {
      asMessageArray(list).forEach(function (raw) {
        var m = normalizeMsg(raw);
        if (!m.text && !m.body) { return; }
        if (!byKey[m.key]) { order.push(m.key); }
        byKey[m.key] = m;
      });
    });
    var out = order.map(function (k) { return byKey[k]; });
    out.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
    return out;
  }

  /** getMessages, retried on every known id variant of the chat. */
  function fetchMessages(api, ids, anchor) {
    var queue = (ids || []).slice();

    function call(chatId, opts) {
      return withTimeout(function () { return api.getMessages(chatId, opts); }, 10000)
        .then(function (raw) { return asMessageArray(raw); })
        .catch(function (e) {
          log('getMessages(' + chatId + ') failed: ' + e);
          return [];
        });
    }

    function attempt() {
      if (!queue.length) { return Promise.resolve([]); }
      var chatId = queue.shift();
      // The default anchor is the newest message the engine knows, which is what a
      // conversation should show; an explicit anchor is only a fallback for builds
      // where that default anchor is missing.
      return call(chatId, { count: 80 }).then(function (list) {
        if (list.length) { return list; }
        if (!anchor) { return attempt(); }
        return call(chatId, { count: 80, id: anchor }).then(function (list2) {
          return list2.length ? list2 : attempt();
        });
      });
    }

    return attempt();
  }

  /**
   * Last resort: click the chat row in the hidden official list so WhatsApp Web
   * actually opens the conversation and loads its messages into the engine.
   */
  function nudgeOfficialChat(ids) {
    try {
      for (var i = 0; i < (ids || []).length; i++) {
        var id = String(ids[i] || '').replace(/"/g, '\\"');
        if (!id) { continue; }
        var row = document.querySelector('#pane-side [data-id="' + id + '"]') ||
          document.querySelector('#pane-side [data-id$="' + id + '"]');
        if (row) {
          row.click();
          log('nudged official UI for ' + id);
          break;
        }
      }
    } catch (e) { log('nudge failed: ' + e); }
    return wait(1200);
  }

  function renderThread(msgs) {
    var msgsEl = $('messages');
    if (!msgsEl) { return; }
    msgsEl.textContent = '';
    msgsEl.removeAttribute('data-day');
    seenMsgKeys = Object.create(null);
    bubbleNodes = Object.create(null);
    msgByKey = Object.create(null);
    if (!msgs || !msgs.length) {
      msgsEl.appendChild(emptyState('No messages yet', 'Say hello 👋'));
      return;
    }
    // Keep the DOM light on accounts with very long threads.
    var shown = msgs.length > 400 ? msgs.slice(msgs.length - 400) : msgs;
    shown.forEach(function (m) { appendBubble(m, false); });
    scrollToEnd();
  }

  function renderLoadError(detail) {
    var msgsEl = $('messages');
    if (!msgsEl) { return; }
    msgsEl.textContent = '';
    msgsEl.removeAttribute('data-day');
    var box = emptyState('Could not load messages', detail || 'The WhatsApp engine did not answer.');
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'wa-retry';
    retry.textContent = 'Retry';
    retry.addEventListener('click', function () {
      if (!openChatId) { return; }
      msgsEl.textContent = '';
      msgsEl.appendChild(emptyState('Loading messages…', 'Fetching from the linked account.'));
      loadMessages(openChatId);
    });
    box.appendChild(retry);
    msgsEl.appendChild(box);
  }

  function tickFor(m) {
    if (m.failed) { return null; }
    if (m.ack === undefined) { return icon('tick'); }
    if (m.ack === 0) { return icon('clock'); }
    if (m.ack >= 3) { return icon('tick2', 'wa-tick-read'); }
    if (m.ack >= 2) { return icon('tick2'); }
    return icon('tick');
  }

  /** Re-paint the delivery ticks of an already rendered outgoing bubble. */
  function updateBubbleAck(node, ack) {
    if (!node || typeof ack !== 'number') { return; }
    var meta = node.querySelector('.wa-bubble-meta');
    if (!meta) { return; }
    var old = meta.querySelector('.wa-tick');
    if (old) { old.parentNode.removeChild(old); }
    var tick = tickFor({ ack: ack, failed: false });
    if (tick) { meta.appendChild(tick); }
    var c = openChatId ? chatById[openChatId] : null;
    if (c && c.lastFromMe) { c.lastAck = ack; }
  }

  function appendBubble(m, isTmp) {
    var msgsEl = $('messages');
    if (!msgsEl) { return null; }
    if (!isTmp) {
      if (seenMsgKeys[m.key]) { return null; }
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

    var prev = msgsEl.lastElementChild;
    while (prev && !prev.classList.contains('wa-bubble')) {
      prev = prev.previousElementSibling;
    }
    var sameRun = false;
    if (prev && prev.classList.contains('wa-bubble') &&
      prev.getAttribute('data-from') === (m.fromMe ? '1' : '0')) {
      var prevTs = Number(prev.getAttribute('data-ts') || 0);
      if (!prevTs || Math.abs((m.ts || 0) - prevTs) < 300) { sameRun = true; }
    }

    var wrap = document.createElement('div');
    wrap.className = 'wa-bubble ' + (m.fromMe ? 'wa-out' : 'wa-in') +
      (sameRun ? ' wa-run' : '') + ' wa-tail' +
      (m.failed ? ' wa-failed' : '');
    wrap.setAttribute('data-from', m.fromMe ? '1' : '0');
    wrap.setAttribute('data-ts', String(m.ts || 0));
    wrap.setAttribute('data-key', m.key);

    if (sameRun && prev) { prev.classList.remove('wa-tail'); }

    var open = chatById[openChatId];
    if (!m.fromMe && open && open.isGroup && m.sender) {
      var lbl = document.createElement('div');
      lbl.className = 'wa-sender';
      lbl.textContent = userOf(m.sender);
      wrap.appendChild(lbl);
    }

    var body = document.createElement('div');
    body.className = 'wa-bubble-text';
    body.textContent = m.text || m.body || '';

    // quoted (replied-to) message block, like WhatsApp
    var quote = m.quoted;
    if (quote) {
      var q = document.createElement('div');
      q.className = 'wa-quote';
      var qName = document.createElement('div');
      qName.className = 'wa-quote-name';
      var who = quoteNameOf(quote);
      qName.textContent = who;
      if (!who) { qName.hidden = true; }
      var qBody = document.createElement('div');
      qBody.className = 'wa-quote-body';
      qBody.textContent = quote.text || 'Message';
      q.appendChild(qName);
      q.appendChild(qBody);
      wrap.appendChild(q);
      hydrateQuote(m);
    }
    wrap.appendChild(body);

    var meta = document.createElement('div');
    meta.className = 'wa-bubble-meta';
    var t = document.createElement('span');
    t.className = 'wa-bubble-time';
    t.textContent = fmtTime(m.ts);
    meta.appendChild(t);
    if (m.fromMe) {
      var tick = isTmp ? icon('clock') : tickFor(m);
      if (tick) { meta.appendChild(tick); }
    }
    wrap.appendChild(meta);

    if (isTmp) { wrap.setAttribute('data-tmp', '1'); }
    else {
      bubbleNodes[m.key] = wrap;
      msgByKey[m.key] = m;
    }

    bindBubbleGestures(wrap, m);

    msgsEl.appendChild(wrap);
    return wrap;
  }

  function scrollToEnd() {
    var msgsEl = $('messages');
    if (msgsEl) { msgsEl.scrollTop = msgsEl.scrollHeight; }
    if ($('btn-scroll-down')) { $('btn-scroll-down').hidden = true; }
  }

  // ---------------------------------------------------------------------
  // quoted replies
  // ---------------------------------------------------------------------

  function quoteNameOf(q) {
    if (!q) { return ''; }
    if (q.name) { return q.name; }
    if (q.fromMe) { return 'You'; }
    if (q.sender) { return userOf(q.sender); }
    return '';
  }

  /** Ask the engine for the quoted message when only its id travelled with the parent. */
  function hydrateQuote(m) {
    var q = m.quoted;
    if (!q || q.text || q.hydrating) { return; }
    var api = chatApi();
    if (!api || typeof api.getQuotedMsg !== 'function') { return; }
    if (!m.key || /^tmp-/.test(m.key)) { return; }
    q.hydrating = true;
    Promise.resolve()
      .then(function () { return api.getQuotedMsg(m.key); })
      .then(function (quoted) {
        q.hydrating = false;
        if (!quoted) { return; }
        q.text = msgText(quoted) || q.text || '';
        q.fromMe = !!quoted.fromMe;
        if (!q.sender) { q.sender = quoted.author || quoted.from || quoted.to || ''; }
        var node = bubbleNodes[m.key];
        if (!node || !node.isConnected) { return; }
        var body = node.querySelector('.wa-quote-body');
        if (body) { body.textContent = q.text || 'Message'; }
        var nameEl = node.querySelector('.wa-quote-name');
        if (nameEl) {
          var who = quoteNameOf(q);
          if (who) { nameEl.textContent = who; nameEl.hidden = false; }
        }
      })
      .catch(function () { q.hydrating = false; });
  }

  function setReplyTarget(m) {
    if (!m) { return; }
    replyTo = {
      key: m.key || '',
      text: m.text || m.body || '',
      name: replyNameOf(m),
      fromMe: !!m.fromMe
    };
    if (/^tmp-/.test(replyTo.key)) { replyTo.key = ''; }
    var bar = $('replybar');
    if (bar) {
      bar.hidden = false;
      var n = $('replybar-name');
      if (n) { n.textContent = replyTo.name || ''; }
      var b = $('replybar-body');
      if (b) { b.textContent = replyTo.text || 'Message'; }
    }
    var input = $('msg-input');
    if (input) {
      try { input.focus(); } catch (e) {}
    }
  }

  function replyNameOf(m) {
    if (!m) { return ''; }
    if (m.fromMe) { return 'You'; }
    var c = openChatId ? chatById[openChatId] : null;
    if (c && c.isGroup && m.sender) { return userOf(m.sender); }
    if (c) { return c.name; }
    return '';
  }

  function clearReply() {
    replyTo = null;
    var bar = $('replybar');
    if (bar) { bar.hidden = true; }
  }

  function nearBottom() {
    var msgsEl = $('messages');
    if (!msgsEl) { return true; }
    return (msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight) < 90;
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

    var uiChatId = openChatId;
    var chat = chatById[uiChatId];
    var target = (chat && chat.engineId) || uiChatId;
    input.value = '';

    var now = Math.floor(Date.now() / 1000);
    var tmpMsg = {
      key: 'tmp-' + now + '-' + Math.random().toString(36).slice(2, 8),
      fromMe: true,
      body: text,
      text: text,
      ts: now,
      type: 'chat',
      ack: undefined,
      sender: ''
    };
    var node = appendBubble(tmpMsg, true);
    scrollToEnd();

    var opts = {};
    if (replyTo && replyTo.key && !/^tmp-/.test(replyTo.key)) {
      opts.quotedMsg = replyTo.key;
    }
    clearReply();

    var pending = { chatId: uiChatId, text: text, node: node, at: now };
    pendingSends.push(pending);

    attemptSend(api, target, text, uiChatId, opts).then(function (result) {
      confirmSent(pending, result);
    }).catch(function (e) {
      log('sendTextMessage error: ' + e);
      failPending(pending, text, e);
    });
  }

  /** True for the errors that mean "this chat id is not usable", not "sending broke". */
  function isIdError(e) {
    var s = String((e && (e.code || e.message)) || e || '');
    return /chat_not_found|invalid_wid|invalid|not\s*found/i.test(s);
  }

  /**
   * Sends and, when the engine rejects the id it was given, retries with the
   * @c.us/@lid counterpart of the chat and finally with the chat the engine finds
   * (or creates) for that id. Other failures are reported straight away: retrying
   * blindly could post the same message twice.
   */
  function attemptSend(api, target, text, uiChatId, opts) {
    var sendOpts = opts || null;

    function send(to) {
      if (sendOpts && sendOpts.quotedMsg) {
        return api.sendTextMessage(to, text, sendOpts);
      }
      return api.sendTextMessage(to, text);
    }

    return Promise.resolve()
      .then(function () { return send(target); })
      .catch(function (firstError) {
        log('send to ' + target + ' failed: ' + firstError);
        // The engine rejected the quoted message (e.g. it is too old to reply to):
        // the message itself never left, so sending it once more without the quote
        // cannot duplicate anything.
        if (sendOpts && sendOpts.quotedMsg && /quoted|quote/i.test(String(
          (firstError && (firstError.code || firstError.message)) || firstError || ''))) {
          log('retrying without the quote');
          sendOpts = null;
          return send(target);
        }
        if (!isIdError(firstError)) { throw firstError; }
        return chatIdsWithLid(uiChatId).then(function (ids) {
          var alt = null;
          for (var i = 0; i < ids.length; i++) {
            if (ids[i] !== target) { alt = ids[i]; break; }
          }
          if (!alt) { throw firstError; }
          return send(alt);
        });
      })
      .catch(function (secondError) {
        if (!isIdError(secondError)) { throw secondError; }
        if (!api || typeof api.find !== 'function') { throw secondError; }
        return Promise.resolve()
          .then(function () { return api.find(uiChatId); })
          .then(function (model) {
            var id = idStr(model && model.id);
            if (!id || id === target) { throw secondError; }
            return send(id);
          });
      });
  }

  function confirmSent(pending, result) {
    var i = pendingSends.indexOf(pending);
    if (i >= 0) { pendingSends.splice(i, 1); }

    var ack = (result && typeof result.ack === 'number') ? result.ack : 0;
    var key = idStr(result && result.id);
    var node = pending.node;

    if (node && node.isConnected) {
      node.removeAttribute('data-tmp');
      // The echo may already own the bubble (it arrived first): never steal its key.
      var bound = node.getAttribute('data-key');
      if (key) {
        bubbleNodes[key] = node;
        seenMsgKeys[key] = true;
        if (!bound) {
          node.setAttribute('data-key', key);
        }
        if (!msgByKey[key]) {
          msgByKey[key] = {
            key: key,
            fromMe: true,
            body: pending.text,
            text: pending.text,
            ts: pending.at || Math.floor(Date.now() / 1000),
            type: 'chat',
            sender: ''
          };
        }
      }
      updateBubbleAck(node, ack);
    }

    // Keep it around: the engine's own copy may still arrive (possibly re-keyed).
    pruneSent();
    sentCache.push({
      chatId: pending.chatId,
      text: pending.text,
      node: node,
      at: pending.at || Math.floor(Date.now() / 1000),
      key: key
    });

    var c = chatById[pending.chatId];
    if (c) {
      c.preview = pending.text;
      c.ts = Math.floor(Date.now() / 1000);
      c.lastFromMe = true;
      c.lastAck = ack;
      chats.sort(byPinnedThenTs);
      if (view === 'list') { renderList(); }
    }
    scheduleSoftRefresh();
  }

  function failPending(pending, text, err) {
    var i = pendingSends.indexOf(pending);
    if (i >= 0) { pendingSends.splice(i, 1); }
    var node = pending.node;
    if (node && node.isConnected) {
      node.classList.add('wa-failed');
      var tick = node.querySelector('.wa-tick');
      if (tick) { tick.parentNode.removeChild(tick); }
      var meta = node.querySelector('.wa-bubble-meta');
      if (meta && !meta.querySelector('.wa-fail-flag')) {
        var flag = document.createElement('span');
        flag.className = 'wa-fail-flag';
        flag.textContent = 'Not sent';
        meta.appendChild(flag);
      }
    }
    var detail = String((err && (err.message || err.code)) || err || '').slice(0, 90);
    toast(detail ? ('Message not sent — ' + detail) : 'Message not sent', 5000);
    log('send failed: ' + detail);
    var field = $('msg-input');
    if (field && !field.value) { field.value = text; }
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

  function sameChatKey(a, b) {
    if (!a || !b) { return false; }
    if (a === b) { return true; }
    var ua = userOf(a);
    var ub = userOf(b);
    return !!ua && !!ub && ua === ub;
  }

  function hasPendingFor(cid) {
    for (var i = 0; i < pendingSends.length; i++) {
      if (sameChatKey(pendingSends[i].chatId, cid)) { return true; }
    }
    return false;
  }

  function pruneSent() {
    var now = Math.floor(Date.now() / 1000);
    for (var i = sentCache.length - 1; i >= 0; i--) {
      if (now - (sentCache[i].at || 0) > 90) { sentCache.splice(i, 1); }
    }
    while (sentCache.length > 40) { sentCache.shift(); }
  }

  /**
   * Find the optimistic / just-confirmed bubble that this own-message echo belongs to.
   * The engine may report the message under a different id form (@c.us vs @lid) or
   * even re-key it after the server accepts it, so the text + chat + recency - not the
   * key alone - decide the match.
   */
  function matchPending(cid, m) {
    var now = Math.floor(Date.now() / 1000);
    var lists = [pendingSends, sentCache];
    var li;
    var i;
    var list;
    var p;

    // 1) exact key match first, so two identical texts sent back to back can never
    //    claim each other's bubble
    for (li = 0; li < lists.length; li++) {
      list = lists[li];
      for (i = 0; i < list.length; i++) {
        p = list[i];
        if (p.key && p.key === m.key) { return { list: list, i: i }; }
      }
    }

    var loose = null;
    for (li = 0; li < lists.length; li++) {
      list = lists[li];
      for (i = 0; i < list.length; i++) {
        p = list[i];
        if (p.text !== m.body) { continue; }
        var age = p.at ? (now - p.at) : 0;
        if (age > 90) { continue; }
        // already bound to a different message: only within a few seconds can this
        // still be a re-keyed copy of the very same send
        if (p.key && age > 15) { continue; }
        if (cid && sameChatKey(p.chatId, cid)) { return { list: list, i: i }; }
        if (!loose) { loose = { list: list, i: i }; }
      }
    }
    if (loose && !(cid && hasPendingFor(cid))) { return loose; }
    return null;
  }

  /**
   * The engine echoes our own message back through 'chat.new_message'. The optimistic
   * bubble on screen is *adopted* by that echo - removed and re-added used to leave a
   * twin bubble on the user's side whenever the echo id differed from the send result.
   *
   * Returns true when the message is already represented in the UI.
   */
  function settlePending(cid, m) {
    if (!m.fromMe || !m.body) { return false; }
    var hit = matchPending(cid, m);
    if (!hit) { return false; }

    var pending = hit.list[hit.i];
    hit.list.splice(hit.i, 1);

    var node = pending.node;
    if (!node || !node.isConnected) {
      // The bubble is gone (the thread was re-rendered): let the caller draw it fresh.
      return false;
    }
    node.removeAttribute('data-tmp');
    node.classList.remove('wa-failed');
    var flag = node.querySelector('.wa-fail-flag');
    if (flag && flag.parentNode) { flag.parentNode.removeChild(flag); }
    if (m.key) {
      node.setAttribute('data-key', m.key);
      bubbleNodes[m.key] = node;
      msgByKey[m.key] = m;
      seenMsgKeys[m.key] = true;
    }
    updateBubbleAck(node, typeof m.ack === 'number' ? m.ack : 0);
    return true;
  }

  function onNewMessage(msg) {
    try {
      var m = normalizeMsg(msg);
      var cid = resolveChatId(msg);
      if (!cid) {
        scheduleSoftRefresh();
        return;
      }
      var c = ensureChat(cid);
      settlePending(cid, m);

      c.preview = previewOf(msg) || c.preview;
      c.ts = m.ts || c.ts;
      c.lastFromMe = m.fromMe;
      c.lastAck = m.ack;
      if (!m.fromMe) {
        // A genuinely new incoming message re-arms the unread badge.
        delete locallyRead[cid];
      }
      if (!m.fromMe && cid !== openChatId) {
        c.unread = (c.unread || 0) + 1;
      }
      chats.sort(byPinnedThenTs);

      if (cid === openChatId && view === 'chat') {
        var stick = nearBottom();
        appendBubble(m, false);
        if (stick) { scrollToEnd(); }
        else if ($('btn-scroll-down')) { $('btn-scroll-down').hidden = false; }
        if (!m.fromMe) { markRead(cid); }
      }
      if (view === 'list') { renderList(); }
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
      w.on('chat.msg_ack_change', function (e) {
        try {
          var ack = e && e.ack;
          var ids = (e && e.ids) || [];
          for (var i = 0; i < ids.length; i++) {
            var node = bubbleNodes[idStr(ids[i])];
            if (node && node.isConnected) { updateBubbleAck(node, ack); }
          }
        } catch (err) {}
      });
    } catch (e) {}
    try {
      w.on('chat.unread_count_changed', function (e) {
        try {
          var id = idStr(e && e.chat && e.chat.id);
          var c = chatById[id];
          if (c && typeof e.unreadCount === 'number' && e.unreadCount !== c.unread) {
            c.unread = e.unreadCount;
            if (view === 'list') { renderList(); }
          }
        } catch (err) {}
      });
    } catch (e) {}
    log('custom UI subscribed to WPP events');
  }

  // ---------------------------------------------------------------------
  // contacts (new chat)
  // ---------------------------------------------------------------------

  function loadContacts() {
    var listEl = $('contact-list');
    if (!listEl) { return; }
    var api = contactApi();
    if (!api || typeof api.list !== 'function') {
      listEl.textContent = '';
      listEl.appendChild(emptyState('Contacts unavailable', 'The engine is still starting.'));
      return;
    }
    var p;
    try {
      p = api.list();
    } catch (e) {
      log('contact.list threw: ' + e);
      listEl.textContent = '';
      listEl.appendChild(emptyState('Could not load contacts', 'Try again in a moment.'));
      return;
    }
    Promise.resolve(p).then(function (raw) {
      var seen = Object.create(null);
      var items = (raw || [])
        .filter(function (c) { return c && c.id; })
        .map(function (c) {
          var id = idStr(c.id);
          var name = c.name || c.pushname || c.shortName || c.formattedName || userOf(id);
          return {
            id: id,
            name: name,
            isGroup: isGroupId(id),
            isMy: !!c.isMyContact
          };
        })
        .filter(function (c) {
          if (!c.id || seen[c.id]) { return false; }
          if (/status@broadcast|@broadcast|@newsletter|@lid$/.test(c.id)) { return false; }
          if (!c.name) { return false; }
          seen[c.id] = true;
          return true;
        })
        .sort(function (a, b) {
          if (a.isGroup !== b.isGroup) { return a.isGroup ? 1 : -1; }
          return a.name.localeCompare(b.name);
        });

      listEl.textContent = '';
      if (!items.length) {
        listEl.appendChild(emptyState('No contacts', 'Your address book is empty.'));
        return;
      }
      var frag = document.createDocumentFragment();
      items.slice(0, 400).forEach(function (it) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'wa-row';
        row.appendChild(avatarNode(it.id, it.name, it.isGroup));
        var mid = document.createElement('span');
        mid.className = 'wa-row-mid';
        var top = document.createElement('span');
        top.className = 'wa-row-top';
        var name = document.createElement('span');
        name.className = 'wa-row-name';
        name.textContent = it.name;
        top.appendChild(name);
        mid.appendChild(top);
        var bottom = document.createElement('span');
        bottom.className = 'wa-row-bottom';
        var prev = document.createElement('span');
        prev.className = 'wa-row-prev';
        prev.textContent = it.isGroup ? 'Group' : ('+' + userOf(it.id));
        bottom.appendChild(prev);
        mid.appendChild(bottom);
        row.appendChild(mid);
        row.addEventListener('click', function () { openChat(it.id, it.name, it.isGroup); });
        frag.appendChild(row);
      });
      listEl.appendChild(frag);
    }).catch(function (e) {
      log('contact.list error: ' + e);
      listEl.textContent = '';
      listEl.appendChild(emptyState('Could not load contacts', 'Try again in a moment.'));
    });
  }

  // ---------------------------------------------------------------------
  // long-press + copy
  // ---------------------------------------------------------------------

  function openSheet(text, msg) {
    sheetText = String(text || '');
    sheetMsg = msg || null;
    if (!sheetText.trim()) { return; }
    var preview = $('sheet-preview');
    if (preview) { preview.textContent = sheetText; }
    var replyBtn = $('sheet-reply');
    if (replyBtn) {
      // Only messages the engine already stored can be replied to.
      replyBtn.hidden = !sheetMsg || !sheetMsg.key || /^tmp-/.test(sheetMsg.key);
    }
    var scrim = $('sheet-scrim');
    var sheet = $('sheet');
    if (scrim) { scrim.hidden = false; }
    if (sheet) { sheet.hidden = false; }
  }

  function closeSheet() {
    var scrim = $('sheet-scrim');
    var sheet = $('sheet');
    if (scrim) { scrim.hidden = true; }
    if (sheet) { sheet.hidden = true; }
    sheetText = '';
    sheetMsg = null;
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      ta.remove();
      if (ok) { toast('Copied to clipboard'); closeSheet(); }
      else { toast('Could not copy'); }
      return ok;
    } catch (e) {
      log('copy failed ' + e);
      toast('Could not copy');
      return false;
    }
  }

  function copyText(text) {
    var value = String(text || '');
    if (!value.trim()) { return false; }
    // Native bridge: reliable on Android (no clipboard permissions needed in a WebView).
    try {
      if (window.Android && Android.copyText) {
        Android.copyText(value);
        closeSheet();
        return true;
      }
    } catch (e) {
      log('native copy failed ' + e);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        toast('Copied to clipboard');
        closeSheet();
      }).catch(function () { fallbackCopy(value); });
      return true;
    }
    return fallbackCopy(value);
  }

  /**
   * Long-press (action sheet) + swipe-right (reply) on a message bubble.
   * Both gestures share the pointer sequence: a vertical drag is left to the
   * scroller, a horizontal one is claimed as a swipe, a hold opens the sheet.
   */
  function bindBubbleGestures(el, m) {
    if (!el || !m) { return; }
    var lpTimer = null;
    var startX = 0;
    var startY = 0;
    var dx = 0;
    var dragging = false;
    var swiping = false;

    function cancelHold() {
      if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
    }

    function release(animated) {
      if (!el) { return; }
      if (animated) {
        el.classList.add('wa-swipe-back');
        setTimeout(function () {
          el.classList.remove('wa-swipe-back', 'wa-swiping');
          el.style.transform = '';
        }, 220);
      } else {
        el.classList.remove('wa-swiping', 'wa-swipe-back');
        el.style.transform = '';
      }
    }

    function openActions() {
      var t = m.body || m.text || '';
      if (t) { openSheet(t, m); }
    }

    el.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) { return; }
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      dragging = true;
      swiping = false;
      cancelHold();
      lpTimer = setTimeout(function () {
        lpTimer = null;
        dragging = false;
        swiping = false;
        release(false);
        openActions();
      }, 480);
    });

    el.addEventListener('pointermove', function (e) {
      if (!dragging) { return; }
      var mx = e.clientX - startX;
      var my = e.clientY - startY;
      if (!swiping) {
        if (Math.abs(my) > 12 && Math.abs(my) >= Math.abs(mx)) {
          dragging = false;
          cancelHold();
          return;
        }
        if (mx > 12 && Math.abs(mx) > Math.abs(my)) {
          swiping = true;
          cancelHold();
          el.classList.add('wa-swiping');
          try { el.setPointerCapture(e.pointerId); } catch (err) {}
        }
      }
      if (swiping) {
        dx = Math.max(0, Math.min(mx, 120));
        el.style.transform = 'translateX(' + dx + 'px)';
      }
    });

    function finish() {
      cancelHold();
      if (swiping) {
        var trigger = dx >= 60;
        swiping = false;
        dragging = false;
        release(true);
        if (trigger) { setReplyTarget(m); }
        return;
      }
      dragging = false;
    }

    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      el.addEventListener(ev, finish);
    });

    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      cancelHold();
      openActions();
    });
  }

  // ---------------------------------------------------------------------
  // status updates (last 24h, from the engine's StatusV3 collection)
  // ---------------------------------------------------------------------

  function myWidStr() {
    if (meWid) { return meWid; }
    try {
      var conn = wpp() && wpp().conn;
      if (conn && typeof conn.getMyUserId === 'function') {
        var id = conn.getMyUserId();
        if (id) { meWid = idStr(id); }
      }
    } catch (e) {}
    return meWid;
  }

  function contactNameOf(id) {
    if (!id) { return ''; }
    var store = waStore();
    var cs = store && store.ContactStore;
    function nameOf(model) {
      if (!model) { return ''; }
      return model.name || model.pushname || model.shortName || model.formattedName || '';
    }
    try {
      if (cs && typeof cs.get === 'function') {
        var direct = nameOf(cs.get(id));
        if (direct) { return direct; }
      }
    } catch (e) {}
    var chat = chatById[id];
    if (chat && chat.name) { return chat.name; }
    try {
      if (cs && typeof cs.getModelsArray === 'function') {
        var arr = cs.getModelsArray() || [];
        var u = userOf(id);
        for (var i = 0; i < arr.length; i++) {
          var cand = idStr(arr[i] && arr[i].id);
          if (cand && userOf(cand) === u) {
            var found = nameOf(arr[i]);
            if (found) { return found; }
          }
        }
      }
    } catch (e2) {}
    return userOf(id) || 'Unknown';
  }

  function statusTimeMs(m) {
    var t = Number((m && (m.t || m.timestamp)) || 0);
    if (t && t < 1e12) { t = t * 1000; }
    return t;
  }

  function isFreshStatus(m) {
    var t = statusTimeMs(m);
    return !!t && (Date.now() - t) <= STATUS_TTL * 1000;
  }

  function collectStatusEntries() {
    var out = [];
    var seen = Object.create(null);
    var store = waStore();
    var v3 = store && store.StatusV3Store;
    if (!v3 || typeof v3.getModelsArray !== 'function') { return out; }
    var models = [];
    try { models = v3.getModelsArray() || []; } catch (e) { return out; }
    var mine = myWidStr();
    models.forEach(function (entry) {
      try {
        if (!entry || !entry.id) { return; }
        var id = idStr(entry.id);
        if (!id || seen[id]) { return; }
        var msgs = [];
        var col = entry.msgs;
        if (col) {
          if (typeof col.getModelsArray === 'function') { msgs = col.getModelsArray() || []; }
          else if (Array.isArray(col.models)) { msgs = col.models; }
        }
        var fresh = msgs.filter(isFreshStatus);
        if (!fresh.length) { return; }
        fresh.sort(function (a, b) { return statusTimeMs(b) - statusTimeMs(a); });
        seen[id] = true;
        out.push({
          id: id,
          name: contactNameOf(id),
          me: !!(mine && userOf(id) === userOf(mine)),
          msgs: fresh.slice(0, 20)
        });
      } catch (e2) { log('status entry failed: ' + e2); }
    });
    return out;
  }

  function sortStatusEntries(list) {
    list.sort(function (a, b) {
      if (a.me !== b.me) { return a.me ? -1 : 1; }
      return statusTimeMs(b.msgs[0]) - statusTimeMs(a.msgs[0]);
    });
    return list;
  }

  /** Loads contacts' statuses; falls back to the status@broadcast chat. */
  function loadStatuses() {
    var entries = sortStatusEntries(collectStatusEntries());
    if (entries.length) {
      statusData = entries;
      updateStatusRow();
      if (view === 'status') { renderStatusList(); }
      return Promise.resolve(entries);
    }
    var api = chatApi();
    if (!api || typeof api.getMessages !== 'function') {
      statusData = [];
      updateStatusRow();
      return Promise.resolve([]);
    }
    return Promise.resolve()
      .then(function () { return api.getMessages('status@broadcast', { count: 60 }); })
      .then(function (raw) {
        var byAuthor = Object.create(null);
        asMessageArray(raw).forEach(function (m) {
          try {
            var a = idStr(m && m.author) || '';
            if (!a || !isFreshStatus(m)) { return; }
            (byAuthor[a] = byAuthor[a] || []).push(m);
          } catch (e) {}
        });
        var mine = myWidStr();
        var out = Object.keys(byAuthor).map(function (a) {
          byAuthor[a].sort(function (x, y) { return statusTimeMs(y) - statusTimeMs(x); });
          return {
            id: a,
            name: contactNameOf(a),
            me: !!(mine && userOf(a) === userOf(mine)),
            msgs: byAuthor[a].slice(0, 20)
          };
        });
        statusData = sortStatusEntries(out);
        updateStatusRow();
        if (view === 'status') { renderStatusList(); }
        return statusData;
      })
      .catch(function (e) {
        log('status load failed: ' + e);
        statusData = [];
        updateStatusRow();
        return [];
      });
  }

  function unseenStatusCount() {
    var n = 0;
    for (var i = 0; i < statusData.length; i++) {
      if (!statusSeen[statusData[i].id]) { n++; }
    }
    return n;
  }

  function updateStatusRow() {
    var total = statusData.length;
    var unseen = unseenStatusCount();
    var sub = $('status-row-sub');
    if (sub) {
      if (!total) { sub.textContent = 'No recent updates'; }
      else if (unseen) { sub.textContent = unseen + (unseen === 1 ? ' new update' : ' new updates'); }
      else { sub.textContent = 'All updates viewed'; }
    }
    var ring = $('status-ring');
    if (ring) { ring.setAttribute('data-empty', unseen ? '0' : '1'); }
    var av = $('status-row-avatar');
    if (av && !av.getAttribute('data-init')) {
      av.setAttribute('data-init', '1');
      av.textContent = '+';
      var mine = myWidStr();
      if (mine) { attachAvatar(av, mine); }
    }
  }

  function renderStatusList() {
    var listEl = $('status-list');
    if (!listEl) { return; }
    listEl.textContent = '';
    if (!statusData.length) {
      listEl.appendChild(emptyState(
        'No status updates',
        'None of your contacts posted a status in the last 24 hours.'));
      return;
    }
    var frag = document.createDocumentFragment();
    statusData.forEach(function (entry, gi) {
      var latest = entry.msgs[0] || {};
      var seen = !!statusSeen[entry.id];
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'wa-row';

      var ring = document.createElement('span');
      ring.className = 'wa-statusrow-ring';
      if (seen) { ring.setAttribute('data-empty', '1'); }
      var av = document.createElement('span');
      av.className = 'wa-avatar';
      av.style.backgroundColor = avatarColor(entry.id);
      av.textContent = initialOf(entry.name);
      ring.appendChild(av);
      attachAvatar(av, entry.id);
      row.appendChild(ring);

      var mid = document.createElement('span');
      mid.className = 'wa-row-mid';
      var top = document.createElement('span');
      top.className = 'wa-row-top';
      var name = document.createElement('span');
      name.className = 'wa-row-name';
      name.textContent = entry.me ? 'My status' : entry.name;
      top.appendChild(name);
      var time = document.createElement('span');
      time.className = 'wa-row-time';
      time.textContent = fmtTime(statusTimeMs(latest));
      top.appendChild(time);
      var bottom = document.createElement('span');
      bottom.className = 'wa-row-bottom';
      var prev = document.createElement('span');
      prev.className = 'wa-row-prev';
      var prevText = document.createElement('span');
      prevText.className = 'wa-row-prev-text';
      prevText.textContent = previewOf(latest) || 'Status';
      prev.appendChild(prevText);
      bottom.appendChild(prev);
      mid.appendChild(top);
      mid.appendChild(bottom);
      row.appendChild(mid);

      row.addEventListener('click', function () { openStatusViewer(gi); });
      frag.appendChild(row);
    });
    listEl.appendChild(frag);
  }

  // ------------------------------ viewer ------------------------------

  function stopViewerTimer() {
    if (viewerState.timer) {
      clearTimeout(viewerState.timer);
      viewerState.timer = null;
    }
  }

  function openStatusViewer(gi) {
    var entry = statusData[gi];
    if (!entry || !entry.msgs || !entry.msgs.length) { return; }
    viewerState.entries = statusData;
    viewerState.gi = gi;
    viewerState.mi = 0;
    viewerState.running = true;
    var viewer = $('status-viewer');
    if (viewer) { viewer.hidden = false; }
    renderStatusViewer();
  }

  function closeStatusViewer() {
    stopViewerTimer();
    viewerState.running = false;
    viewerState.entries = [];
    var viewer = $('status-viewer');
    if (viewer) { viewer.hidden = true; }
    var stage = $('viewer-stage');
    if (stage) { stage.textContent = ''; stage.__key = ''; }
    if (view === 'status') { renderStatusList(); }
    updateStatusRow();
  }

  function nextStatusItem() {
    var entry = viewerState.entries[viewerState.gi];
    if (!entry) { closeStatusViewer(); return; }
    if (viewerState.mi + 1 < entry.msgs.length) {
      viewerState.mi++;
      renderStatusViewer();
      return;
    }
    nextStatusEntry();
  }

  function nextStatusEntry() {
    if (viewerState.gi + 1 < viewerState.entries.length) {
      viewerState.gi++;
      viewerState.mi = 0;
      renderStatusViewer();
      return;
    }
    closeStatusViewer();
  }

  function prevStatusItem() {
    if (viewerState.mi > 0) {
      viewerState.mi--;
    } else if (viewerState.gi > 0) {
      viewerState.gi--;
      var prev = viewerState.entries[viewerState.gi];
      viewerState.mi = prev && prev.msgs ? Math.max(0, prev.msgs.length - 1) : 0;
    } else {
      viewerState.mi = 0;
    }
    renderStatusViewer();
  }

  function markStatusRead(entry, msg) {
    try {
      var st = wpp() && wpp().status;
      if (st && typeof st.sendReadStatus === 'function' && entry && entry.id && msg && msg.id) {
        Promise.resolve(st.sendReadStatus(entry.id, idStr(msg.id))).catch(function () {});
      }
    } catch (e) {}
  }

  function renderStatusViewer() {
    stopViewerTimer();
    var entry = viewerState.entries[viewerState.gi];
    if (!entry || !entry.msgs || !entry.msgs.length || viewerState.mi >= entry.msgs.length) {
      closeStatusViewer();
      return;
    }
    var msg = entry.msgs[viewerState.mi];

    var nameEl = $('viewer-name');
    if (nameEl) { nameEl.textContent = entry.me ? 'My status' : entry.name; }
    var timeEl = $('viewer-time');
    if (timeEl) { timeEl.textContent = fmtTime(statusTimeMs(msg)); }
    var av = $('viewer-avatar');
    if (av) {
      av.style.backgroundColor = avatarColor(entry.id);
      var init = $('viewer-avatar-initial');
      if (init) { init.textContent = initialOf(entry.name); }
      attachAvatar(av, entry.id);
    }

    var bars = $('viewer-bars');
    if (bars) {
      bars.textContent = '';
      for (var i = 0; i < entry.msgs.length; i++) {
        var bar = document.createElement('div');
        bar.className = 'wa-viewer-bar' +
          (i < viewerState.mi ? ' wa-done' : (i === viewerState.mi ? ' wa-active' : ''));
        bar.appendChild(document.createElement('span'));
        bars.appendChild(bar);
      }
      var activeBar = bars.children[viewerState.mi];
      if (activeBar && activeBar.firstChild) {
        var fill = activeBar.firstChild;
        fill.style.transition = 'none';
        fill.style.width = '0';
        void fill.offsetWidth;
        fill.style.transition = 'width ' + viewerState.dur + 'ms linear';
        fill.style.width = '100%';
      }
    }

    var stage = $('viewer-stage');
    if (stage) {
      stage.textContent = '';
      stage.__key = idStr(msg.id) || ('st-' + viewerState.gi + '-' + viewerState.mi);
      renderStatusBody(msg, stage);
    }

    statusSeen[entry.id] = true;
    markStatusRead(entry, msg);

    viewerState.running = true;
    viewerState.timer = setTimeout(function () {
      viewerState.timer = null;
      nextStatusItem();
    }, viewerState.dur);
  }

  function renderStatusBody(msg, stage) {
    var body = String(msg.body || msg.caption || '');
    var type = String(msg.type || '');
    var wantsMedia = /image|video|gif|sticker|ptt|audio|document|media/i.test(type) ||
      (!body && !!(msg.mediaData || msg.mediaKey));

    if (wantsMedia) {
      showStatusMedia(msg, stage, body);
      return;
    }
    if (body) {
      var t = document.createElement('div');
      t.className = 'wa-viewer-text';
      t.textContent = body;
      stage.appendChild(t);
      return;
    }
    var note = document.createElement('div');
    note.className = 'wa-viewer-note';
    note.textContent = 'This status cannot be shown here.\nOpen WhatsApp Web to view it.';
    stage.appendChild(note);
  }

  function showStatusMedia(msg, stage, caption) {
    var key = idStr(msg.id) || '';
    var ownKey = stage.__key;
    var current = function () { return stage.__key === ownKey; };

    function note(text) {
      if (!current()) { return; }
      stage.textContent = '';
      var n = document.createElement('div');
      n.className = 'wa-viewer-note';
      n.textContent = text;
      stage.appendChild(n);
    }

    function mount(url) {
      if (!current()) { return; }
      stage.textContent = '';
      var mime = String((msg.mimetype || (msg.mediaData && msg.mediaData.mimetype) || '') + '');
      var isVideo = /^video\//.test(mime) || /video/i.test(String(msg.type || ''));
      var el;
      if (isVideo) {
        el = document.createElement('video');
        el.autoplay = true;
        el.muted = true;
        el.playsInline = true;
        el.setAttribute('controls', 'controls');
      } else {
        el = document.createElement('img');
      }
      el.src = url;
      el.onerror = function () {
        note((caption ? caption + '\n\n' : '') + 'Media unavailable. Open WhatsApp Web to view it.');
      };
      stage.appendChild(el);
      if (caption) {
        var c = document.createElement('div');
        c.className = 'wa-viewer-note';
        c.textContent = caption;
        stage.appendChild(c);
      }
    }

    if (key && statusMedia[key]) {
      mount(statusMedia[key]);
      return;
    }
    var api = chatApi();
    if (!api || typeof api.downloadMedia !== 'function' || !key) {
      note('Media unavailable. Open WhatsApp Web to view it.');
      return;
    }
    var spinner = document.createElement('div');
    spinner.className = 'wa-viewer-note';
    spinner.textContent = 'Loading status…';
    stage.appendChild(spinner);

    Promise.resolve()
      .then(function () { return api.downloadMedia(key); })
      .then(function (blob) {
        if (!blob) { note('Media unavailable. Open WhatsApp Web to view it.'); return; }
        var url;
        try { url = URL.createObjectURL(blob); } catch (e) { url = null; }
        if (!url) { note('Media unavailable. Open WhatsApp Web to view it.'); return; }
        statusMedia[key] = url;
        mount(url);
      })
      .catch(function () {
        note('Media unavailable. Open WhatsApp Web to view it.');
      });
  }

  // ---------------------------------------------------------------------
  // settings + contact info
  // ---------------------------------------------------------------------

  function loadMyProfile() {
    var w = wpp();
    var name = 'Me';
    try {
      if (w && w.profile && typeof w.profile.getMyProfileName === 'function') {
        var n = w.profile.getMyProfileName();
        if (n) { name = String(n); }
      }
    } catch (e) {}

    var wid = myWidStr() || '';
    var phone = wid ? ('+' + userOf(wid)) : '';

    var nameEl = $('me-name');
    if (nameEl) { nameEl.textContent = name; }
    var phoneEl = $('me-phone');
    if (phoneEl) {
      if (phone) { phoneEl.textContent = phone; phoneEl.hidden = false; }
      else { phoneEl.hidden = true; }
    }
    var avatar = $('me-avatar');
    if (avatar) {
      avatar.style.backgroundColor = avatarColor(phone || name);
      var init = $('me-avatar-initial');
      if (init) { init.textContent = initialOf(name); }
      if (wid) { attachAvatar(avatar, wid); }
    }

    var aboutEl = $('me-about');
    if (w && w.profile && typeof w.profile.getMyStatus === 'function') {
      Promise.resolve()
        .then(function () { return w.profile.getMyStatus(); })
        .then(function (st) {
          var text = (typeof st === 'string') ? st : ((st && (st.status || st.text)) || '');
          if (text && aboutEl) { aboutEl.textContent = String(text); }
        })
        .catch(function () {});
    }

    if (w && w.profile && typeof w.profile.getMyProfilePicture === 'function') {
      Promise.resolve()
        .then(function () { return w.profile.getMyProfilePicture(); })
        .then(function (pic) {
          var url = (typeof pic === 'string') ? pic : ((pic && (pic.eurl || pic.url)) || '');
          if (!url || !/^(https?:|blob:|data:)/.test(url)) { return; }
          var node = $('me-avatar');
          if (node) { setAvatarImg(node, url); }
        })
        .catch(function () {});
    }

    var about = $('settings-about');
    if (about && w && w.version) {
      about.textContent = 'WhatsApp Hybrid · wa-js ' + w.version;
    }
  }

  function infoRow(label, valueText) {
    var block = document.createElement('div');
    block.className = 'wa-info-block';
    var lbl = document.createElement('div');
    lbl.className = 'wa-info-label';
    lbl.textContent = label;
    var val = document.createElement('div');
    val.className = 'wa-info-value';
    val.textContent = valueText;
    block.appendChild(lbl);
    block.appendChild(val);
    return { block: block, value: val };
  }

  function loadAbout(id, node) {
    var api = contactApi();
    if (!api || typeof api.getStatus !== 'function') {
      node.textContent = 'Not available';
      return;
    }
    Promise.resolve()
      .then(function () { return api.getStatus(id); })
      .then(function (st) {
        var text = (typeof st === 'string') ? st : ((st && (st.status || st.text)) || '');
        node.textContent = text || 'No status set';
      })
      .catch(function () { node.textContent = 'Not available'; });
  }

  function loadMembers(groupId, block) {
    var g = wpp() && wpp().group;
    if (!g || typeof g.getParticipants !== 'function') { return; }
    Promise.resolve()
      .then(function () { return g.getParticipants(groupId); })
      .then(function (parts) {
        var arr = Array.isArray(parts) ? parts : [];
        if (!arr.length) {
          var v = block.querySelector('.wa-info-value');
          if (v) { v.textContent = 'Members unavailable'; }
          return;
        }
        var v2 = block.querySelector('.wa-info-value');
        if (v2) { v2.textContent = arr.length + (arr.length === 1 ? ' participant' : ' participants'); }
        arr.slice(0, 120).forEach(function (p) {
          try {
            var pid = idStr(p && (p.id || p.wid)) || '';
            if (!pid) { return; }
            var row = document.createElement('div');
            row.className = 'wa-member';
            var av = document.createElement('span');
            av.className = 'wa-avatar wa-avatar-sm';
            var nm = contactNameOf(pid);
            av.style.backgroundColor = avatarColor(pid);
            av.textContent = initialOf(nm);
            attachAvatar(av, pid);
            row.appendChild(av);
            var txt = document.createElement('span');
            txt.style.minWidth = '0';
            var n1 = document.createElement('div');
            n1.className = 'wa-member-name';
            n1.textContent = nm;
            txt.appendChild(n1);
            var n2 = document.createElement('div');
            n2.className = 'wa-member-sub';
            n2.textContent = (p.isAdmin || p.isSuperAdmin) ? 'Admin' : ('+' + userOf(pid));
            txt.appendChild(n2);
            row.appendChild(txt);
            block.appendChild(row);
          } catch (e) {}
        });
      })
      .catch(function () {
        var v = block.querySelector('.wa-info-value');
        if (v) { v.textContent = 'Members unavailable'; }
      });
  }

  function renderInfo(c) {
    var body = $('info-body');
    if (!body || !c) { return; }
    body.textContent = '';

    var hero = document.createElement('div');
    hero.className = 'wa-info-hero';
    var av = avatarNode(c.id, c.name, c.isGroup);
    av.classList.add('wa-avatar-lg');
    hero.appendChild(av);
    var nm = document.createElement('div');
    nm.className = 'wa-info-name';
    nm.textContent = c.name;
    hero.appendChild(nm);
    var sub = document.createElement('div');
    sub.className = 'wa-info-sub';
    sub.textContent = c.isGroup ? 'Group' : ('+' + (c.user || ''));
    hero.appendChild(sub);
    body.appendChild(hero);

    if (c.isGroup) {
      var members = infoRow('Participants', 'Loading…');
      body.appendChild(members.block);
      loadMembers(c.id, members.block);
    } else {
      var phoneRow = infoRow('Phone', c.user ? ('+' + c.user) : 'Unknown');
      body.appendChild(phoneRow.block);
    }

    var aboutRow = infoRow('About', 'Loading…');
    body.appendChild(aboutRow.block);
    loadAbout(c.id, aboutRow.value);

    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'wa-retry';
    back.style.display = 'block';
    back.style.margin = '16px auto 4px';
    back.textContent = 'Back to chat';
    back.addEventListener('click', function () { backFromInfo(); });
    body.appendChild(back);
  }

  // ---------------------------------------------------------------------
  // chrome <-> bridge
  // ---------------------------------------------------------------------

  function setUiState(state) {
    try {
      if (window.Android && Android.onUiState) { Android.onUiState(state); }
    } catch (e) {}
  }

  function openMenu() {
    var scrim = $('menu-scrim');
    var menu = $('menu');
    if (scrim) { scrim.hidden = false; }
    if (menu) { menu.hidden = false; }
  }

  function closeMenu() {
    var scrim = $('menu-scrim');
    var menu = $('menu');
    if (scrim) { scrim.hidden = true; }
    if (menu) { menu.hidden = true; }
  }

  /** Hand the screen back to the official WhatsApp Web UI (settings, profile, ...). */
  function openOfficialUi() {
    try {
      if (window.Android && Android.openOfficialUi) { Android.openOfficialUi(); return true; }
    } catch (e) { log('openOfficialUi failed: ' + e); }
    toast('The official page is not available right now');
    return false;
  }

  /** Single back handler: sheet -> viewer -> sub-pane -> chat -> let the OS handle it. */
  function handleBackAction() {
    var viewer = $('status-viewer');
    if (viewer && !viewer.hidden) { closeStatusViewer(); return true; }
    var sheet = $('sheet');
    if (sheet && !sheet.hidden) { closeSheet(); return true; }
    var menu = $('menu');
    if (menu && !menu.hidden) { closeMenu(); return true; }
    if (view === 'info') { return backFromInfo(); }
    if (view === 'contacts' || view === 'settings' || view === 'status') { showList(); return true; }
    if (view === 'chat') { closeChat(); return true; }
    return false;
  }

  function on(el, handler) {
    if (el && typeof handler === 'function') {
      el.addEventListener('click', handler);
    }
  }

  function bindUi() {
    on($('btn-back'), function () { handleBackAction(); });

    on($('btn-refresh'), function () {
      if (view === 'status') {
        toast('Refreshing…', 900);
        loadStatuses();
        return;
      }
      // No engine at all -> reload the page instead of refreshing an empty list.
      if (!chatApi()) {
        toast('Reloading WhatsApp…', 1200);
        reloadPage();
        return;
      }
      toast('Refreshing…', 900);
      loadChats();
    });

    on($('btn-new-chat'), showContacts);
    on($('btn-menu'), openMenu);
    on($('btn-info'), function () { if (view === 'chat') { showInfo(); } });
    on($('btn-status'), showStatus);

    // menu sheet
    on($('menu-scrim'), closeMenu);
    on($('menu-close'), closeMenu);
    on($('menu-status'), function () { closeMenu(); showStatus(); });
    on($('menu-newchat'), function () { closeMenu(); showContacts(); });
    on($('menu-settings'), function () { closeMenu(); showSettings(); });
    on($('menu-official'), function () { closeMenu(); openOfficialUi(); });
    on($('btn-official'), openOfficialUi);

    // reply
    on($('btn-reply-cancel'), clearReply);
    on($('sheet-reply'), function () {
      var m = sheetMsg;
      closeSheet();
      if (m) { setReplyTarget(m); }
    });

    // theme chips
    Array.prototype.forEach.call(
      document.querySelectorAll('#theme-chips .wa-chip'),
      function (chip) {
        on(chip, function () {
          var v = chip.getAttribute('data-theme');
          if (v !== 'light' && v !== 'dark' && v !== 'system') { return; }
          themePref = v;
          storeSet(THEME_KEY, v);
          applyTheme();
        });
      }
    );
    Array.prototype.forEach.call(
      document.querySelectorAll('#wall-chips .wa-chip'),
      function (chip) {
        on(chip, function () {
          var v = chip.getAttribute('data-wall');
          if (v !== 'default' && v !== 'bright' && v !== 'dim' && v !== 'mono') { return; }
          wallPref = v;
          storeSet(WALL_KEY, v);
          applyTheme();
        });
      }
    );

    // status viewer
    on($('btn-viewer-close'), closeStatusViewer);
    on($('viewer-prev'), prevStatusItem);
    on($('viewer-next'), nextStatusItem);

    on($('btn-search'), function () {
      var wrap = $('searchwrap');
      if (!wrap) { return; }
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) {
        var input = $('search-input');
        if (input) { input.focus(); }
      } else {
        filterText = '';
        if ($('search-input')) { $('search-input').value = ''; }
        renderList();
      }
    });

    on($('btn-search-close'), function () {
      if ($('searchwrap')) { $('searchwrap').hidden = true; }
      filterText = '';
      if ($('search-input')) { $('search-input').value = ''; }
      renderList();
    });

    on($('search-input'), function (e) {
      filterText = (e.target && e.target.value) || '';
      renderList();
    });

    on($('btn-send'), sendMessage);

    var input = $('msg-input');
    if (input && input.addEventListener) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });
      input.addEventListener('focus', function () {
        setTimeout(scrollToEnd, 260);
      });
    }

    var msgs = $('messages');
    if (msgs) {
      msgs.addEventListener('scroll', function () {
        var btn = $('btn-scroll-down');
        if (btn) { btn.hidden = nearBottom(); }
      }, { passive: true });
    }
    on($('btn-scroll-down'), scrollToEnd);

    on($('sheet-scrim'), closeSheet);
    on($('sheet-cancel'), closeSheet);
    on($('sheet-copy'), function () { copyText(sheetText); });

    // Shrink the fixed overlay only when an on-screen keyboard really covers it.
    // (The activity uses adjustResize, so normally the WebView is resized already;
    // applying the viewport metrics unconditionally used to leave a zero-height,
    // i.e. blank, overlay on some devices.)
    if (window.visualViewport) {
      var vv = window.visualViewport;
      var adjust = function () {
        var root = document.getElementById('wv-root');
        if (!root) { return; }
        var inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        if (inset > 120) {
          root.style.top = vv.offsetTop + 'px';
          root.style.height = vv.height + 'px';
        } else {
          root.style.top = '';
          root.style.height = '';
        }
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
    var rootEl = document.getElementById('wv-root');
    if (rootEl) { rootEl.setAttribute('data-bound', '1'); }
    initTheme();
    bindUi();
    showList();
    (function tryLoad() {
      loadAttempts++;
      var api = chatApi();
      if (!api || typeof api.list !== 'function') {
        if (loadAttempts <= 60) {
          setTimeout(tryLoad, 1200);
        } else {
          toast('Could not reach the WhatsApp engine. Tap ↻ to reload.', 5000);
        }
        return;
      }
      subscribe();
      loadChats().then(function () { loadStatuses(); });
    })();
  }

  /**
   * Kotlin rebuilt #wv-root (the old nodes took their listeners with them): bind this
   * still-alive UI to the fresh DOM exactly once.
   */
  function remount() {
    var rootEl = document.getElementById('wv-root');
    if (!rootEl || rootEl.getAttribute('data-bound') === '1') { return false; }
    if (!$('chat-list') || !$('msg-input')) { return false; }
    rootEl.setAttribute('data-bound', '1');
    initTheme();
    bindUi();
    showList();
    if (chatApi()) {
      loadChats();
      loadStatuses();
    }
    return true;
  }

  // Public handles usable from Kotlin via evaluateJavascript.
  window.CustomUI = {
    refresh: function () { return loadChats(); },
    remount: function () { return remount(); },
    closeChat: function () { return closeChat(); },
    openChat: function (id) { openChat(String(id || '')); },
    isOpen: function () { return view === 'chat'; },
    onCopied: function () { closeSheet(); toast('Copied to clipboard'); },
    /** Hardware back: sheet -> status viewer -> sub-pane -> chat -> let the OS handle it. */
    handleBack: function () { return handleBackAction(); },
    /** Kotlin hands the screen back to us after the official WhatsApp Web UI. */
    resume: function () {
      applyTheme();
      if (view === 'chat' && openChatId) {
        setUiState('chat');
      } else if (view === 'list') {
        setUiState('list');
        renderList();
      } else {
        setUiState(view === 'chat' ? 'chat' : (view === 'list' ? 'list' : 'pane'));
      }
      loadChats();
      loadStatuses();
      return true;
    },
    openOfficial: function () { return openOfficialUi(); }
  };

  setUiState('list');
  init();
  log('custom UI booted');
})();

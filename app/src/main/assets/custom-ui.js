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

  function chatApi() {
    var w = wpp();
    return (w && w.chat) ? w.chat : null;
  }

  function contactApi() {
    var w = wpp();
    return (w && w.contact) ? w.contact : null;
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
  var locallyRead = Object.create(null); // id -> true while the engine still reports unread
  var sheetText = '';
  var view = 'list'; // 'list' | 'chat' | 'contacts'

  var avatarCache = Object.create(null);   // id -> url | null | 'pending'
  var avatarWaiters = Object.create(null); // id -> [nodes]

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
    setHeader({ title: 'WhatsApp', back: false, search: true, refresh: true });
    setUiState('list');
    renderList();
  }

  function showContacts() {
    view = 'contacts';
    if ($('list-pane')) { $('list-pane').hidden = true; }
    if ($('chat-pane')) { $('chat-pane').hidden = true; }
    if ($('contacts-pane')) { $('contacts-pane').hidden = false; }
    if ($('searchwrap')) { $('searchwrap').hidden = true; }
    setHeader({ title: 'New chat', back: true, search: false, refresh: false });
    loadContacts();
  }

  function showChatHeader(c) {
    setHeader({
      title: c.name,
      sub: c.isGroup ? 'Group' : ('+' + c.user),
      back: true,
      search: false,
      refresh: false,
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

  function loadMessages(id) {
    var api = chatApi();
    var msgsEl = $('messages');
    if (!msgsEl) { return; }
    if (!api || typeof api.getMessages !== 'function') {
      msgsEl.textContent = '';
      msgsEl.appendChild(emptyState('Not ready yet', 'The WhatsApp engine is still starting.'));
      toast('Messaging API unavailable');
      return;
    }
    var p;
    try {
      p = api.getMessages(id, { count: 40 });
    } catch (e) {
      // chat_not_found: a brand-new conversation simply has no history yet.
      handleLoadError(id, e);
      return;
    }
    Promise.resolve(p).then(function (raw) {
      if (openChatId !== id) { return; }
      seenMsgKeys = Object.create(null);
      msgsEl.textContent = '';
      msgsEl.removeAttribute('data-day');
      var msgs = (raw || []).map(normalizeMsg).filter(function (m) { return !!m.body || !!m.text; });
      msgs.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      if (!msgs.length) {
        msgsEl.appendChild(emptyState('No messages yet', 'Say hello 👋'));
      } else {
        msgs.forEach(function (m) { appendBubble(m, false); });
      }
      scrollToEnd();
    }).catch(function (e) {
      if (openChatId !== id) { return; }
      handleLoadError(id, e);
    });
  }

  function handleLoadError(id, e) {
    log('getMessages error: ' + e);
    if (openChatId !== id) { return; }
    var msgsEl = $('messages');
    if (!msgsEl) { return; }
    msgsEl.textContent = '';
    var msg = String((e && e.message) || e || '');
    if (/not\s*found/i.test(msg) || /chat_not_found/i.test(msg)) {
      msgsEl.appendChild(emptyState('No messages yet', 'Say hello 👋'));
    } else {
      msgsEl.appendChild(emptyState('Could not load messages', 'Tap the conversation again to retry.'));
    }
  }

  function tickFor(m) {
    if (m.failed) { return null; }
    if (m.ack === undefined) { return icon('tick'); }
    if (m.ack === 0) { return icon('clock'); }
    if (m.ack >= 3) { return icon('tick2', 'wa-tick-read'); }
    if (m.ack >= 2) { return icon('tick2'); }
    return icon('tick');
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

    bindLongPress(wrap, function () { return m.body || m.text || ''; });

    msgsEl.appendChild(wrap);
    return wrap;
  }

  function scrollToEnd() {
    var msgsEl = $('messages');
    if (msgsEl) { msgsEl.scrollTop = msgsEl.scrollHeight; }
    if ($('btn-scroll-down')) { $('btn-scroll-down').hidden = true; }
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

    var chatId = openChatId;
    input.value = '';

    var now = Math.floor(Date.now() / 1000);
    var tmpMsg = {
      key: 'tmp-' + now + '-' + text.length,
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

    var pending = { chatId: chatId, text: text, node: node };
    pendingSends.push(pending);

    var p;
    try {
      p = api.sendTextMessage(chatId, text);
    } catch (e) {
      log('sendTextMessage threw: ' + e);
      failPending(pending, text);
      return;
    }
    Promise.resolve(p).then(function () {
      var c = chatById[chatId];
      if (c) {
        c.preview = text;
        c.ts = Math.floor(Date.now() / 1000);
        c.lastFromMe = true;
      }
      scheduleSoftRefresh();
    }).catch(function (e) {
      log('sendTextMessage error: ' + e);
      toast('Message not sent');
      failPending(pending, text);
    });
  }

  function failPending(pending, text) {
    var i = pendingSends.indexOf(pending);
    if (i >= 0) { pendingSends.splice(i, 1); }
    var node = pending.node;
    if (node && node.isConnected) {
      node.classList.add('wa-failed');
      var tick = node.querySelector('.wa-tick');
      if (tick) { tick.remove(); }
    }
    var input = $('msg-input');
    if (input && !input.value) { input.value = text; }
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

  function settlePending(cid, m) {
    if (!m.fromMe) { return; }
    for (var i = 0; i < pendingSends.length; i++) {
      var p = pendingSends[i];
      if (p.chatId === cid && p.text === m.body) {
        pendingSends.splice(i, 1);
        if (p.node && p.node.isConnected) { p.node.remove(); }
        return;
      }
    }
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

  function openSheet(text) {
    sheetText = String(text || '');
    if (!sheetText.trim()) { return; }
    var preview = $('sheet-preview');
    if (preview) { preview.textContent = sheetText; }
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

  function bindLongPress(el, textGetter) {
    var timer = null;
    var sx = 0;
    var sy = 0;

    function cancel() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    el.addEventListener('pointerdown', function (e) {
      if (e.button && e.button !== 0) { return; }
      sx = e.clientX; sy = e.clientY;
      cancel();
      timer = setTimeout(function () {
        timer = null;
        var t = textGetter();
        if (t) { openSheet(t); }
      }, 480);
    });
    el.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) { cancel(); }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      el.addEventListener(ev, cancel);
    });
    el.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      cancel();
      var t = textGetter();
      if (t) { openSheet(t); }
    });
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
    $('btn-back').addEventListener('click', function () {
      if (view === 'chat') { closeChat(); }
      else if (view === 'contacts') { showList(); }
    });

    $('btn-refresh').addEventListener('click', function () {
      toast('Refreshing…', 900);
      loadChats();
    });

    $('btn-new-chat').addEventListener('click', showContacts);

    $('btn-search').addEventListener('click', function () {
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

    $('btn-search-close').addEventListener('click', function () {
      if ($('searchwrap')) { $('searchwrap').hidden = true; }
      filterText = '';
      if ($('search-input')) { $('search-input').value = ''; }
      renderList();
    });

    $('search-input').addEventListener('input', function (e) {
      filterText = (e.target && e.target.value) || '';
      renderList();
    });

    $('btn-send').addEventListener('click', sendMessage);

    $('msg-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    $('msg-input').addEventListener('focus', function () {
      setTimeout(scrollToEnd, 260);
    });

    var msgs = $('messages');
    if (msgs) {
      msgs.addEventListener('scroll', function () {
        var btn = $('btn-scroll-down');
        if (btn) { btn.hidden = nearBottom(); }
      }, { passive: true });
    }
    $('btn-scroll-down').addEventListener('click', scrollToEnd);

    $('sheet-scrim').addEventListener('click', closeSheet);
    $('sheet-cancel').addEventListener('click', closeSheet);
    $('sheet-copy').addEventListener('click', function () { copyText(sheetText); });

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
    showList();
    (function tryLoad() {
      loadAttempts++;
      var api = chatApi();
      if (!api || typeof api.list !== 'function') {
        if (loadAttempts <= 60) {
          setTimeout(tryLoad, 1200);
        } else {
          toast('Could not reach the WhatsApp engine. Tap ↻ to retry.', 4000);
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
    isOpen: function () { return view === 'chat'; },
    onCopied: function () { closeSheet(); toast('Copied to clipboard'); },
    /** Hardware back: close sheet -> leave contacts -> leave chat -> let the OS handle it. */
    handleBack: function () {
      var sheet = document.getElementById('sheet');
      if (sheet && !sheet.hidden) { closeSheet(); return true; }
      if (view === 'contacts') { showList(); return true; }
      if (view === 'chat') { closeChat(); return true; }
      return false;
    }
  };

  setUiState('list');
  init();
  log('custom UI booted');
})();

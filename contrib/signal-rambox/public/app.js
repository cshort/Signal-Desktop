// Copyright 2026 Mike Simone
// SPDX-License-Identifier: AGPL-3.0-only

// The chat page Rambox shows. Talks only to the signal-rambox helper that
// served it (same origin; the token is part of the page's own path).
// All text from Signal goes into the page through textContent, never HTML.

'use strict';

const $ = id => document.getElementById(id);

const conversations = new Map();
// conversationId -> AuthorDTO, from messages (group members usually have no
// listed conversation of their own).
const authors = new Map();
let capabilities = [];
// conversationId -> [{ authorConversationId, author }], from typing.changed.
const typingIn = new Map();
// The chat list shows archived chats instead (Signal's "Archived chats").
let showArchived = false;
let selectedId = null;
let messages = new Map();
let nextCursor = null;
let bridgeState = 'offline';
let helperConnected = false;
let markReadInFlight = false;
// A mark-read was asked for while one was in flight: run again after.
let markReadAgain = false;
let replyTo = null;
// The message being edited, if any.
let editing = null;
let preferredReactions = null;
const expiryTimers = new Map();

const AVATAR_COLORS = [
  'A100',
  'A110',
  'A120',
  'A130',
  'A140',
  'A150',
  'A160',
  'A170',
  'A180',
  'A190',
  'A200',
  'A210',
];

const BANNERS = {
  offline:
    "Can't reach Signal. Make sure Signal is running and Settings > " +
    'Privacy > Apps on this computer is on. Retrying…',
  awaitingApproval: 'Approve "Rambox (signal-rambox)" in the Signal window.',
  denied: 'Signal did not allow this app.',
  keyMismatch:
    "Signal's identity key changed since this app was approved. Delete " +
    'key.json in the signal-rambox config folder and restart it to pair again.',
  loading: 'Loading chats…',
};

const SEND_ERRORS = {
  proxyTooLarge:
    'Not sent: the web server in front of the helper refused a file this big (HTTP 413). Raise its upload limit (nginx: client_max_body_size).',
  expired: 'This version of Signal has expired. Update Signal.',
  invalidConversation: "Signal can't send to this chat.",
  blocked: 'You blocked this chat. Unblock it in Signal to send.',
  leftGroup: "You're no longer in this group.",
  messageRequest: 'Accept the message request in Signal first.',
  unregistered: 'This person is no longer on Signal.',
  profileSharingRequired: 'Open this chat in Signal and accept it first.',
  pendingApproval: 'Your request to join this group is still pending.',
  announcementOnly: 'Only admins can send messages to this group.',
  terminated: 'This group is no longer active.',
  untrustedIdentity:
    "This person's safety number changed. Open the chat in Signal to review it.",
  tooLong: 'That message is too long.',
  attachmentTooLarge: 'That file is too large for Signal.',
  notForwardable: "Signal can't forward this message.",
  notDownloaded:
    'Signal is still downloading this message. Try again in a moment.',
  notFound: 'That chat is gone.',
  pollsNotSupported: "Signal doesn't send polls to 1:1 chats yet.",
  pollEnded: 'This poll has ended.',
};

const STATUS_TEXT = {
  sending: 'Sending…',
  paused: 'Paused: open Signal',
  failed: 'Not sent',
  partiallySent: 'Partly sent',
  sent: 'Sent',
  delivered: 'Delivered',
  read: 'Read',
  viewed: 'Viewed',
};

async function api(path, body) {
  const options =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        };
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
    error.code = data.error?.code;
    error.reason = data.error?.reason;
    throw error;
  }
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

// --- icons (built as DOM; the CSP allows no inline markup) ----------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  react:
    'M12 21.5a9.5 9.5 0 1 1 9.5-9.5M8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01M19 15v6M16 18h6',
  reply: 'M10 5 4 11l6 6M4 11h10a6 6 0 0 1 6 6v2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6 6 18',
  copy: 'M9 9h10v12H9zM5 15V3h10',
  group:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20c.5-3.5 3.2-5.5 6.5-5.5s6 2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.5 3.5 5.2',
  note: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7',
  play: 'M8 5v14l11-7z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  filter: 'M4 7h16M7 12h10M10 17h4',
  attach:
    'M20 11.5 12.4 19a5 5 0 0 1-7-7l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4L15 6.9',
  forward: 'M14 5l6 6-6 6M20 11H10a6 6 0 0 0-6 6v2',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM16 16l4.5 4.5',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  poll: 'M5 20V11M12 20V4M19 20v-6',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  back: 'M15 5l-7 7 7 7',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  timer: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM12 9v4l2.5 2M10 2h4',
  pin: 'M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6',
  unpin: 'M9 4h6l-1 6 4 3v2H6v-2l4-3zM12 15v6M4 4l16 16',
  unread: 'M4 6h11M4 12h9M4 18h11M19 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  archive: 'M4 5h16v4H4zM5 9v10h14V9M10 13h4',
  block: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  sticker:
    'M20 12V8a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h4m8-8-8 8m8-8h-4a4 4 0 0 0-4 4v4',
  'cat-recent': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2',
  'cat-smileys':
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM8.5 14s1.3 2 3.5 2 3.5-2 3.5-2M9 9.5h.01M15 9.5h.01',
  'cat-animals':
    'M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM12 20c-4 0-6-2.5-6-6s2.7-6 6-6 6 2.5 6 6-2 6-6 6Z',
  'cat-food':
    'M4 11h16M5 11a7 5 0 0 1 14 0M4 15h16M5 15v1a3 3 0 0 0 3 3h8a3 3 0 0 0 3-3v-1',
  'cat-activities':
    'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  'cat-travel': 'M5 16v-5l2-5h10l2 5v5M3 16h18v2H3zM7 19v1M17 19v1M5 11h14',
  'cat-objects':
    'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.4.4.5.9.5 1.4V16h6v-.7c0-.5.2-1 .5-1.4A6 6 0 0 0 12 3Z',
  'cat-symbols':
    'M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z',
  'cat-flags': 'M5 21V4M5 4h11l-2 4 2 4H5',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

// --- avatars -------------------------------------------------------------

function initials(title) {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return '';
  }
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? ([...words.at(-1)][0] ?? '') : '';
  return (first + last).toUpperCase();
}

function colorFor(id, avatarColor) {
  if (AVATAR_COLORS.includes(avatarColor)) {
    return avatarColor;
  }
  let hash = 0;
  for (const ch of id) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

// who: { title, avatarColor, avatarVersion }; kind: 'direct' | 'group' | 'me'
function avatar(id, who, size, kind = 'direct') {
  const box = el(
    'span',
    `avatar av-${size} ac-${colorFor(id, who.avatarColor)}`
  );
  const fallback = () => {
    if (kind === 'group') {
      box.append(icon('group'));
    } else if (kind === 'me') {
      box.append(icon('note'));
    } else {
      const text = initials(who.title);
      box.append(text ? el('span', 'initials', text) : icon('group'));
    }
  };
  fallback();
  if (who.avatarVersion) {
    // In the DOM from the start so lazy loading can see it; shown over the
    // initials once loaded.
    const img = el('img', 'photo');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('loaded'));
    img.addEventListener('error', () => img.remove());
    box.append(img);
    const params = new URLSearchParams({
      conversationId: id,
      v: who.avatarVersion,
    });
    img.src = `api/avatar?${params}`;
  }
  return box;
}

function conversationAvatar(c, size) {
  return avatar(
    c.id,
    c,
    size,
    c.noteToSelf ? 'me' : c.type === 'group' ? 'group' : 'direct'
  );
}

// --- banner and title ------------------------------------------------------

function renderBanner() {
  const banner = $('banner');
  const action = $('banner-action');
  let text = null;
  if (!helperConnected) {
    // A restart (an update, a redeploy) takes a few seconds; only a long
    // outage means the helper is really down.
    const long =
      disconnectedSince !== null &&
      Date.now() - disconnectedSince > HELPER_DOWN_AFTER_MS;
    text = long
      ? "The signal-rambox helper isn't running. Retrying…"
      : 'Connecting…';
  } else if (bridgeState !== 'ready') {
    text = BANNERS[bridgeState] ?? `Signal: ${bridgeState}`;
  }
  banner.hidden = text === null;
  $('banner-text').textContent = text ?? '';
  action.hidden = !(helperConnected && bridgeState === 'denied');
  action.textContent = 'Ask Signal again';
}

function unreadTotal() {
  let total = 0;
  for (const c of conversations.values()) {
    if (c.muted || c.archived) {
      continue;
    }
    total += c.unreadCount > 0 ? c.unreadCount : c.markedUnread ? 1 : 0;
  }
  return total;
}

// Rambox reads the unread badge from "(N)" at the start of the title.
function renderTitle() {
  const total = unreadTotal();
  document.title = total > 0 ? `(${total}) Signal` : 'Signal';
}

// --- conversation list -----------------------------------------------------

function displayTitle(c) {
  return c.noteToSelf ? 'Note to Self' : c.title;
}

// The chat list filters, as in Signal: a tab ('all' | 'direct' | 'group')
// and the unread filter button, which combine.
let listFilter = 'all';
let unreadOnly = false;
try {
  listFilter = localStorage.getItem('listFilter') ?? 'all';
  unreadOnly = localStorage.getItem('unreadOnly') === '1';
} catch {
  // Storage blocked; keep the defaults.
}

function isUnread(c) {
  return c.unreadCount > 0 || c.markedUnread;
}

const FILTERS = {
  all: () => true,
  direct: c => c.type === 'direct',
  group: c => c.type === 'group',
};

function keepConversation(c) {
  const tab = FILTERS[listFilter] ?? FILTERS.all;
  // The open chat stays listed while you read it, as in Signal.
  return tab(c) && (!unreadOnly || isUnread(c) || c.id === selectedId);
}

function sortedConversations() {
  const query = $('search').value.trim().toLowerCase();
  return [...conversations.values()]
    .filter(c =>
      query
        ? displayTitle(c).toLowerCase().includes(query) ||
          c.title.toLowerCase().includes(query)
        : c.archived === showArchived
    )
    .filter(keepConversation)
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinnedIndex ?? 0) - (b.pinnedIndex ?? 0) ||
        (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    );
}

function shortTime(ms) {
  if (!ms) {
    return '';
  }
  const minutes = Math.floor((Date.now() - ms) / 60_000);
  if (minutes < 1) {
    return 'Now';
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const d = new Date(ms);
  if (d.toDateString() === new Date().toDateString()) {
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (Date.now() - ms < 6 * 24 * 3600_000) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Rows are kept per conversation so photos are not reloaded on every update.
const rowCache = new Map();

function conversationRow(c) {
  const unread = c.unreadCount > 0 || c.markedUnread;
  const key = JSON.stringify([
    c.title,
    c.avatarVersion,
    c.avatarColor,
    c.unreadCount,
    c.markedUnread,
    c.muted,
    c.lastActivityAt,
    c.id === selectedId,
    shortTime(c.lastActivityAt),
    c.lastMessage,
    typingIn.has(c.id),
  ]);
  const cached = rowCache.get(c.id);
  if (cached && cached.key === key) {
    return cached.li;
  }
  const li = el('li');
  li.dataset.id = c.id;
  li.title = displayTitle(c);
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', String(c.id === selectedId));
  li.className = [unread ? 'unread' : '', c.muted ? 'muted' : ''].join(' ');
  const text = el('span', 'row-text');
  const top = el('span', 'row-top');
  top.append(
    el('span', 'title', displayTitle(c)),
    el('span', 'time', shortTime(c.lastActivityAt))
  );
  const bottom = el('span', 'row-bottom');
  if (typingIn.has(c.id)) {
    // As Signal's list: the dots take the preview's place.
    bottom.append(typingDots());
  } else {
    bottom.append(el('span', 'preview', previewLine(c)));
  }
  if (c.lastMessage?.status && !typingIn.has(c.id)) {
    bottom.append(statusIcon(c.lastMessage.status));
  }
  text.append(top, bottom);
  li.append(conversationAvatar(c, 48), text);
  if (unread) {
    li.append(
      el('span', 'badge', c.unreadCount > 0 ? String(c.unreadCount) : '')
    );
  }
  li.addEventListener('click', () => selectConversation(c.id));
  // As Signal's chat list: right-click for the chat's menu.
  li.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
    openChatMenu(c.id, {
      left: ev.clientX,
      right: ev.clientX,
      top: ev.clientY,
      bottom: ev.clientY,
      width: 0,
      height: 0,
    });
  });
  rowCache.set(c.id, { key, li });
  return li;
}

// Signal's checkmarks: one circle sent, two delivered, two filled read.
function statusIcon(status) {
  const label = STATUS_TEXT[status] ?? status;
  const span = el('span', `status-icon st-${status}`);
  span.title = label;
  span.setAttribute('role', 'img');
  span.setAttribute('aria-label', label);
  return span;
}

// The second line of a chat list row, as Signal writes it.
function previewLine(c) {
  const last = c.lastMessage;
  if (!last) {
    return '';
  }
  if (last.deleted) {
    return 'This message was deleted';
  }
  const text = (last.text ?? '').replace(/\s+/g, ' ');
  return last.author && c.type === 'group' ? `${last.author}: ${text}` : text;
}

const sectionHeads = {};
function sectionHead(label) {
  sectionHeads[label] ??= el('li', 'section-head', label);
  return sectionHeads[label];
}

function setListFilter(name, unread) {
  listFilter = name;
  unreadOnly = unread;
  try {
    localStorage.setItem('listFilter', name);
    localStorage.setItem('unreadOnly', unread ? '1' : '0');
  } catch {
    // Storage blocked; the filter still applies until reload.
  }
  renderConversations();
}

// Tabs under the search box, with Signal's unread counts. The filter button
// beside the search box is the unread filter.
function renderFilters() {
  const unarchived = [...conversations.values()].filter(c => !c.archived);
  const unreadIn = test => unarchived.filter(c => test(c) && isUnread(c));
  const tabs = [
    ['all', 'All chats', unreadIn(FILTERS.all).length],
    ['direct', '1:1 chats', unreadIn(FILTERS.direct).length],
    ['group', 'Groups', unreadIn(FILTERS.group).length],
  ];
  $('filters').replaceChildren(
    ...tabs.map(([name, label, count]) => {
      const tab = el('button', 'filter-tab');
      tab.type = 'button';
      tab.setAttribute('aria-pressed', String(listFilter === name));
      tab.append(el('span', '', label));
      if (count > 0) {
        tab.append(el('span', 'filter-count', String(count)));
      }
      tab.addEventListener('click', () => setListFilter(name, unreadOnly));
      return tab;
    })
  );
  $('filter-unread').setAttribute('aria-pressed', String(unreadOnly));
}

function renderConversations() {
  renderFilters();
  const list = sortedConversations();
  const searching = $('search').value.trim() !== '';
  const pinned = list.filter(c => c.pinned);
  const others = list.filter(c => !c.pinned);
  const rows =
    searching || pinned.length === 0
      ? list.map(conversationRow)
      : [
          sectionHead('Pinned'),
          ...pinned.map(conversationRow),
          ...(others.length > 0 ? [sectionHead('Chats')] : []),
          ...others.map(conversationRow),
        ];
  if (rows.length === 0 && bridgeState === 'ready') {
    rows.push(
      el(
        'li',
        'list-empty',
        showArchived
          ? 'No archived chats'
          : unreadOnly
            ? 'No unread chats'
            : 'No chats'
      )
    );
  }
  if (showArchived) {
    rows.unshift(archivedHead());
  } else if (!searching) {
    const archived = [...conversations.values()].filter(c => c.archived);
    if (archived.length > 0) {
      rows.push(archivedLink(archived.length));
    }
  }
  $('conversations').replaceChildren(...rows);
}

// --- messages --------------------------------------------------------------

function authorOf(conversationId) {
  if (!conversationId) {
    return null;
  }
  const c = conversations.get(conversationId);
  return authors.get(conversationId) ?? c ?? null;
}

function nameOf(conversationId) {
  return authorOf(conversationId)?.title ?? 'Someone';
}

function rememberAuthors(m) {
  if (m.authorConversationId && m.author) {
    authors.set(m.authorConversationId, m.author);
  }
  if (m.quote?.authorConversationId && m.quote.author) {
    authors.set(m.quote.authorConversationId, m.quote.author);
  }
}

function describeAttachments(attachments) {
  return attachments.map(a => {
    const type = a.contentType.split('/')[0];
    const label =
      type === 'image'
        ? 'Photo'
        : type === 'video'
          ? 'Video'
          : type === 'audio'
            ? 'Audio'
            : 'File';
    return a.fileName ? `${label}: ${a.fileName}` : label;
  });
}

// Plain-text summary for notifications and quotes.
function summarize(m) {
  switch (m.kind) {
    case 'text': {
      if (m.body) {
        return m.body;
      }
      return describeAttachments(m.attachments).join(', ') || 'Message';
    }
    case 'sticker':
      return 'Sticker';
    case 'poll':
      return `Poll: ${m.poll?.question ?? ''}`;
    case 'viewOnce':
      return 'View-once media';
    case 'deleted':
      return 'This message was deleted';
    default:
      return 'Open Signal to see this message';
  }
}

function formatTime(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

// Signal shows short emoji-only messages large and without a bubble.
const segmenter = new Intl.Segmenter();
function isJumbo(body) {
  if (
    !body ||
    body.length > 40 ||
    !/^[\p{Extended_Pictographic}\p{Emoji_Component}‍️\s]+$/u.test(body)
  ) {
    return false;
  }
  const graphemes = [...segmenter.segment(body.trim())].filter(
    s => s.segment.trim() !== ''
  );
  return (
    graphemes.length > 0 &&
    graphemes.length <= 3 &&
    graphemes.every(s => /\p{Extended_Pictographic}/u.test(s.segment))
  );
}

function nameLine(name, author, className) {
  const line = el('span', className);
  if (author?.nameColor) {
    line.classList.add(`nc-${author.nameColor}`);
  }
  line.append(el('span', 'name', name));
  if (author?.label) {
    const pill = el('span', 'pill');
    if (author.label.emoji) {
      pill.append(el('span', 'pill-emoji', author.label.emoji));
    }
    pill.append(el('span', 'pill-text', author.label.text));
    line.append(pill);
  }
  return line;
}

// As Signal: a click on a reply's quote scrolls to the original, loading
// older messages until it's there, and highlights it briefly.
const MAX_QUOTE_PAGES = 50;
let quoteJump = 0;

function findQuoted(quote) {
  return sortedMessages().find(
    m =>
      m.sentAt === quote.sentAt &&
      (quote.authorConversationId === null ||
        m.authorConversationId === quote.authorConversationId)
  );
}

async function jumpToQuote(quote) {
  const conversationId = selectedId;
  const jump = ++quoteJump;
  let found = findQuoted(quote);
  for (let page = 0; !found && nextCursor && page < MAX_QUOTE_PAGES; page++) {
    try {
      // oxlint-disable-next-line no-await-in-loop
      await loadMessages({ older: true });
    } catch (error) {
      toast(`Couldn't load older messages (${error.code ?? error.message}).`);
      return;
    }
    if (conversationId !== selectedId || jump !== quoteJump) {
      return;
    }
    found = findQuoted(quote);
  }
  const li =
    found &&
    $('message-list').querySelector(`[data-id="${CSS.escape(found.id)}"]`);
  if (!li) {
    toast('Original message not found.');
    return;
  }
  li.scrollIntoView({ block: 'center', behavior: 'smooth' });
  li.classList.remove('flash');
  // Restart the animation when the same message is picked twice.
  void li.offsetWidth;
  li.classList.add('flash');
  setTimeout(() => li.classList.remove('flash'), 1600);
}

function renderQuote(quote) {
  const box = el('span', 'quote');
  if (quote.sentAt !== null) {
    box.classList.add('jumps');
    box.title = 'Go to message';
    box.addEventListener('click', ev => {
      ev.stopPropagation();
      jumpToQuote(quote);
    });
  }
  const author = quote.author ?? authorOf(quote.authorConversationId);
  if (author?.nameColor) {
    box.classList.add(`nc-${author.nameColor}`);
  }
  box.append(
    nameLine(nameOf(quote.authorConversationId), author, 'quote-author'),
    el('span', 'quote-text', quote.text ?? 'Attachment')
  );
  return box;
}

function renderReactions(m) {
  const counts = new Map();
  for (const r of m.reactions) {
    const entry = counts.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    entry.mine ||= r.fromMe;
    counts.set(r.emoji, entry);
  }
  const box = el('span', 'reactions');
  for (const [emoji, { count, mine }] of counts) {
    const chip = el('button', `reaction${mine ? ' mine' : ''}`);
    chip.type = 'button';
    chip.append(el('span', 'emoji', emoji));
    if (count > 1) {
      chip.append(el('span', 'count', String(count)));
    }
    chip.title = m.reactions
      .filter(r => r.emoji === emoji)
      .map(r => (r.fromMe ? 'You' : nameOf(r.authorConversationId)))
      .join(', ');
    chip.addEventListener('click', e => {
      e.stopPropagation();
      openReactionViewer(m, box, emoji);
    });
    box.append(chip);
  }
  return box;
}

// As Signal's reaction viewer: an All tab and one per emoji, then who
// reacted. Our own row takes the reaction back, as picking it again would.
function openReactionViewer(m, anchor, selected) {
  closePopovers();
  const viewer = $('reaction-viewer');
  const counts = new Map();
  for (const r of m.reactions) {
    counts.set(r.emoji, (counts.get(r.emoji) ?? 0) + 1);
  }
  const tabs = el('div', 'viewer-tabs');
  const list = el('div', 'viewer-list');
  const show = emoji => {
    for (const tab of tabs.children) {
      tab.classList.toggle('active', tab.dataset.emoji === (emoji ?? ''));
    }
    list.replaceChildren(
      ...m.reactions
        .filter(r => emoji === null || r.emoji === emoji)
        .toSorted((a, b) => Number(b.fromMe) - Number(a.fromMe))
        .map(r => {
          const id = r.authorConversationId;
          const row = el('div', 'viewer-row');
          const who = authorOf(id) ?? { title: nameOf(id) };
          const name = el('span', 'viewer-name', r.fromMe ? 'You' : nameOf(id));
          row.append(avatar(id, who, 36), name, el('span', 'emoji', r.emoji));
          if (r.fromMe && canReact()) {
            row.classList.add('mine');
            name.append(el('span', 'sub', 'Click to remove'));
            row.addEventListener('click', e => {
              e.stopPropagation();
              closePopovers();
              sendReaction(m, r.emoji, true);
            });
          }
          return row;
        })
    );
  };
  const tab = (emoji, label) => {
    const button = el('button', 'viewer-tab');
    button.type = 'button';
    button.dataset.emoji = emoji ?? '';
    button.append(...label);
    button.addEventListener('click', e => {
      e.stopPropagation();
      show(emoji);
    });
    tabs.append(button);
  };
  tab(null, [el('span', '', `All ${m.reactions.length}`)]);
  for (const [emoji, count] of counts) {
    tab(emoji, [el('span', 'emoji', emoji), el('span', '', String(count))]);
  }
  viewer.replaceChildren(tabs, list);
  show(counts.size > 1 ? selected : null);
  placePopover(viewer, anchor);
}

function canReact() {
  return capabilities.includes('messages.react');
}

function canReplyTo(m) {
  return m.kind !== 'deleted' && m.kind !== 'unsupported';
}

function actionButton(name, label, onClick) {
  const button = el('button', 'icon-button');
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.append(icon(name));
  button.addEventListener('click', e => {
    e.stopPropagation();
    onClick(button);
  });
  return button;
}

function renderActions(m) {
  const actions = el('span', 'actions');
  if (canReact() && canReplyTo(m)) {
    actions.append(
      actionButton('react', 'React', button => openReactionPicker(m, button))
    );
  }
  if (canReplyTo(m)) {
    actions.append(actionButton('reply', 'Reply', () => startReply(m)));
  }
  actions.append(
    actionButton('more', 'More actions', button => openMoreMenu(m, button))
  );
  return actions;
}

// --- attachments ---------------------------------------------------------------

function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentParams(m, index, extra = {}) {
  return new URLSearchParams({
    messageId: m.id,
    index: String(index),
    ...extra,
  });
}

function attachmentUrl(m, index, a, extra = {}) {
  return `api/attachment?${attachmentParams(m, index, {
    name: a.fileName ?? 'attachment',
    ...extra,
  })}`;
}

function kindOf(a) {
  const type = a.contentType.split('/')[0];
  if (a.isVoiceMessage || type === 'audio') {
    return 'audio';
  }
  if (type === 'image') {
    return 'image';
  }
  if (type === 'video') {
    return a.isGif ? 'gif' : 'video';
  }
  return 'file';
}

function requestDownload(m) {
  api('api/download', { messageId: m.id }).catch(error =>
    toast(`Couldn't download (${error.code ?? error.message}).`)
  );
}

// The status line on media that is not on this computer yet.
function downloadState(m, a) {
  if (a.state === 'downloading') {
    return el('span', 'media-state', 'Downloading…');
  }
  if (a.state === 'failed') {
    return el('span', 'media-state', "Couldn't download");
  }
  const button = el(
    'button',
    'media-state action',
    `Download · ${formatSize(a.size)}`
  );
  button.type = 'button';
  button.addEventListener('click', e => {
    e.stopPropagation();
    requestDownload(m);
  });
  return button;
}

// Device pixels for an image drawn this many CSS pixels wide, in steps so
// the browser's cache still works after a zoom change.
function previewWidth(cssWidth) {
  const px = cssWidth * Math.max(1, window.devicePixelRatio || 1);
  return Math.min(1600, Math.ceil(px / 160) * 160);
}

function mediaBox(a, multiple) {
  const box = el('span', `media${multiple ? ' tile' : ''}`);
  if (!multiple && a.width && a.height) {
    // Keep the shape before the image arrives, as Signal does.
    const width = Math.min(320, a.width);
    box.style.width = `${width}px`;
    box.style.aspectRatio = `${a.width} / ${Math.max(1, a.height)}`;
  }
  return box;
}

function renderVisual(m, a, index, multiple) {
  const box = mediaBox(a, multiple);
  const kind = kindOf(a);
  if (kind === 'gif' && a.state === 'ready') {
    const video = el('video');
    video.src = attachmentUrl(m, index, a);
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    box.append(video);
    return box;
  }
  if (a.hasThumbnail) {
    const img = el('img');
    img.alt = a.caption ?? '';
    img.loading = 'lazy';
    img.src = `api/thumbnail?${attachmentParams(m, index, {
      width: String(previewWidth(multiple ? 160 : 320)),
    })}`;
    box.append(img);
  } else {
    box.classList.add('placeholder');
  }
  if (kind === 'video' || kind === 'gif') {
    const play = el('span', 'play');
    play.append(icon('play'));
    box.append(play);
  }
  if (a.state !== 'ready') {
    box.append(downloadState(m, a));
    return box;
  }
  box.classList.add('clickable');
  box.addEventListener('click', () => openLightbox(m, index));
  return box;
}

function renderAudio(m, a, index) {
  const box = el('span', 'audio');
  if (a.state === 'ready') {
    const audio = el('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = attachmentUrl(m, index, a);
    box.append(audio);
  } else {
    box.append(
      el(
        'span',
        'file-name',
        a.isVoiceMessage ? 'Voice message' : (a.fileName ?? 'Audio')
      ),
      downloadState(m, a)
    );
  }
  return box;
}

function renderFile(m, a, index) {
  const row = el(a.state === 'ready' ? 'a' : 'span', 'file');
  const badge = el('span', 'file-icon');
  badge.textContent = (a.fileName?.split('.').pop() ?? '')
    .slice(0, 4)
    .toUpperCase();
  const text = el('span', 'file-text');
  text.append(
    el('span', 'file-name', a.fileName ?? 'File'),
    el('span', 'file-size', formatSize(a.size))
  );
  row.append(badge, text);
  if (a.state === 'ready') {
    row.href = attachmentUrl(m, index, a, { download: '1' });
    row.download = a.fileName ?? 'attachment';
  } else {
    row.append(downloadState(m, a));
  }
  return row;
}

function renderAttachments(m) {
  const box = el('span', 'attachments');
  const visual = [];
  m.attachments.forEach((a, index) => {
    const kind = kindOf(a);
    if (kind === 'image' || kind === 'video' || kind === 'gif') {
      visual.push([a, index]);
    }
  });
  if (visual.length > 0) {
    const grid = el('span', `media-grid${visual.length > 1 ? ' multi' : ''}`);
    for (const [a, index] of visual) {
      grid.append(renderVisual(m, a, index, visual.length > 1));
    }
    box.append(grid);
  }
  m.attachments.forEach((a, index) => {
    const kind = kindOf(a);
    if (kind === 'audio') {
      box.append(renderAudio(m, a, index));
    } else if (kind === 'file') {
      box.append(renderFile(m, a, index));
    }
  });
  const captions = m.attachments.map(a => a.caption).filter(Boolean);
  if (captions.length > 0 && !m.body) {
    box.append(el('span', 'body', captions.join('\n')));
  }
  return box;
}

function renderSticker(m) {
  const box = el('span', 'sticker');
  if (m.sticker?.ready) {
    const img = el('img');
    img.alt = m.sticker.emoji ?? 'Sticker';
    img.src = `api/attachment?${new URLSearchParams({ messageId: m.id, sticker: '1' })}`;
    box.append(img);
  } else {
    box.append(el('span', 'body note', `Sticker ${m.sticker?.emoji ?? ''}`));
    const button = el('button', 'media-state action', 'Download');
    button.type = 'button';
    button.addEventListener('click', () => requestDownload(m));
    box.append(button);
  }
  return box;
}

// Full-size view of a message's photos and videos, like Signal's.
function openLightbox(m, index) {
  const a = m.attachments[index];
  const box = $('lightbox');
  const stage = $('lightbox-stage');
  let content;
  if (kindOf(a) === 'image') {
    content = el('img');
    content.alt = a.caption ?? '';
  } else {
    content = el('video');
    content.controls = true;
    content.autoplay = true;
    content.loop = a.isGif;
    content.playsInline = true;
  }
  content.src = attachmentUrl(m, index, a);
  stage.replaceChildren(content);
  $('lightbox-caption').textContent = a.caption ?? '';
  $('lightbox-save').href = attachmentUrl(m, index, a, { download: '1' });
  $('lightbox-save').download = a.fileName ?? 'attachment';
  box.hidden = false;
}

function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightbox-stage').replaceChildren();
}

// --- message text: mentions, formatting, links ----------------------------------

// The body with mentions written out, for copying and quoting.
function plainText(m) {
  let text = m.body ?? '';
  for (const mention of [...(m.mentions ?? [])].sort(
    (a, b) => b.start - a.start
  )) {
    text =
      text.slice(0, mention.start) +
      `@${mention.title ?? 'Someone'}` +
      text.slice(mention.start + mention.length);
  }
  return text;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

function appendLinkified(parent, text) {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) {
      parent.append(text.slice(last, match.index));
    }
    const link = el('a', 'link', match[0]);
    link.href = match[0];
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    parent.append(text.slice(last));
  }
}

const STYLE_CLASS = {
  bold: 'f-bold',
  italic: 'f-italic',
  strikethrough: 'f-strike',
  monospace: 'f-mono',
  spoiler: 'f-spoiler',
};

// Splits the body at every range edge and styles each piece, as Signal's
// own renderer does.
function renderBody(m) {
  const body = el('span', 'body');
  if (isJumboBody(m)) {
    body.classList.add('jumbo-body');
  }
  const text = m.body ?? '';
  const mentions = m.mentions ?? [];
  const formatting = m.formatting ?? [];
  const edges = new Set([0, text.length]);
  for (const r of [...mentions, ...formatting]) {
    edges.add(Math.max(0, Math.min(text.length, r.start)));
    edges.add(Math.max(0, Math.min(text.length, r.start + r.length)));
  }
  const points = [...edges].sort((a, b) => a - b);
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i];
    const end = points[i + 1];
    const styles = formatting
      .filter(r => r.start <= start && r.start + r.length >= end)
      .map(r => STYLE_CLASS[r.style])
      .filter(Boolean);
    const mention = mentions.find(
      r => r.start <= start && r.start + r.length >= end
    );
    let node = body;
    if (styles.length > 0) {
      node = el('span', styles.join(' '));
      if (styles.includes('f-spoiler')) {
        node.title = 'Spoiler: click to reveal';
        node.addEventListener('click', e => {
          e.stopPropagation();
          node.classList.add('revealed');
        });
      }
      body.append(node);
    }
    if (mention) {
      // One mention may span several pieces; write it once.
      if (start === mention.start) {
        node.append(el('span', 'mention', `@${mention.title ?? 'Someone'}`));
      }
    } else if (styles.includes('f-mono')) {
      node.append(text.slice(start, end));
    } else {
      appendLinkified(node, text.slice(start, end));
    }
  }
  return body;
}

function isJumboBody(m) {
  return (
    m.kind === 'text' &&
    !m.quote &&
    m.attachments.length === 0 &&
    (m.mentions ?? []).length === 0 &&
    isJumbo(m.body)
  );
}

function renderLinkPreview(m, p, index) {
  const card = el('a', 'link-preview');
  card.href = p.url;
  card.target = '_blank';
  card.rel = 'noopener noreferrer';
  if (p.hasImage) {
    const img = el('img', 'link-preview-image');
    img.alt = '';
    img.loading = 'lazy';
    img.src = `api/thumbnail?${new URLSearchParams({
      messageId: m.id,
      preview: String(index),
      width: String(previewWidth(360)),
    })}`;
    card.append(img);
  }
  const text = el('span', 'link-preview-text');
  if (p.title) {
    text.append(el('span', 'link-preview-title', p.title));
  }
  if (p.description) {
    text.append(el('span', 'link-preview-description', p.description));
  }
  let domain = p.domain;
  if (!domain) {
    try {
      domain = new URL(p.url).hostname;
    } catch {
      domain = '';
    }
  }
  text.append(el('span', 'link-preview-domain', domain));
  card.append(text);
  return card;
}

// prev/next: the neighboring messages, to group runs by the same author.
function renderMessage(m, prev, next) {
  const outgoing = m.direction === 'outgoing';
  const conversation = conversations.get(m.conversationId);
  const isGroupChat = conversation?.type === 'group';
  const sameAuthor = other =>
    other &&
    other.direction === m.direction &&
    other.authorConversationId === m.authorConversationId &&
    Math.abs(other.sentAt - m.sentAt) < 10 * 60_000;
  const firstOfRun = !sameAuthor(prev);
  const lastOfRun = !sameAuthor(next);

  const li = el('li', `msg ${outgoing ? 'out' : 'in'}`);
  if (!lastOfRun) {
    li.classList.add('run');
  }
  li.dataset.id = m.id;

  if (!outgoing && isGroupChat) {
    li.classList.add('with-avatar');
    if (lastOfRun && m.authorConversationId) {
      const who = authorOf(m.authorConversationId) ?? { title: 'Someone' };
      li.append(avatar(m.authorConversationId, who, 28));
    } else {
      li.append(el('span', 'avatar-spacer'));
    }
  }

  const column = el('span', 'column');
  const jumbo =
    m.kind === 'text' &&
    !m.quote &&
    m.attachments.length === 0 &&
    isJumbo(m.body);
  const bubble = el('span', `bubble${jumbo ? ' jumbo' : ''}`);

  if (!outgoing && isGroupChat && firstOfRun) {
    bubble.append(nameLine(nameOf(m.authorConversationId), m.author, 'author'));
  }
  if (m.quote) {
    bubble.append(renderQuote(m.quote));
  }
  if (m.kind === 'text' && m.attachments.length > 0) {
    bubble.classList.add('has-media');
    bubble.append(renderAttachments(m));
  }
  if (m.kind === 'poll' && m.poll) {
    bubble.append(renderPoll(m));
  } else if (m.kind === 'sticker') {
    bubble.classList.add('sticker-bubble');
    bubble.append(renderSticker(m));
  } else if (m.kind !== 'text') {
    bubble.append(el('span', 'body note', summarize(m)));
  } else if (m.body) {
    if (m.previews?.length > 0) {
      bubble.classList.add('has-media');
      bubble.append(...m.previews.map((p, i) => renderLinkPreview(m, p, i)));
    }
    const body = renderBody(m);
    if (m.bodyTruncated) {
      body.append(' …');
    }
    bubble.append(body);
  }

  const meta = el('span', 'meta');
  const bits = [formatTime(m.sentAt)];
  if (m.edited) {
    bits.push('Edited');
  }
  // Problems keep their words too; the checkmarks speak for themselves.
  if (['failed', 'partiallySent', 'paused'].includes(m.sendStatus)) {
    bits.push(STATUS_TEXT[m.sendStatus]);
  }
  meta.textContent = bits.join(' · ');
  if (m.sendStatus) {
    meta.append(statusIcon(m.sendStatus));
  }
  bubble.append(meta);

  const line = el('span', 'bubble-line');
  line.append(bubble, renderActions(m));
  column.append(line);
  if (m.reactions.length > 0) {
    column.append(renderReactions(m));
  }
  li.append(column);
  return li;
}

function sortedMessages() {
  return [...messages.values()].sort((a, b) => a.sentAt - b.sentAt);
}

// Rendered messages are kept and reused while unchanged, and the list is
// patched in place, so playing media and loaded images are left alone.
const messageCache = new Map();

function cachedMessage(m, prev, next) {
  const key = JSON.stringify([
    m,
    prev?.authorConversationId,
    prev?.direction,
    prev?.sentAt,
    next?.authorConversationId,
    next?.direction,
    next?.sentAt,
    capabilities,
    formatTime(m.sentAt),
  ]);
  const cached = messageCache.get(m.id);
  if (cached && cached.key === key) {
    return cached.li;
  }
  const li = renderMessage(m, prev, next);
  messageCache.set(m.id, { key, li });
  return li;
}

function patchChildren(parent, wanted) {
  wanted.forEach((node, i) => {
    if (parent.children[i] !== node) {
      parent.insertBefore(node, parent.children[i] ?? null);
    }
  });
  while (parent.children.length > wanted.length) {
    parent.lastElementChild.remove();
  }
}

function renderMessages({ keepBottom = true } = {}) {
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const previousHeight = box.scrollHeight;
  const list = sortedMessages();
  patchChildren(
    $('message-list'),
    list.map((m, i) => cachedMessage(m, list[i - 1], list[i + 1]))
  );
  for (const id of messageCache.keys()) {
    if (!messages.has(id)) {
      messageCache.delete(id);
    }
  }
  $('older').hidden = !nextCursor;
  if (keepBottom && atBottom) {
    box.scrollTop = box.scrollHeight;
  } else if (!keepBottom) {
    // Loading older messages: keep the same message in view.
    box.scrollTop += box.scrollHeight - previousHeight;
  }
}

function scheduleExpiry(m) {
  if (m.expiresAt === null || expiryTimers.has(m.id)) {
    return;
  }
  const delay = Math.max(0, m.expiresAt - Date.now());
  expiryTimers.set(
    m.id,
    setTimeout(
      () => {
        expiryTimers.delete(m.id);
        if (messages.delete(m.id)) {
          renderMessages();
        }
      },
      Math.min(delay, 2 ** 31 - 1)
    )
  );
}

function putMessage(m) {
  rememberAuthors(m);
  if (m.expiresAt !== null && m.expiresAt <= Date.now()) {
    messages.delete(m.id);
    return;
  }
  messages.set(m.id, m);
  scheduleExpiry(m);
}

function clearExpiryTimers() {
  for (const timer of expiryTimers.values()) {
    clearTimeout(timer);
  }
  expiryTimers.clear();
}

async function loadMessages({ older = false } = {}) {
  const conversationId = selectedId;
  const params = new URLSearchParams({ conversationId });
  if (older && nextCursor) {
    params.set('cursor', nextCursor);
  }
  const page = await api(`api/messages?${params}`);
  if (conversationId !== selectedId) {
    return;
  }
  for (const m of page.messages) {
    putMessage(m);
  }
  nextCursor = page.nextCursor;
  renderMessages({ keepBottom: !older });
}

// --- chat menu (Signal's header menu and the chat list's context menu) ---

const MUTE_CHOICES = [
  [60 * 60_000, 'Mute for one hour'],
  [8 * 60 * 60_000, 'Mute for eight hours'],
  [24 * 60 * 60_000, 'Mute for one day'],
  [7 * 24 * 60 * 60_000, 'Mute for one week'],
  [null, 'Mute always'],
];

const TIMER_CHOICES = [
  [0, 'Off'],
  [30, '30 seconds'],
  [5 * 60, '5 minutes'],
  [60 * 60, '1 hour'],
  [8 * 60 * 60, '8 hours'],
  [24 * 60 * 60, '1 day'],
  [7 * 24 * 60 * 60, '1 week'],
  [4 * 7 * 24 * 60 * 60, '4 weeks'],
];

function canManageChats() {
  return capabilities.includes('conversations.manage');
}

async function changeConversation(conversationId, change) {
  try {
    await api('api/conversation', { conversationId, change });
  } catch (error) {
    toast(
      change.action === 'pin' && error.code === 'PRECONDITION_FAILED'
        ? 'You can only pin up to 4 chats.'
        : `Not changed (${error.code ?? error.message}).`
    );
    return false;
  }
  return true;
}

function mutedUntilText(c) {
  if (!c.mutedUntil) {
    return null;
  }
  // Signal stores "always" as a far-off date.
  if (c.mutedUntil > Date.now() + 10 * 365 * 24 * 3600_000) {
    return 'Muted always';
  }
  const d = new Date(c.mutedUntil);
  const sameDay = d.toDateString() === new Date().toDateString();
  return `Muted until ${
    sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString([], {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
        })
  }`;
}

function timerLabel(seconds) {
  const known = TIMER_CHOICES.find(([v]) => v === seconds);
  if (known) {
    return known[1];
  }
  if (seconds % 86400 === 0) {
    return `${seconds / 86400} days`;
  }
  if (seconds % 3600 === 0) {
    return `${seconds / 3600} hours`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} minutes`;
  }
  return `${seconds} seconds`;
}

// page: null for the main menu, or 'mute' / 'timer'.
function openChatMenu(conversationId, anchor, page = null) {
  const c = conversations.get(conversationId);
  if (!c) {
    return;
  }
  closePopovers();
  const menu = $('more-menu');
  const items = [];
  const add = (iconName, label, action, { keepOpen = false } = {}) => {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.append(
      iconName ? icon(iconName) : el('span', 'icon'),
      el('span', '', label)
    );
    item.addEventListener('click', ev => {
      ev.stopPropagation();
      if (!keepOpen) {
        closePopovers();
      }
      action();
    });
    items.push(item);
  };
  const set = change => changeConversation(c.id, change);

  if (!canManageChats()) {
    items.push(
      el(
        'span',
        'menu-empty',
        'Allow this page to manage chats in Signal to use this menu.'
      )
    );
  } else if (page === 'mute') {
    add('back', 'Back', () => openChatMenu(conversationId, anchor), {
      keepOpen: true,
    });
    items.push(el('div', 'menu-separator'));
    if (c.muted) {
      add('bell', 'Unmute', () => set({ action: 'unmute' }));
    }
    for (const [durationMs, label] of MUTE_CHOICES) {
      add(null, label, () => set({ action: 'mute', durationMs }));
    }
  } else if (page === 'timer') {
    add('back', 'Back', () => openChatMenu(conversationId, anchor), {
      keepOpen: true,
    });
    items.push(el('div', 'menu-separator'));
    const choices = TIMER_CHOICES.some(([v]) => v === c.disappearingSeconds)
      ? TIMER_CHOICES
      : [
          ...TIMER_CHOICES,
          [c.disappearingSeconds, timerLabel(c.disappearingSeconds)],
        ];
    for (const [seconds, label] of choices) {
      add(seconds === c.disappearingSeconds ? 'check' : null, label, () =>
        set({ action: 'disappearingMessages', seconds })
      );
    }
  } else {
    const blocked = c.blocked;
    if (!blocked && !c.messageRequestPending) {
      if (!c.noteToSelf && c.canChangeTimer) {
        add(
          'timer',
          `Disappearing messages: ${timerLabel(c.disappearingSeconds)}`,
          () => openChatMenu(conversationId, anchor, 'timer'),
          { keepOpen: true }
        );
      }
      add(
        'bell',
        c.muted ? (mutedUntilText(c) ?? 'Muted') : 'Mute notifications',
        () => openChatMenu(conversationId, anchor, 'mute'),
        { keepOpen: true }
      );
      if (!c.archived) {
        add(
          c.pinned ? 'unpin' : 'pin',
          c.pinned ? 'Unpin chat' : 'Pin chat',
          () => set({ action: 'pin', value: !c.pinned })
        );
      }
      if (!isUnread(c)) {
        add('unread', 'Mark as unread', () => {
          set({ action: 'markUnread' });
          if (c.id === selectedId) {
            // Signal leaves the chat when you mark it unread.
            closeConversation();
          }
        });
      }
      add('archive', c.archived ? 'Unarchive' : 'Archive', () => {
        set({ action: 'archive', value: !c.archived });
        if (!c.archived && c.id === selectedId) {
          closeConversation();
        }
      });
      items.push(el('div', 'menu-separator'));
    }
    if (c.messageRequestPending && !blocked) {
      add('check', 'Accept', () => set({ action: 'accept' }));
    }
    if (!c.noteToSelf) {
      add('block', blocked ? 'Unblock' : 'Block', () =>
        confirmBlock(c, !blocked)
      );
    }
    add('trash', 'Delete chat', () => confirmDelete(c));
  }
  menu.replaceChildren(...items);
  placePopover(menu, anchor);
}

function confirmBlock(c, block) {
  const group = c.type === 'group';
  const text = block
    ? group
      ? `Block and leave ${displayTitle(c)}? You will no longer receive messages or updates from this group and members won't be able to add you to this group again.`
      : `Block ${displayTitle(c)}? Blocked people won't be able to call you or send you messages.`
    : group
      ? `Unblock ${displayTitle(c)}? Group members will be able to add you to this group again.`
      : `Unblock ${displayTitle(c)}? You will be able to message and call each other.`;
  if (confirm(text)) {
    changeConversation(c.id, { action: block ? 'block' : 'accept' });
  }
}

function confirmDelete(c) {
  const text =
    c.type === 'group'
      ? 'Delete chat? All messages in this chat will be deleted from all your devices. You will still be a member of this group.'
      : 'Delete chat? All messages in this chat will be deleted from all your devices.';
  if (!confirm(text)) {
    return;
  }
  changeConversation(c.id, { action: 'delete' }).then(ok => {
    if (ok && c.id === selectedId) {
      closeConversation();
    }
  });
}

// Back to no chat open, as Signal after archiving or deleting one.
function closeConversation() {
  selectedId = null;
  messages = new Map();
  nextCursor = null;
  closePopovers();
  cancelReply();
  $('chat-head').hidden = true;
  $('messages').hidden = true;
  $('composer').hidden = true;
  $('request-bar').hidden = true;
  $('empty').hidden = false;
  $('message-list').replaceChildren();
  renderConversations();
  renderTitle();
}

// Signal's bar under a message request or blocked chat.
function renderRequestBar() {
  const bar = $('request-bar');
  const c = conversations.get(selectedId);
  if (!c || c.noteToSelf || !(c.blocked || c.messageRequestPending)) {
    bar.hidden = true;
    $('composer').hidden = !c;
    return;
  }
  // As Signal: the bar replaces the composer until the request is answered.
  $('composer').hidden = true;
  const button = (label, cls, action) => {
    const b = el('button', `request-button ${cls}`, label);
    b.type = 'button';
    b.disabled = !canManageChats();
    b.addEventListener('click', action);
    return b;
  };
  const text = c.blocked
    ? c.type === 'group'
      ? 'You blocked this group.'
      : `You blocked ${displayTitle(c)}.`
    : c.type === 'group'
      ? `Do you want to join this group? They won't know you've seen their messages until you accept.`
      : `Let ${displayTitle(c)} message you and share your name and photo with them? They won't know you've seen their messages until you accept.`;
  const actions = el('div', 'request-actions');
  if (c.blocked) {
    actions.append(
      button('Delete', '', () => confirmDelete(c)),
      button('Unblock', 'primary', () => confirmBlock(c, false))
    );
  } else {
    actions.append(
      button('Block', '', () => confirmBlock(c, true)),
      button('Delete', '', () => confirmDelete(c)),
      button('Accept', 'primary', () =>
        changeConversation(c.id, { action: 'accept' })
      )
    );
  }
  bar.replaceChildren(el('p', 'request-text', text), actions);
  bar.hidden = false;
}

function archivedHead() {
  const li = el('li', 'archived-head');
  const back = el('button', 'icon-button', '');
  back.type = 'button';
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  back.append(icon('back'));
  back.addEventListener('click', () => {
    showArchived = false;
    renderConversations();
  });
  li.append(back, el('span', '', 'Archived chats'));
  return li;
}

function archivedLink(count) {
  const li = el('li', 'archived-link');
  const b = el('button', '', `Archived chats (${count})`);
  b.type = 'button';
  b.addEventListener('click', () => {
    showArchived = true;
    renderConversations();
    $('conversations').scrollTop = 0;
  });
  li.append(b);
  return li;
}

function renderChatHeader() {
  const c = conversations.get(selectedId);
  $('chat-title').textContent = c ? displayTitle(c) : '';
  $('chat-avatar').replaceChildren(...(c ? [conversationAvatar(c, 36)] : []));
  const sub = [];
  if (c?.type === 'group' && c.memberCount) {
    sub.push(`${c.memberCount} members`);
  }
  if (c?.muted) {
    sub.push(mutedUntilText(c)?.toLowerCase() ?? 'muted');
  }
  if (c?.disappearingSeconds) {
    sub.push(`disappearing: ${timerLabel(c.disappearingSeconds)}`);
  }
  $('chat-sub').textContent = sub.join(' · ');
  renderRequestBar();
}

async function selectConversation(id) {
  if (id === selectedId) {
    return;
  }
  selectedId = id;
  messages = new Map();
  nextCursor = null;
  collapseSidebar();
  renderDrafts();
  clearExpiryTimers();
  closePopovers();
  cancelReply();
  // Mentions name members of the chat they were typed in.
  dropComposeMentions();
  $('send-error').hidden = true;
  $('empty').hidden = true;
  $('chat-head').hidden = false;
  $('messages').hidden = false;
  $('composer').hidden = false;
  renderChatHeader();
  renderConversations();
  $('message-list').replaceChildren();
  try {
    await loadMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(`Couldn't load messages (${error.code ?? error.message}).`);
  }
  renderTyping();
  focusCompose();
  maybeMarkRead();
}

// Marks the open chat read in Signal, only while the user can see it.
async function maybeMarkRead() {
  const c = conversations.get(selectedId);
  if (markReadInFlight) {
    markReadAgain = true;
    return;
  }
  if (
    !c ||
    document.visibilityState !== 'visible' ||
    !document.hasFocus() ||
    !(c.unreadCount > 0 || c.markedUnread)
  ) {
    return;
  }
  const newest = sortedMessages().at(-1);
  if (!newest) {
    return;
  }
  markReadInFlight = true;
  try {
    await api('api/markRead', {
      conversationId: c.id,
      upToMessageId: newest.id,
    });
  } catch {
    // Signal sends conversation.updated when the count changes; nothing to do.
  } finally {
    markReadInFlight = false;
  }
  if (markReadAgain) {
    markReadAgain = false;
    maybeMarkRead();
  }
}

function showError(text) {
  $('send-error').hidden = false;
  $('send-error').textContent = text;
}

let toastTimer;
function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.hidden = true;
  }, 2000);
}

// --- message actions ---------------------------------------------------------

function closePopovers() {
  $('reaction-picker').hidden = true;
  $('more-menu').hidden = true;
  $('emoji-picker').hidden = true;
  $('reaction-viewer').hidden = true;
  $('mention-picker').hidden = true;
  $('format-menu').hidden = true;
  $('sticker-picker').hidden = true;
}

// anchor: an element, or a rect taken before its element was hidden.
function placePopover(popover, anchor) {
  popover.hidden = false;
  const a =
    'getBoundingClientRect' in anchor ? anchor.getBoundingClientRect() : anchor;
  const p = popover.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, a.left + a.width / 2 - p.width / 2),
    window.innerWidth - p.width - 8
  );
  const above = a.top - p.height - 6;
  const top = Math.max(
    8,
    Math.min(
      above >= 8 ? above : a.bottom + 6,
      window.innerHeight - p.height - 8
    )
  );
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

async function getPreferredReactions() {
  if (!preferredReactions) {
    try {
      preferredReactions = (await api('api/reactions')).emoji;
    } catch {
      return ['❤️', '👍', '👎', '😂', '😮', '😢'];
    }
  }
  return preferredReactions;
}

async function openReactionPicker(m, anchor) {
  closePopovers();
  const picker = $('reaction-picker');
  const mine = m.reactions.find(r => r.fromMe)?.emoji;
  const emoji = await getPreferredReactions();
  picker.replaceChildren(
    ...emoji.map(e => {
      const button = el('button', `pick${e === mine ? ' mine' : ''}`);
      button.type = 'button';
      button.append(el('span', 'emoji', e));
      button.title = e === mine ? 'Remove reaction' : `React ${e}`;
      button.addEventListener('click', ev => {
        ev.stopPropagation();
        closePopovers();
        sendReaction(m, e, e === mine);
      });
      return button;
    }),
    morePicks(m, mine)
  );
  placePopover(picker, anchor);
}

// The ⋯ after the quick reactions: Signal's full picker.
function morePicks(m, mine) {
  const more = el('button', 'pick pick-more');
  more.type = 'button';
  more.title = 'More reactions';
  more.setAttribute('aria-label', 'More reactions');
  more.append(icon('more'));
  more.addEventListener('click', ev => {
    ev.stopPropagation();
    const anchor = $('reaction-picker');
    openEmojiPicker(anchor, e => sendReaction(m, e, e === mine));
  });
  return more;
}

// --- full emoji picker ---------------------------------------------------------

const EMOJI_TABS = [
  ['recent', 'cat-recent', 'Recently used'],
  ['SMILIES_AND_PEOPLE', 'cat-smileys', 'Smileys & people'],
  ['ANIMALS_AND_NATURE', 'cat-animals', 'Animals & nature'],
  ['FOOD_AND_DRINK', 'cat-food', 'Food & drink'],
  ['ACTIVITIES', 'cat-activities', 'Activities'],
  ['TRAVEL_AND_PLACES', 'cat-travel', 'Travel & places'],
  ['OBJECTS', 'cat-objects', 'Objects'],
  ['SYMBOLS', 'cat-symbols', 'Symbols'],
  ['FLAGS', 'cat-flags', 'Flags'],
];

let emojiCatalog = null;
let emojiPick = null;

async function loadEmojiCatalog() {
  emojiCatalog ??= await api('api/emoji');
  return emojiCatalog;
}

function emojiButton(e, label) {
  const button = el('button', 'emoji-cell');
  button.type = 'button';
  button.title = label ? `:${label}:` : e;
  button.append(el('span', 'emoji', e));
  button.addEventListener('click', ev => {
    ev.stopPropagation();
    const pick = emojiPick;
    closePopovers();
    pick?.(e);
  });
  return button;
}

function emojiSection(id, title, cells) {
  const section = el('div', 'emoji-section');
  section.dataset.category = id;
  section.append(
    el('div', 'emoji-section-title', title),
    el('div', 'emoji-grid')
  );
  section.lastChild.append(...cells);
  return section;
}

async function openEmojiPicker(anchorElement, onPick) {
  const anchor = anchorElement.getBoundingClientRect();
  const picker = $('emoji-picker');
  emojiPick = onPick;
  let catalog;
  let recent = [];
  try {
    [catalog, { recent = [] }] = await Promise.all([
      loadEmojiCatalog(),
      api('api/reactions'),
    ]);
  } catch (error) {
    toast(`Couldn't load emoji (${error.code ?? error.message}).`);
    return;
  }
  closePopovers();
  emojiPick = onPick;

  const names = new Map();
  for (const category of catalog.categories) {
    for (const [e, name] of category.emoji) {
      names.set(e, name);
    }
  }

  const search = el('input', 'emoji-search');
  search.type = 'search';
  search.placeholder = 'Search emoji';
  search.autocomplete = 'off';
  search.spellcheck = false;
  const body = el('div', 'emoji-body');
  const tabs = el('div', 'emoji-tabs');

  const sections = [];
  if (recent.length > 0) {
    sections.push(
      emojiSection(
        'recent',
        'Recently Used',
        recent.map(e => emojiButton(e, names.get(e)))
      )
    );
  }
  for (const category of catalog.categories) {
    const title = EMOJI_TABS.find(([id]) => id === category.id)?.[2] ?? '';
    sections.push(
      emojiSection(
        category.id,
        title,
        category.emoji.map(([e, name]) => emojiButton(e, name))
      )
    );
  }
  body.replaceChildren(...sections);

  for (const [id, tabIcon, title] of EMOJI_TABS) {
    const target = sections.find(sec => sec.dataset.category === id);
    if (!target) {
      continue;
    }
    const tab = el('button', 'emoji-tab');
    tab.type = 'button';
    tab.title = title;
    tab.setAttribute('aria-label', title);
    tab.append(icon(tabIcon));
    tab.addEventListener('click', ev => {
      ev.stopPropagation();
      search.value = '';
      body.replaceChildren(...sections);
      body.scrollTop = target.offsetTop - body.offsetTop;
    });
    tabs.append(tab);
  }

  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase().replace(/^:/, '');
    if (query === '') {
      body.replaceChildren(...sections);
      return;
    }
    const words = query.split(/\s+/);
    const found = [];
    for (const [e, name] of names) {
      const label = name.toLowerCase();
      if (words.every(w => label.includes(w))) {
        found.push(emojiButton(e, name));
      }
      if (found.length >= 200) {
        break;
      }
    }
    body.replaceChildren(
      found.length > 0
        ? emojiSection('search', 'Results', found)
        : el('div', 'emoji-none', 'No emoji found')
    );
  });
  search.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      body.querySelector('.emoji-cell')?.click();
    }
  });

  // Signal's skin tone choice, beside the search box.
  const head = el('div', 'emoji-head');
  head.append(search);
  if (canManageSettings() && signalSettings) {
    const current =
      SKIN_TONE_HANDS.find(([tone]) => tone === signalSettings.emojiSkinTone) ??
      SKIN_TONE_HANDS[0];
    const toneButton = el('button', 'emoji-tone-button');
    toneButton.type = 'button';
    toneButton.title = 'Skin tone';
    toneButton.setAttribute('aria-label', 'Skin tone');
    toneButton.append(el('span', 'emoji', current[1]));
    const tones = skinTonePicker(signalSettings.emojiSkinTone, async tone => {
      await changeSetting('emojiSkinTone', tone);
      openEmojiPicker(anchorElement, onPick);
    });
    tones.hidden = true;
    toneButton.addEventListener('click', ev => {
      ev.stopPropagation();
      tones.hidden = !tones.hidden;
    });
    head.append(toneButton);
    picker.replaceChildren(head, tones, body, tabs);
  } else {
    picker.replaceChildren(head, body, tabs);
  }
  placePopover(picker, anchor);
  search.focus();
}

// --- settings -------------------------------------------------------------------

// Signal's own settings (the ones that make sense here), plus the page's
// theme. Account-wide ones change on every device, as in Signal.
let signalSettings = null;
let settingsSection = 'profile';
// Signal's profile (profile.get), and the edits not saved yet.
let signalProfile = null;
let profileDraft = null;
let profileSaving = false;

const SKIN_TONE_HANDS = [
  ['', '✋', 'Default (yellow)'],
  ['1F3FB', '✋🏻', 'Light'],
  ['1F3FC', '✋🏼', 'Medium-light'],
  ['1F3FD', '✋🏽', 'Medium'],
  ['1F3FE', '✋🏾', 'Medium-dark'],
  ['1F3FF', '✋🏿', 'Dark'],
];

const DISAPPEARING_CHOICES = [
  [0, 'Off'],
  [4 * 7 * 86400, '4 weeks'],
  [7 * 86400, '1 week'],
  [86400, '1 day'],
  [8 * 3600, '8 hours'],
  [3600, '1 hour'],
  [300, '5 minutes'],
  [30, '30 seconds'],
];

function canManageSettings() {
  return capabilities.includes('settings.manage');
}

async function loadSettings() {
  if (!canManageSettings()) {
    signalSettings = null;
    return null;
  }
  try {
    ({ settings: signalSettings } = await api('api/settings'));
  } catch {
    // Older Signal: the page works without them.
  }
  return signalSettings;
}

async function loadProfile() {
  if (!canManageSettings()) {
    signalProfile = null;
    return;
  }
  try {
    ({ profile: signalProfile } = await api('api/profile'));
    profileDraft = null;
  } catch {
    // Older Signal: no profile editor.
  }
}

const PROFILE_FIELDS = ['firstName', 'familyName', 'aboutText', 'aboutEmoji'];

function profileValues() {
  return profileDraft ?? signalProfile;
}

function editProfile(field, value) {
  profileDraft = { ...profileValues(), [field]: value };
}

function profileChanged() {
  return (
    profileDraft !== null &&
    PROFILE_FIELDS.some(field => profileDraft[field] !== signalProfile[field])
  );
}

async function saveProfile() {
  const draft = profileValues();
  if (draft.firstName.trim() === '') {
    toast('Your first name is required.');
    return;
  }
  profileSaving = true;
  renderSettings();
  try {
    ({ profile: signalProfile } = await api(
      'api/profile',
      Object.fromEntries(PROFILE_FIELDS.map(field => [field, draft[field]]))
    ));
    profileDraft = null;
    toast('Profile saved.');
  } catch (error) {
    toast(
      error.code === 'INVALID_ARGUMENT'
        ? 'Not saved: a name is up to 26 characters, about up to 140.'
        : `Not saved (${error.code ?? error.message}).`
    );
  }
  profileSaving = false;
  renderSettings();
}

// As Signal's avatar editor: a centered square, at most 512 pixels.
async function squarePhoto(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(side, 512);
  const canvas = document.createElement('canvas');
  canvas.width = out;
  canvas.height = out;
  canvas
    .getContext('2d')
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      out,
      out
    );
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('not an image'))),
      'image/jpeg',
      0.9
    )
  );
}

// photo: a Blob, or null to remove it.
async function changeProfilePhoto(photo) {
  profileSaving = true;
  renderSettings();
  try {
    const res = await fetch('api/profilePhoto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: photo ?? new Blob([]),
    });
    const data = await res.json();
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status}`), {
        code: data.error?.code,
      });
    }
    signalProfile = data.profile;
    toast(photo ? 'Photo changed.' : 'Photo removed.');
  } catch (error) {
    toast(`Photo not changed (${error.code ?? error.message}).`);
  }
  profileSaving = false;
  renderSettings();
}

function pickProfilePhoto() {
  const input = el('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', async () => {
    const [file] = input.files;
    if (!file) {
      return;
    }
    let photo;
    try {
      photo = await squarePhoto(file);
    } catch {
      toast("That file isn't a picture this browser can read.");
      return;
    }
    await changeProfilePhoto(photo);
  });
  input.click();
}

function profileInput(field, placeholder, maxLength) {
  const input = el('input', 'setting-input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  input.value = profileValues()[field];
  input.disabled = profileSaving;
  input.addEventListener('input', () => {
    editProfile(field, input.value);
    $('profile-save').disabled = profileSaving || !profileChanged();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && profileChanged()) {
      saveProfile();
    }
  });
  return input;
}

function profileRows() {
  const p = profileValues();
  const photo = el('div', 'profile-photo');
  photo.append(
    avatar(
      signalProfile.conversationId,
      {
        title: [signalProfile.firstName, signalProfile.familyName].join(' '),
        avatarColor: signalProfile.avatarColor,
        avatarVersion: signalProfile.avatarVersion,
      },
      80
    )
  );
  const photoButtons = el('div', 'profile-photo-buttons');
  const change = el('button', 'setting-button', 'Change photo');
  change.type = 'button';
  change.disabled = profileSaving;
  change.addEventListener('click', pickProfilePhoto);
  photoButtons.append(change);
  if (signalProfile.avatarVersion) {
    const remove = el('button', 'setting-button', 'Remove photo');
    remove.type = 'button';
    remove.disabled = profileSaving;
    remove.addEventListener('click', () => {
      if (confirm('Remove your profile photo?')) {
        changeProfilePhoto(null);
      }
    });
    photoButtons.append(remove);
  }
  photo.append(photoButtons);

  const names = el('div', 'profile-fields');
  names.append(
    profileInput('firstName', 'First name (required)', 26),
    profileInput('familyName', 'Last name (optional)', 26)
  );

  const about = el('div', 'profile-fields profile-about');
  const emoji = el('button', 'profile-emoji');
  emoji.type = 'button';
  emoji.title = 'About emoji';
  emoji.disabled = profileSaving;
  if (p.aboutEmoji) {
    emoji.append(el('span', 'emoji', p.aboutEmoji));
  } else {
    emoji.append(icon('react'));
  }
  emoji.addEventListener('click', ev => {
    ev.stopPropagation();
    openEmojiPicker(emoji, picked => {
      closePopovers();
      editProfile('aboutEmoji', picked);
      renderSettings();
    });
  });
  about.append(
    emoji,
    profileInput('aboutText', 'Write a few words about yourself', 140)
  );
  if (p.aboutEmoji || p.aboutText) {
    const clear = el('button', 'setting-button', 'Clear');
    clear.type = 'button';
    clear.disabled = profileSaving;
    clear.addEventListener('click', () => {
      editProfile('aboutEmoji', '');
      editProfile('aboutText', '');
      renderSettings();
    });
    about.append(clear);
  }

  const actions = el('div', 'profile-actions');
  const save = el(
    'button',
    'setting-button primary',
    profileSaving ? 'Saving…' : 'Save'
  );
  save.id = 'profile-save';
  save.type = 'button';
  save.disabled = profileSaving || !profileChanged();
  save.addEventListener('click', saveProfile);
  actions.append(save);
  if (profileDraft) {
    const cancel = el('button', 'setting-button', 'Cancel');
    cancel.type = 'button';
    cancel.disabled = profileSaving;
    cancel.addEventListener('click', () => {
      profileDraft = null;
      renderSettings();
    });
    actions.append(cancel);
  }

  return [
    photo,
    el('div', 'setting-heading', 'Name'),
    names,
    el('div', 'setting-heading', 'About'),
    about,
    actions,
    settingRow(
      'Username',
      signalProfile.username
        ? 'Change or remove it in Signal on your phone.'
        : 'Set one in Signal on your phone.',
      el('span', 'setting-value', signalProfile.username ?? 'None')
    ),
    el(
      'p',
      'setting-note',
      'Your profile is visible to the people and groups you message, and to anyone you accept a message request from.'
    ),
  ];
}

function blockedRows(blocked) {
  if (blocked.length === 0) {
    return [el('p', 'setting-note', 'Nobody is blocked.')];
  }
  const dateFormat = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const groups = [
    ['Contacts', blocked.filter(b => b.type === 'direct')],
    ['Groups', blocked.filter(b => b.type === 'group')],
  ];
  return groups
    .filter(([, list]) => list.length > 0)
    .flatMap(([heading, list]) => [
      el('div', 'setting-heading', heading),
      ...list.map(b => {
        const row = el('div', 'blocked-row');
        const text = el('div', 'setting-text');
        text.append(el('div', 'setting-label', b.title));
        if (b.blockedAt) {
          text.append(
            el(
              'div',
              'setting-desc',
              `Blocked on ${dateFormat.format(new Date(b.blockedAt))}`
            )
          );
        }
        row.append(avatar(b.conversationId, b, 36, b.type), text);
        return row;
      }),
    ]);
}

async function changeSetting(key, value) {
  try {
    ({ settings: signalSettings } = await api('api/settings', { key, value }));
    if (key === 'emojiSkinTone') {
      emojiCatalog = null;
    }
  } catch (error) {
    toast(`Not changed (${error.code ?? error.message}).`);
  }
  renderSettings();
}

// The page's theme: Signal's light or dark, or the system's.
function pageTheme() {
  try {
    return localStorage.getItem('theme') ?? 'system';
  } catch {
    return 'system';
  }
}

// The stylesheet's dark rules, by their original media query.
const darkRuleMedia = new WeakMap();

function applyTheme(theme) {
  document.documentElement.style.colorScheme =
    theme === 'system' ? 'light dark' : theme;
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSMediaRule)) {
        continue;
      }
      if (!darkRuleMedia.has(rule)) {
        darkRuleMedia.set(rule, rule.media.mediaText);
      }
      const media = darkRuleMedia.get(rule);
      if (!media.includes('prefers-color-scheme: dark')) {
        continue;
      }
      // The dark rules apply always, never, or as the system says.
      rule.media.mediaText =
        theme === 'dark' ? 'all' : theme === 'light' ? 'not all' : media;
    }
  }
}

function setPageTheme(theme) {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Storage blocked; the theme still applies until reload.
  }
  applyTheme(theme);
  renderSettings();
}

function settingRow(label, description, control) {
  const row = el('div', 'setting-row');
  const text = el('div', 'setting-text');
  text.append(el('div', 'setting-label', label));
  if (description) {
    text.append(el('div', 'setting-desc', description));
  }
  row.append(text, control);
  return row;
}

function settingSwitch(checked, onChange, disabled = false) {
  const input = el('input', 'switch');
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function settingSelect(value, choices, onChange, disabled = false) {
  const select = el('select', 'setting-select');
  for (const [v, label] of choices) {
    const option = el('option', '', label);
    option.value = String(v);
    option.selected = String(v) === String(value);
    select.append(option);
  }
  select.disabled = disabled;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function skinTonePicker(value, onPick) {
  const row = el('div', 'tone-picker');
  for (const [tone, hand, label] of SKIN_TONE_HANDS) {
    const b = el('button', `tone${tone === value ? ' active' : ''}`);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-pressed', String(tone === value));
    b.append(el('span', 'emoji', hand));
    b.addEventListener('click', ev => {
      ev.stopPropagation();
      onPick(tone);
    });
    row.append(b);
  }
  return row;
}

function storiesButton(enabled, onChange) {
  const b = el(
    'button',
    `setting-button${enabled ? ' danger' : ''}`,
    enabled ? 'Turn off stories' : 'Turn on stories'
  );
  b.type = 'button';
  b.addEventListener('click', () => {
    if (
      enabled &&
      !confirm(
        'You will no longer be able to share or view stories. Story updates you have recently shared will also be deleted.'
      )
    ) {
      return;
    }
    onChange(!enabled);
  });
  return b;
}

function settingsSections() {
  const s = signalSettings;
  const set = (key, value) => changeSetting(key, value);
  const sections = [];
  if (signalProfile) {
    sections.push({ id: 'profile', title: 'Profile', rows: profileRows });
  }
  sections.push({
    id: 'appearance',
    title: 'Appearance',
    rows: () => [
      settingRow(
        'Theme',
        'For this page. Signal on your phone keeps its own.',
        settingSelect(
          pageTheme(),
          [
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ],
          setPageTheme
        )
      ),
    ],
  });
  if (!s) {
    return sections;
  }
  sections.push(
    {
      id: 'chats',
      title: 'Chats',
      rows: () => [
        settingRow(
          'Default emoji skin tone',
          'Used for emoji with skin tones in the emoji picker.',
          skinTonePicker(s.emojiSkinTone, tone => set('emojiSkinTone', tone))
        ),
        settingRow(
          'Generate link previews',
          'Retrieve link previews directly from websites for messages you send. Applies to all your devices.',
          settingSwitch(s.linkPreviews, v => set('linkPreviews', v))
        ),
        settingRow(
          'Sent media quality',
          'High quality sends photos and videos at full resolution.',
          settingSelect(
            s.sentMediaQuality,
            [
              ['standard', 'Standard'],
              ['high', 'High'],
            ],
            v => set('sentMediaQuality', v)
          )
        ),
        settingRow(
          'Keep muted chats archived',
          'Muted chats that are archived will remain archived when a new message arrives.',
          settingSwitch(s.keepMutedChatsArchived, v =>
            set('keepMutedChatsArchived', v)
          )
        ),
      ],
    },
    {
      id: 'notifications',
      title: 'Notifications',
      rows: () => [
        settingRow(
          'Notification content',
          'What this page shows when a message arrives.',
          settingSelect(
            s.notificationContent,
            [
              ['message', 'Name, content, and actions'],
              ['name', 'Name only'],
              ['count', 'No name or content'],
              ['off', 'Off'],
            ],
            v => set('notificationContent', v)
          )
        ),
        settingRow(
          'Notification sound',
          "Play Signal's sound with each notification.",
          settingSwitch(s.notificationSound, v => set('notificationSound', v))
        ),
        settingRow(
          'Reaction notifications',
          'Notify when someone reacts to your messages. Applies to all your devices.',
          settingSwitch(s.reactionNotifications, v =>
            set('reactionNotifications', v)
          )
        ),
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      rows: () => [
        settingRow(
          'Read receipts',
          "If read receipts are disabled, you won't be able to see read receipts from others. Applies to all your devices.",
          settingSwitch(s.readReceipts, v => set('readReceipts', v))
        ),
        settingRow(
          'Typing indicators',
          "If typing indicators are disabled, you won't be able to see typing indicators from others. Applies to all your devices.",
          settingSwitch(s.typingIndicators, v => set('typingIndicators', v))
        ),
        settingRow(
          'Default timer for new chats',
          'Set a default disappearing message timer for all new chats started by you.',
          settingSelect(
            s.disappearingMessagesSeconds,
            DISAPPEARING_CHOICES.some(
              ([v]) => v === s.disappearingMessagesSeconds
            )
              ? DISAPPEARING_CHOICES
              : [
                  ...DISAPPEARING_CHOICES,
                  [s.disappearingMessagesSeconds, 'Custom (set in Signal)'],
                ],
            v => set('disappearingMessagesSeconds', Number(v))
          )
        ),
        settingRow(
          'Who can see my phone number',
          'Applies to all your devices.',
          settingSelect(
            s.phoneNumberSharing,
            [
              ['everybody', 'Everyone'],
              ['nobody', 'Nobody'],
            ],
            v => set('phoneNumberSharing', v)
          )
        ),
        settingRow(
          'Who can find me by number',
          s.phoneNumberSharing === 'everybody'
            ? 'Everyone can, while everyone can see your number.'
            : 'Applies to all your devices.',
          settingSelect(
            s.phoneNumberDiscoverable ? 'everybody' : 'nobody',
            [
              ['everybody', 'Everyone'],
              ['nobody', 'Nobody'],
            ],
            v => set('phoneNumberDiscoverable', v === 'everybody'),
            s.phoneNumberSharing === 'everybody'
          )
        ),
        settingRow(
          'Show status icon',
          'Show an icon in message details when messages were delivered using sealed sender. Applies to all your devices.',
          settingSwitch(s.sealedSenderIndicators, v =>
            set('sealedSenderIndicators', v)
          )
        ),
        settingRow(
          'Stories',
          s.storiesEnabled
            ? 'Turning stories off deletes the stories you shared, and you will no longer share or view them. Applies to all your devices.'
            : 'Stories are off. Applies to all your devices.',
          storiesButton(s.storiesEnabled, v => set('storiesEnabled', v))
        ),
      ],
    },
    {
      id: 'blocked',
      title: 'Blocked',
      rows: () => [
        el(
          'p',
          'setting-note',
          "Blocked people and groups can't message or call you. Unblock one from its chat."
        ),
        ...blockedRows(s.blocked ?? []),
      ],
    },
    {
      id: 'data',
      title: 'Data usage',
      rows: () => [
        el(
          'div',
          'setting-heading',
          'Media auto-download (on the computer running Signal)'
        ),
        ...[
          ['photos', 'Images'],
          ['videos', 'Videos'],
          ['audio', 'Audio'],
          ['documents', 'Documents'],
        ].map(([kind, label]) =>
          settingRow(
            label,
            null,
            settingSwitch(s.autoDownload[kind], v =>
              set('autoDownload', { ...s.autoDownload, [kind]: v })
            )
          )
        ),
      ],
    }
  );
  sections.push({
    id: 'elsewhere',
    title: 'In Signal on your phone',
    rows: () => [
      el(
        'p',
        'setting-note',
        'Linked devices, backups, changing your number and deleting data stay in Signal itself, so one click in a browser tab can never lock you out.'
      ),
    ],
  });
  return sections;
}

function renderSettings() {
  if ($('settings').hidden) {
    return;
  }
  const sections = settingsSections();
  const current =
    sections.find(section => section.id === settingsSection) ?? sections[0];
  $('settings-nav').replaceChildren(
    ...sections.map(section => {
      const b = el(
        'button',
        `settings-tab${section === current ? ' active' : ''}`,
        section.title
      );
      b.type = 'button';
      b.addEventListener('click', () => {
        settingsSection = section.id;
        renderSettings();
      });
      return b;
    })
  );
  const page = $('settings-page');
  page.replaceChildren(
    el('h2', 'settings-heading', current.title),
    ...current.rows()
  );
  if (!signalSettings && canManageSettings()) {
    page.append(el('p', 'setting-note', "Couldn't load Signal's settings."));
  } else if (!canManageSettings()) {
    page.append(
      el(
        'p',
        'setting-note',
        "Signal's own settings appear here once this page is allowed to manage them (Signal asks when the helper reconnects)."
      )
    );
  }
}

async function openSettings() {
  closePopovers();
  $('settings').hidden = false;
  renderSettings();
  await Promise.all([loadSettings(), loadProfile()]);
  renderSettings();
}

function closeSettings() {
  $('settings').hidden = true;
}

// --- stickers -------------------------------------------------------------------

// As Signal's sticker picker: Recently used, then each installed pack, and a
// sticker is sent as soon as it is picked.
const STICKER_CELL_PX = 72;
let stickerTab = null;

function stickerImageUrl(packId, stickerId, size) {
  const params = new URLSearchParams({
    packId,
    stickerId: String(stickerId),
    width: String(Math.round(size * (window.devicePixelRatio || 1))),
  });
  return `api/stickerImage?${params}`;
}

function stickerImage(packId, stickerId, size, label) {
  const img = el('img', 'sticker-img');
  img.loading = 'lazy';
  img.alt = label ?? '';
  img.src = stickerImageUrl(packId, stickerId, size);
  return img;
}

async function sendSticker(packId, stickerId) {
  const conversationId = selectedId;
  if (!conversationId) {
    return;
  }
  closePopovers();
  $('send-error').hidden = true;
  try {
    await api('api/sendSticker', { conversationId, packId, stickerId });
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(
      SEND_ERRORS[error.reason] ?? `Not sent (${error.code ?? error.message}).`
    );
  }
}

async function openStickerPicker(anchorElement) {
  const anchor = anchorElement.getBoundingClientRect();
  let data;
  try {
    data = await api('api/stickers');
  } catch (error) {
    toast(`Couldn't load stickers (${error.code ?? error.message}).`);
    return;
  }
  closePopovers();
  const picker = $('sticker-picker');
  const tabs = el('div', 'sticker-tabs');
  const title = el('div', 'emoji-section-title');
  const grid = el('div', 'sticker-grid');
  const body = el('div', 'emoji-body');
  body.append(title, grid);

  const sources = [];
  if (data.recents.length > 0) {
    sources.push({
      key: 'recent',
      title: 'Recently used',
      stickers: data.recents.map(r => ({
        packId: r.packId,
        id: r.stickerId,
        emoji: r.emoji,
      })),
    });
  }
  for (const pack of data.packs) {
    sources.push({
      key: pack.id,
      title: pack.author ? `${pack.title} · ${pack.author}` : pack.title,
      pack,
      stickers: pack.stickers.map(st => ({ ...st, packId: pack.id })),
    });
  }

  const show = source => {
    stickerTab = source.key;
    title.textContent = source.title;
    grid.replaceChildren(
      ...source.stickers.map(st => {
        const cell = el('button', 'sticker-cell');
        cell.type = 'button';
        cell.title = st.emoji ?? '';
        cell.append(stickerImage(st.packId, st.id, STICKER_CELL_PX, st.emoji));
        cell.addEventListener('click', ev => {
          ev.stopPropagation();
          sendSticker(st.packId, st.id);
        });
        return cell;
      })
    );
    body.scrollTop = 0;
    for (const tab of tabs.children) {
      tab.classList.toggle('active', tab.dataset.key === source.key);
    }
  };

  for (const source of sources) {
    const tab = el('button', 'sticker-tab');
    tab.type = 'button';
    tab.dataset.key = source.key;
    tab.title = source.title;
    tab.setAttribute('aria-label', source.title);
    if (source.pack) {
      const cover = source.pack.coverStickerId ?? source.stickers[0]?.id;
      if (cover !== undefined) {
        const img = stickerImage(source.pack.id, cover, 28, '');
        // A cover Signal hasn't fetched yet: the first sticker instead.
        const first = source.stickers[0]?.id;
        img.addEventListener(
          'error',
          () => {
            if (first !== undefined && first !== cover) {
              img.src = stickerImageUrl(source.pack.id, first, 28);
            }
          },
          { once: true }
        );
        tab.append(img);
      }
    } else {
      tab.append(icon('cat-recent'));
    }
    tab.addEventListener('click', ev => {
      ev.stopPropagation();
      show(source);
    });
    tabs.append(tab);
  }

  if (sources.length === 0) {
    picker.replaceChildren(
      el(
        'div',
        'emoji-none',
        'No sticker packs installed. Add some in Signal (Stickers, then the + button).'
      )
    );
  } else {
    picker.replaceChildren(body, tabs);
    show(sources.find(source => source.key === stickerTab) ?? sources[0]);
  }
  placePopover(picker, anchor);
}

// The composer's emoji button inserts at the cursor.
function insertEmoji(e) {
  insertPlain(e);
  // Into Signal's recently used list, as its own picker does.
  api('api/emojiUsed', { emoji: e }).catch(() => {});
}

async function sendReaction(m, emoji, remove) {
  try {
    await api('api/react', { messageId: m.id, emoji, remove });
  } catch (error) {
    toast(
      SEND_ERRORS[error.reason] ??
        `Couldn't react (${error.code ?? error.message}).`
    );
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = el('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('Copied');
}

function openMoreMenu(m, anchor) {
  closePopovers();
  const menu = $('more-menu');
  const items = [];
  const add = (iconName, label, action) => {
    const item = el('button', 'menu-item');
    item.type = 'button';
    item.append(icon(iconName), el('span', '', label));
    item.addEventListener('click', ev => {
      ev.stopPropagation();
      closePopovers();
      action();
    });
    items.push(item);
  };
  if (m.kind === 'text' && m.body) {
    add('copy', 'Copy text', () => copyText(plainText(m)));
  }
  if (canReplyTo(m)) {
    add('reply', 'Reply', () => startReply(m));
  }
  if (canForward(m)) {
    add('forward', 'Forward', () => openForward(m));
  }
  if (m.poll && canSend()) {
    add('forward', 'Send this poll to…', () =>
      openPollForward(
        {
          question: m.poll.question,
          options: m.poll.options.map(option => option.text),
          allowMultiple: m.poll.allowMultiple,
        },
        []
      )
    );
  }
  if (m.poll?.canEnd && canSend()) {
    add('poll', 'End poll', () => endPoll(m));
  }
  if (m.canEdit) {
    add('edit', 'Edit', () => startEdit(m));
  }
  add('trash', 'Delete for me', () => deleteMessage(m, false));
  if (m.canDeleteForEveryone) {
    add('trash', 'Delete for everyone', () => deleteMessage(m, true));
  }
  if (items.length === 0) {
    items.push(el('span', 'menu-empty', 'Nothing to do here'));
  }
  menu.replaceChildren(...items);
  placePopover(menu, anchor);
}

function startReply(m) {
  replyTo = m;
  const quote = $('reply-quote');
  const name =
    m.direction === 'outgoing' ? 'You' : nameOf(m.authorConversationId);
  quote.replaceChildren(
    nameLine(
      name,
      m.direction === 'outgoing' ? null : m.author,
      'quote-author'
    ),
    el('span', 'quote-text', summarize(m))
  );
  quote.className = 'reply-quote';
  if (m.direction !== 'outgoing' && m.author?.nameColor) {
    quote.classList.add(`nc-${m.author.nameColor}`);
  }
  $('reply-bar').hidden = false;
  focusCompose();
}

function cancelReply() {
  const wasEditing = editing !== null;
  replyTo = null;
  editing = null;
  $('reply-bar').hidden = true;
  $('reply-bar').classList.remove('editing');
  if (wasEditing) {
    setCompose('');
  }
}

// Edit mode reuses the reply bar to show what is being edited.
function startEdit(m) {
  cancelReply();
  editing = m;
  const quote = $('reply-quote');
  quote.className = 'reply-quote';
  quote.replaceChildren(
    el('span', 'quote-author', 'Edit message'),
    el('span', 'quote-text', summarize(m))
  );
  $('reply-bar').classList.add('editing');
  $('reply-bar').hidden = false;
  setCompose(m.body ?? '', m.mentions ?? [], m.formatting ?? []);
  focusCompose({ end: true });
}

async function deleteMessage(m, forEveryone) {
  const question = forEveryone
    ? 'Delete this message for everyone?'
    : 'Delete this message for you?';
  if (!window.confirm(question)) {
    return;
  }
  try {
    await api('api/delete', { messageId: m.id, forEveryone });
    if (!forEveryone && messages.delete(m.id)) {
      renderMessages();
    }
  } catch (error) {
    toast(`Not deleted (${error.code ?? error.message}).`);
  }
}

// --- notifications -----------------------------------------------------------

function notify(m) {
  const c = conversations.get(m.conversationId);
  if (!c || c.muted || m.direction !== 'incoming') {
    return;
  }
  if (document.hasFocus() && selectedId === m.conversationId) {
    return;
  }
  if (!('Notification' in window) || Notification.permission === 'denied') {
    return;
  }
  // Signal's "Notification content" setting.
  const content = signalSettings?.notificationContent ?? 'message';
  if (content === 'off') {
    return;
  }
  const show = () => {
    const text = summarize(m);
    let title = displayTitle(c);
    let body =
      c.type === 'group' ? `${nameOf(m.authorConversationId)}: ${text}` : text;
    if (content === 'name') {
      body = 'New message';
    } else if (content === 'count') {
      title = 'Signal';
      body = 'New message';
    }
    if (signalSettings?.notificationSound) {
      new Audio('sounds/notification.ogg').play().catch(() => {});
    }
    const n = new Notification(title, {
      body: body.length > 200 ? `${body.slice(0, 199)}…` : body,
      tag: m.conversationId,
      icon:
        content !== 'count' && c.avatarVersion
          ? `api/avatar?${new URLSearchParams({ conversationId: c.id, v: c.avatarVersion })}`
          : 'icon.svg',
    });
    n.addEventListener('click', () => {
      window.focus();
      selectConversation(m.conversationId);
    });
  };
  if (Notification.permission === 'granted') {
    show();
  } else {
    Notification.requestPermission().then(p => {
      if (p === 'granted') {
        show();
      }
    });
  }
}

// --- live updates --------------------------------------------------------------

async function loadState() {
  const state = await api('api/state');
  bridgeState = state.state;
  capabilities = state.capabilities ?? [];
  loadSettings();
  preferredReactions = null;
  conversations.clear();
  rowCache.clear();
  for (const c of state.conversations) {
    conversations.set(c.id, c);
  }
  renderBanner();
  renderTitle();
  renderConversations();
  if (selectedId && !conversations.has(selectedId)) {
    selectedId = null;
    cancelReply();
    $('empty').hidden = false;
    $('chat-head').hidden = true;
    $('messages').hidden = true;
    $('composer').hidden = true;
  } else if (selectedId && bridgeState === 'ready') {
    renderChatHeader();
    messages = new Map();
    clearExpiryTimers();
    await loadMessages();
  }
}

const HELPER_DOWN_AFTER_MS = 60_000;
const MAX_RECONNECT_DELAY_MS = 5_000;
let disconnectedSince = null;
let reconnectDelay = 1000;
let reconnectTimer = null;

function connectEvents() {
  const source = new EventSource('api/events');
  const on = (type, handler) =>
    source.addEventListener(type, e => handler(JSON.parse(e.data)));

  on('hello', () => {
    helperConnected = true;
    disconnectedSince = null;
    reconnectDelay = 1000;
    renderBanner();
    loadState().catch(() => {});
  });
  on('resync', () => loadState().catch(() => {}));
  on('state', ({ state }) => {
    bridgeState = state;
    if (state !== 'ready') {
      typingIn.clear();
      conversations.clear();
      renderConversations();
      renderTitle();
    }
    renderBanner();
  });
  on('conversation.updated', c => {
    conversations.set(c.id, c);
    renderConversations();
    renderTitle();
    if (c.id === selectedId) {
      renderChatHeader();
      maybeMarkRead();
    }
  });
  on('typing.changed', ({ conversationId, typists }) => {
    for (const t of typists) {
      if (t.author) {
        authors.set(t.authorConversationId, t.author);
      }
    }
    if (typists.length > 0) {
      typingIn.set(conversationId, typists);
    } else {
      typingIn.delete(conversationId);
    }
    renderConversations();
    if (conversationId === selectedId) {
      renderTyping();
    }
  });
  on('conversation.removed', ({ conversationId }) => {
    conversations.delete(conversationId);
    rowCache.delete(conversationId);
    renderConversations();
    renderTitle();
  });
  on('message.added', m => {
    rememberAuthors(m);
    if (m.conversationId === selectedId) {
      putMessage(m);
      renderMessages();
      maybeMarkRead();
    }
    notify(m);
  });
  on('message.updated', m => {
    if (m.conversationId === selectedId && messages.has(m.id)) {
      putMessage(m);
      renderMessages();
    }
  });
  on('message.removed', ({ messageId }) => {
    if (messages.delete(messageId)) {
      renderMessages();
    }
  });
  source.addEventListener('error', () => {
    helperConnected = false;
    disconnectedSince ??= Date.now();
    renderBanner();
    // EventSource retries a dropped stream by itself, but gives up for good
    // when the reconnect gets an error status (a reverse proxy's 502 while
    // the helper restarts). Start over then, backing off up to 5 s.
    if (source.readyState === EventSource.CLOSED) {
      source.close();
      clearTimeout(reconnectTimer);
      const delay = reconnectDelay * (0.8 + Math.random() * 0.4);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      reconnectTimer = setTimeout(connectEvents, delay);
    }
  });
}

// --- composer ------------------------------------------------------------------

async function sendCurrent() {
  const {
    body: rawBody,
    mentions: rawMentions,
    formatting: rawFormatting,
  } = composeForSend();
  const conversationId = selectedId;
  const files = editing ? [] : draftsFor(conversationId);
  if (!conversationId || (rawBody.trim() === '' && files.length === 0)) {
    return;
  }
  // A caption is trimmed; mentions move with it.
  const lead =
    files.length > 0 ? rawBody.length - rawBody.trimStart().length : 0;
  const body = files.length > 0 ? rawBody.trim() : rawBody;
  const mentions = rawMentions
    .map(mention => ({ ...mention, start: mention.start - lead }))
    .filter(mention => mention.start >= 0 && mention.start < body.length);
  const formatting = rawFormatting.flatMap(range => {
    const start = Math.max(0, range.start - lead);
    const end = Math.min(body.length, range.start + range.length - lead);
    return end > start ? [{ ...range, start, length: end - start }] : [];
  });
  const withMentions = {
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(formatting.length > 0 ? { formatting } : {}),
  };
  $('send').disabled = true;
  $('send-error').hidden = true;
  try {
    if (editing) {
      await api('api/edit', { messageId: editing.id, body, ...withMentions });
      cancelReply();
      setCompose('');
      return;
    }
    const attachmentUploadIds = [];
    for (const [i, draft] of files.entries()) {
      $('send').textContent =
        files.length > 1 ? `${i + 1}/${files.length}` : '…';
      // oxlint-disable-next-line no-await-in-loop
      attachmentUploadIds.push(await uploadFile(draft.file));
    }
    const { message } = await api('api/send', {
      conversationId,
      body,
      ...withMentions,
      ...(replyTo ? { quoteMessageId: replyTo.id } : {}),
      ...(attachmentUploadIds.length > 0 ? { attachmentUploadIds } : {}),
    });
    clearDrafts(conversationId);
    setCompose('');
    cancelReply();
    // Events can get here first with a newer status (Sent); keep that.
    if (!messages.has(message.id)) {
      putMessage(message);
    }
    renderMessages();
    $('messages').scrollTop = $('messages').scrollHeight;
  } catch (error) {
    showError(
      SEND_ERRORS[error.reason] ?? `Not sent (${error.code ?? error.message}).`
    );
  } finally {
    $('send').disabled = false;
    $('send').textContent = 'Send';
    focusCompose();
  }
}

// --- message box: mentions and formatting ----------------------------------------

// The box is editable HTML so it can show styles and mentions as Signal's
// does. What it holds is read back as a list of characters, each with its
// styles and, for a mention, who it names; that list is what gets sent.
const MENTION_PLACEHOLDER = '￼';
const STYLES = ['bold', 'italic', 'strikethrough', 'monospace', 'spoiler'];
const STYLE_LABEL = {
  bold: 'Bold',
  italic: 'Italic',
  strikethrough: 'Strikethrough',
  monospace: 'Monospace',
  spoiler: 'Spoiler',
};
// Signal's own shortcuts (ts/quill/formatting/menu.dom.tsx).
const STYLE_SHORTCUT = {
  bold: 'Ctrl+B',
  italic: 'Ctrl+I',
  strikethrough: 'Ctrl+Shift+X',
  monospace: 'Ctrl+E',
  spoiler: 'Ctrl+Shift+B',
};
const CLASS_STYLE = Object.fromEntries(
  Object.entries(STYLE_CLASS).map(([style, cls]) => [cls, style])
);
const TAG_STYLE = {
  B: 'bold',
  STRONG: 'bold',
  I: 'italic',
  EM: 'italic',
  S: 'strikethrough',
  STRIKE: 'strikethrough',
  DEL: 'strikethrough',
  CODE: 'monospace',
};
// The last selection in the box, as character offsets; the emoji picker
// takes the focus away and still inserts here.
let composeSelection = null;
// conversationId -> Promise of [{ conversationId, author }]
const memberCache = new Map();
let mentionQuery = null;
let mentionChoices = [];
let mentionIndex = 0;

function composeBox() {
  return $('compose');
}

// [{ ch, styles: Set, mention?: { conversationId, title } }]
function readNodes(root, { dropPlaceholder }) {
  const chars = [];
  const leaves = [];
  const walk = (node, styles) => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.data.replaceAll(MENTION_PLACEHOLDER, '')) {
        chars.push({ ch: ch === ' ' ? ' ' : ch, styles });
      }
      leaves.push(node);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    if (node.tagName === 'BR') {
      chars.push({ ch: '\n', styles });
      leaves.push(node);
      return;
    }
    if (node.dataset.cid) {
      chars.push({
        ch: MENTION_PLACEHOLDER,
        styles,
        mention: {
          conversationId: node.dataset.cid,
          title: node.dataset.title,
        },
      });
      leaves.push(node);
      return;
    }
    let inner = styles;
    const add = [
      TAG_STYLE[node.tagName],
      ...[...node.classList].map(cls => CLASS_STYLE[cls]),
    ].filter(Boolean);
    if (add.length > 0) {
      inner = new Set([...styles, ...add]);
    }
    const block = node !== root && /^(DIV|P|LI)$/.test(node.tagName);
    if (block && chars.length > 0 && chars.at(-1).ch !== '\n') {
      chars.push({ ch: '\n', styles: new Set() });
    }
    for (const child of node.childNodes) {
      walk(child, inner);
    }
  };
  walk(root, new Set());
  // A <br> at the very end only holds the caret on an empty last line.
  if (dropPlaceholder && leaves.at(-1)?.nodeName === 'BR') {
    chars.pop();
  }
  return chars;
}

function readCompose() {
  return readNodes(composeBox(), { dropPlaceholder: true });
}

// Where a DOM point falls, counted in characters.
function offsetAt(container, offset) {
  const box = composeBox();
  const range = document.createRange();
  range.setStart(box, 0);
  range.setEnd(container, offset);
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  return readNodes(holder, { dropPlaceholder: false }).length;
}

function selectionOffsets() {
  const box = composeBox();
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    return null;
  }
  const range = sel.getRangeAt(0);
  if (
    !box.contains(range.startContainer) ||
    !box.contains(range.endContainer)
  ) {
    return null;
  }
  const a = offsetAt(range.startContainer, range.startOffset);
  const b = offsetAt(range.endContainer, range.endOffset);
  const length = readCompose().length;
  return { start: Math.min(a, length), end: Math.min(b, length) };
}

// The DOM point for a character offset, in a box this code drew.
function pointAt(target) {
  const box = composeBox();
  let at = 0;
  const leaves = [];
  const walk = node => {
    if (
      node.nodeType === Node.TEXT_NODE ||
      node.nodeName === 'BR' ||
      node.dataset?.cid
    ) {
      leaves.push(node);
      return;
    }
    for (const child of node.childNodes) {
      walk(child);
    }
  };
  walk(box);
  for (const leaf of leaves) {
    if (leaf.nodeType === Node.TEXT_NODE) {
      // Offsets here count characters; the DOM counts UTF-16 units.
      const cps = [...leaf.data];
      if (target <= at + cps.length) {
        return [leaf, cps.slice(0, target - at).join('').length];
      }
      at += cps.length;
    } else {
      if (target <= at) {
        return [leaf.parentNode, [...leaf.parentNode.childNodes].indexOf(leaf)];
      }
      at += 1;
    }
  }
  return [box, box.childNodes.length];
}

function selectOffsets(start, end = start) {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(...pointAt(start));
  range.setEnd(...pointAt(end));
  sel.removeAllRanges();
  sel.addRange(range);
  composeSelection = { start, end };
}

function styleKey(styles) {
  return STYLES.filter(s => styles.has(s)).join(' ');
}

// Draws the characters back into the box: one span per run of styles.
function drawCompose(chars) {
  const box = composeBox();
  const nodes = [];
  let run = null;
  let runKey = null;
  const holder = styles => {
    const key = styleKey(styles);
    if (key === '') {
      run = null;
      runKey = null;
      return null;
    }
    if (run && runKey === key) {
      return run;
    }
    run = el(
      'span',
      STYLES.filter(s => styles.has(s))
        .map(s => STYLE_CLASS[s])
        .join(' ')
    );
    runKey = key;
    nodes.push(run);
    return run;
  };
  const put = (parent, node) => {
    if (parent) {
      parent.append(node);
    } else {
      nodes.push(node);
    }
  };
  let text = '';
  let textStyles = null;
  const flush = () => {
    if (text) {
      put(holder(textStyles), document.createTextNode(text));
      text = '';
    }
  };
  for (const c of chars) {
    if (c.mention) {
      flush();
      const pill = el('span', 'mention', `@${c.mention.title ?? 'Someone'}`);
      pill.contentEditable = 'false';
      pill.dataset.cid = c.mention.conversationId;
      pill.dataset.title = c.mention.title ?? 'Someone';
      put(holder(c.styles), pill);
    } else if (c.ch === '\n') {
      flush();
      run = null;
      runKey = null;
      nodes.push(el('br'));
    } else {
      if (textStyles && styleKey(textStyles) !== styleKey(c.styles)) {
        flush();
      }
      textStyles = c.styles;
      text += c.ch;
    }
  }
  flush();
  if (chars.at(-1)?.ch === '\n') {
    nodes.push(el('br'));
  }
  box.replaceChildren(...nodes);
}

function charsOf(text, styles = new Set()) {
  return [
    ...text.replaceAll(MENTION_PLACEHOLDER, '').replace(/\r\n?/g, '\n'),
  ].map(ch => ({ ch, styles }));
}

// Messages hold U+FFFC where a mention is, plus ranges for styles.
function setCompose(text, mentions = [], formatting = []) {
  const byStart = new Map(mentions.map(m => [m.start, m]));
  const chars = [];
  let i = 0;
  for (const ch of text) {
    const styles = new Set(
      formatting
        .filter(r => r.start <= i && i < r.start + r.length)
        .map(r => r.style)
        .filter(s => STYLES.includes(s))
    );
    const mention = byStart.get(i);
    if (ch === MENTION_PLACEHOLDER && mention?.conversationId) {
      chars.push({
        ch,
        styles,
        mention: {
          conversationId: mention.conversationId,
          title: mention.title ?? 'Someone',
        },
      });
    } else if (ch === MENTION_PLACEHOLDER) {
      // A mention of someone the page can't name again: keep the words.
      chars.push(...charsOf(`@${mention?.title ?? 'Someone'}`, styles));
    } else {
      chars.push({ ch, styles });
    }
    i += ch.length;
  }
  drawCompose(chars);
  composeSelection = null;
}

// Replaces start..end with the given characters, then puts the caret after.
function spliceCompose(start, end, inserted) {
  const chars = readCompose();
  chars.splice(start, end - start, ...inserted);
  drawCompose(chars);
  composeBox().focus();
  selectOffsets(start + inserted.length);
}

function insertPlain(text) {
  const at = selectionOffsets() ?? composeSelection;
  const length = readCompose().length;
  const start = at?.start ?? length;
  const end = at?.end ?? length;
  spliceCompose(start, end, charsOf(text));
  onComposeInput();
}

// The body as Signal wants it: U+FFFC for each mention, and style ranges.
function composeForSend() {
  const chars = readCompose();
  // Ranges count UTF-16 units, as Signal's do.
  let body = '';
  const mentions = [];
  const formatting = [];
  const open = new Map();
  const units = [];
  for (const c of chars) {
    if (c.mention) {
      mentions.push({
        start: body.length,
        conversationId: c.mention.conversationId,
      });
    }
    units.push({ start: body.length, styles: c.styles });
    body += c.ch;
  }
  units.push({ start: body.length, styles: new Set() });
  for (const unit of units) {
    for (const style of STYLES) {
      if (unit.styles.has(style) && !open.has(style)) {
        open.set(style, unit.start);
      } else if (!unit.styles.has(style) && open.has(style)) {
        const start = open.get(style);
        formatting.push({ start, length: unit.start - start, style });
        open.delete(style);
      }
    }
  }
  return { body, mentions, formatting };
}

// Bold and the rest: on for the whole selection unless all of it has it.
function toggleStyle(style) {
  const at = selectionOffsets();
  if (!at || at.start === at.end) {
    return;
  }
  const chars = readCompose();
  const picked = chars.slice(at.start, at.end);
  const on = !picked.every(c => c.styles.has(style));
  for (let i = at.start; i < at.end; i += 1) {
    const styles = new Set(chars[i].styles);
    if (on) {
      styles.add(style);
    } else {
      styles.delete(style);
    }
    chars[i] = { ...chars[i], styles };
  }
  drawCompose(chars);
  composeBox().focus();
  selectOffsets(at.start, at.end);
  updateFormatBar();
}

function selectionHas(style) {
  const at = selectionOffsets();
  if (!at || at.start === at.end) {
    return false;
  }
  return readCompose()
    .slice(at.start, at.end)
    .every(c => c.styles.has(style));
}

// Mentions name members of one chat; elsewhere they become plain words.
function dropComposeMentions() {
  const chars = readCompose();
  if (!chars.some(c => c.mention)) {
    return;
  }
  drawCompose(
    chars.flatMap(c =>
      c.mention ? charsOf(`@${c.mention.title}`, c.styles) : [c]
    )
  );
}

function focusCompose({ end = false } = {}) {
  const box = composeBox();
  box.focus();
  if (end || !selectionOffsets()) {
    selectOffsets(readCompose().length);
  }
}

// Keeps the empty box truly empty, so the placeholder shows.
// Signal's typing dots.
function typingDots() {
  const dots = el('span', 'typing-dots');
  dots.setAttribute('role', 'img');
  dots.setAttribute('aria-label', 'Typing');
  dots.append(el('span'), el('span'), el('span'));
  return dots;
}

// As Signal's timeline: a bubble with the dots under the last message, with
// the typists' photos in groups.
function renderTyping() {
  const box = $('typing');
  const typists = typingIn.get(selectedId) ?? [];
  if (typists.length === 0) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const messagesBox = $('messages');
  const atBottom =
    messagesBox.scrollHeight -
      messagesBox.scrollTop -
      messagesBox.clientHeight <
    80;
  const conversation = conversations.get(selectedId);
  const row = el('div', 'typing-row');
  if (conversation?.type === 'group') {
    const faces = el('span', 'typing-avatars');
    for (const t of typists.slice(0, 3)) {
      faces.append(
        avatar(
          t.authorConversationId,
          t.author ?? authorOf(t.authorConversationId) ?? { title: '' },
          28
        )
      );
    }
    row.append(faces);
  }
  const bubble = el('span', 'bubble typing-bubble');
  bubble.append(typingDots());
  row.append(bubble);
  const names = typists
    .map(t => (t.author ?? authorOf(t.authorConversationId))?.title)
    .filter(Boolean);
  row.title = names.length ? `${names.join(', ')} typing` : 'Typing';
  box.replaceChildren(row);
  box.hidden = false;
  if (atBottom) {
    messagesBox.scrollTop = messagesBox.scrollHeight;
  }
}

// Tells Signal we're typing, at most once a second; Signal itself refreshes,
// pauses after three seconds and honors the typing indicators setting.
let typingSentAt = 0;
let typingFor = null;

function sendTyping(typing) {
  if (!capabilities.includes('typing.send') || !selectedId) {
    return;
  }
  const now = Date.now();
  if (typing) {
    if (typingFor === selectedId && now - typingSentAt < 1000) {
      return;
    }
    typingSentAt = now;
    typingFor = selectedId;
  } else {
    if (typingFor !== selectedId) {
      return;
    }
    typingFor = null;
  }
  api('api/typing', { conversationId: selectedId, typing }).catch(() => {});
}

function onComposeInput() {
  const box = composeBox();
  if (box.childNodes.length > 0 && readCompose().length === 0) {
    box.replaceChildren();
  }
  sendTyping(box.childNodes.length > 0);
  updateMentionPicker();
  updateFormatBar();
}

// --- format bar and menu -------------------------------------------------------

function styleButton(style, onClick) {
  const b = el('button', `format-button fb-${style}`);
  b.type = 'button';
  b.title = `${STYLE_LABEL[style]} (${STYLE_SHORTCUT[style]})`;
  b.setAttribute('aria-label', STYLE_LABEL[style]);
  b.append(el('span', STYLE_CLASS[style], STYLE_LABEL[style][0]));
  b.addEventListener('mousedown', e => {
    // Keep the selection in the box.
    e.preventDefault();
  });
  b.addEventListener('click', e => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function updateFormatBar() {
  const bar = $('format-bar');
  const box = composeBox();
  const at = document.activeElement === box ? selectionOffsets() : null;
  if (!at || at.start === at.end || !$('format-menu').hidden) {
    bar.hidden = true;
    return;
  }
  if (bar.childElementCount === 0) {
    bar.append(
      ...STYLES.map(style => styleButton(style, () => toggleStyle(style)))
    );
  }
  for (const style of STYLES) {
    bar
      .querySelector(`.fb-${style}`)
      .classList.toggle('active', selectionHas(style));
  }
  bar.hidden = false;
  const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, rect.left + rect.width / 2 - b.width / 2),
    window.innerWidth - b.width - 8
  );
  bar.style.left = `${left}px`;
  bar.style.top = `${Math.max(8, rect.top - b.height - 8)}px`;
}

async function pasteFromClipboard() {
  try {
    insertPlain(await navigator.clipboard.readText());
  } catch {
    toast('Press Ctrl+V to paste.');
  }
}

// Right-click on selected text: Signal's styles, plus cut, copy and paste.
// Shift+right-click still gives the browser's own menu.
function openFormatMenu(x, y) {
  closePopovers();
  const menu = $('format-menu');
  const item = (label, shortcut, action, checked = null) => {
    const b = el('button', 'menu-item');
    b.type = 'button';
    b.setAttribute('role', checked === null ? 'menuitem' : 'menuitemcheckbox');
    if (checked !== null) {
      b.setAttribute('aria-checked', String(checked));
    }
    b.append(
      el('span', 'format-check', checked ? '✓' : ''),
      el('span', 'format-label', label),
      el('span', 'format-shortcut', shortcut)
    );
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', e => {
      e.stopPropagation();
      closeFormatMenu();
      action();
    });
    return b;
  };
  menu.replaceChildren(
    item('Cut', 'Ctrl+X', () => document.execCommand('cut')),
    item('Copy', 'Ctrl+C', () => document.execCommand('copy')),
    item('Paste', 'Ctrl+V', () => pasteFromClipboard()),
    el('div', 'menu-separator'),
    ...STYLES.map(style =>
      item(
        STYLE_LABEL[style],
        STYLE_SHORTCUT[style],
        () => toggleStyle(style),
        selectionHas(style)
      )
    )
  );
  $('format-bar').hidden = true;
  menu.hidden = false;
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - m.width - 8)}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - m.height - 8))}px`;
}

function closeFormatMenu() {
  $('format-menu').hidden = true;
}

// --- @mentions -----------------------------------------------------------------

function loadMembers(conversationId) {
  if (!memberCache.has(conversationId)) {
    const params = new URLSearchParams({ conversationId });
    const request = api(`api/members?${params}`)
      .then(({ members }) => members)
      .catch(() => {
        memberCache.delete(conversationId);
        return [];
      });
    memberCache.set(conversationId, request);
  }
  return memberCache.get(conversationId);
}

function fold(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

// As Signal's list: a name matches when one of its words starts with what
// was typed after the @.
function matchesMention(member, query) {
  if (!query) {
    return true;
  }
  const q = fold(query);
  const title = fold(member.author.title);
  return title.startsWith(q) || title.split(/\s+/).some(w => w.startsWith(q));
}

// The "@query" right before the caret, if the caret is in one.
function mentionTrigger() {
  if (document.activeElement !== composeBox()) {
    return null;
  }
  const at = selectionOffsets();
  if (!at || at.start !== at.end) {
    return null;
  }
  const before = readCompose()
    .slice(0, at.start)
    .map(c => c.ch)
    .join('');
  const match = /(^|\s)@([^\s@￼]{0,40})$/u.exec(before);
  if (!match) {
    return null;
  }
  const length = [...match[2]].length;
  return { start: at.start - length - 1, end: at.start, query: match[2] };
}

async function updateMentionPicker() {
  const c = conversations.get(selectedId);
  const trigger = c?.type === 'group' ? mentionTrigger() : null;
  if (!trigger) {
    closeMentionPicker();
    return;
  }
  const conversationId = selectedId;
  const members = await loadMembers(conversationId);
  const now = mentionTrigger();
  if (selectedId !== conversationId || !now || now.query !== trigger.query) {
    return;
  }
  mentionQuery = now;
  // Everyone who matches, as Signal lists them; the list scrolls.
  mentionChoices = members.filter(m => matchesMention(m, now.query));
  mentionIndex = 0;
  renderMentionPicker();
}

function renderMentionPicker() {
  const picker = $('mention-picker');
  if (mentionChoices.length === 0) {
    closeMentionPicker();
    return;
  }
  picker.replaceChildren(
    ...mentionChoices.map((member, i) => {
      const row = el(
        'div',
        `mention-row${i === mentionIndex ? ' active' : ''}`
      );
      row.setAttribute('role', 'option');
      row.append(
        avatar(member.conversationId, member.author, 28),
        el('span', 'mention-name', member.author.title)
      );
      row.addEventListener('mousedown', e => {
        // Keep the focus in the message box.
        e.preventDefault();
        pickMention(member);
      });
      return row;
    })
  );
  picker.hidden = false;
  const box = composeBox().getBoundingClientRect();
  picker.style.left = `${box.left}px`;
  picker.style.width = `${Math.min(box.width, 360)}px`;
  picker.style.top = `${Math.max(8, box.top - picker.offsetHeight - 6)}px`;
  picker.children[mentionIndex]?.scrollIntoView({ block: 'nearest' });
}

function closeMentionPicker() {
  mentionQuery = null;
  mentionChoices = [];
  $('mention-picker').hidden = true;
}

function pickMention(member) {
  const trigger = mentionQuery ?? mentionTrigger();
  if (!trigger) {
    return;
  }
  closeMentionPicker();
  spliceCompose(trigger.start, trigger.end, [
    {
      ch: MENTION_PLACEHOLDER,
      styles: new Set(),
      mention: {
        conversationId: member.conversationId,
        title: member.author.title,
      },
    },
    { ch: ' ', styles: new Set() },
  ]);
}

// --- message box events ----------------------------------------------------------

{
  const box = composeBox();
  // Plain-text editing keeps the browser from adding its own markup; the
  // styles here come only from this code.
  box.contentEditable = 'plaintext-only';
  if (box.contentEditable !== 'plaintext-only') {
    box.contentEditable = 'true';
  }
}
composeBox().addEventListener('input', onComposeInput);
composeBox().addEventListener('blur', () => {
  closeMentionPicker();
  $('format-bar').hidden = true;
});
composeBox().addEventListener('beforeinput', e => {
  // The browser's own bold and the like would bypass Signal's styles.
  if (e.inputType.startsWith('format')) {
    e.preventDefault();
  }
});
document.addEventListener('selectionchange', () => {
  const at = selectionOffsets();
  if (at) {
    composeSelection = at;
  }
  if (document.activeElement === composeBox()) {
    updateFormatBar();
    if (mentionQuery || !$('mention-picker').hidden) {
      updateMentionPicker();
    }
  }
});
composeBox().addEventListener('contextmenu', e => {
  const at = selectionOffsets();
  if (e.shiftKey || !at || at.start === at.end) {
    return;
  }
  e.preventDefault();
  openFormatMenu(e.clientX, e.clientY);
});
composeBox().addEventListener('drop', e => {
  if (e.dataTransfer?.files.length) {
    return;
  }
  // Dropped text comes in plain, where it was dropped.
  e.preventDefault();
  const text = e.dataTransfer?.getData('text/plain') ?? '';
  const point = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (point && composeBox().contains(point.startContainer)) {
    const at = offsetAt(point.startContainer, point.startOffset);
    composeSelection = { start: at, end: at };
    window.getSelection().removeAllRanges();
  }
  insertPlain(text);
});
composeBox().addEventListener(
  'keydown',
  e => {
    if (!$('mention-picker').hidden && mentionChoices.length > 0) {
      const move = { ArrowDown: 1, ArrowUp: -1 }[e.key];
      if (move) {
        mentionIndex =
          (mentionIndex + move + mentionChoices.length) % mentionChoices.length;
        renderMentionPicker();
      } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        pickMention(mentionChoices[mentionIndex]);
      } else if (e.key === 'Escape') {
        closeMentionPicker();
      } else {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      insertPlain('\n');
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.altKey) {
      return;
    }
    const key = e.key.toLowerCase();
    const style = e.shiftKey
      ? { x: 'strikethrough', b: 'spoiler' }[key]
      : { b: 'bold', i: 'italic', e: 'monospace' }[key];
    if (style) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toggleStyle(style);
    } else if (key === 'u' && !e.shiftKey) {
      // Signal has no underline.
      e.preventDefault();
    }
  },
  { capture: true }
);
document.addEventListener('mousedown', e => {
  if (!e.target.closest?.('#format-menu')) {
    closeFormatMenu();
  }
});

// --- attachments to send ------------------------------------------------------

// conversationId -> [{ file, url }], kept per chat as Signal does.
const drafts = new Map();
const MAX_DRAFTS = 32;

function draftsFor(conversationId) {
  return drafts.get(conversationId) ?? [];
}

function addDrafts(fileList) {
  if (!selectedId) {
    return;
  }
  const list = [...draftsFor(selectedId)];
  for (const file of fileList) {
    if (list.length >= MAX_DRAFTS) {
      toast(`Up to ${MAX_DRAFTS} attachments at a time.`);
      break;
    }
    const url = file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : null;
    list.push({ file, url });
  }
  drafts.set(selectedId, list);
  renderDrafts();
  focusCompose();
}

function removeDraft(conversationId, draft) {
  if (draft.url) {
    URL.revokeObjectURL(draft.url);
  }
  drafts.set(
    conversationId,
    draftsFor(conversationId).filter(d => d !== draft)
  );
  renderDrafts();
}

function clearDrafts(conversationId) {
  for (const draft of draftsFor(conversationId)) {
    if (draft.url) {
      URL.revokeObjectURL(draft.url);
    }
  }
  drafts.delete(conversationId);
  renderDrafts();
}

function renderDrafts() {
  const tray = $('draft-tray');
  const list = selectedId ? draftsFor(selectedId) : [];
  tray.hidden = list.length === 0;
  const conversationId = selectedId;
  tray.replaceChildren(
    ...list.map(draft => {
      const tile = el('span', 'draft');
      if (draft.url) {
        const img = el('img', 'draft-image');
        img.alt = '';
        img.src = draft.url;
        tile.append(img);
      } else {
        tile.classList.add('draft-file');
        tile.append(
          icon('file'),
          el('span', 'draft-name', draft.file.name || 'File'),
          el('span', 'draft-size', formatSize(draft.file.size))
        );
      }
      const remove = el('button', 'draft-remove');
      remove.type = 'button';
      remove.title = 'Remove attachment';
      remove.setAttribute('aria-label', 'Remove attachment');
      remove.append(icon('close'));
      remove.addEventListener('click', () =>
        removeDraft(conversationId, draft)
      );
      tile.append(remove);
      return tile;
    })
  );
}

async function uploadFile(file) {
  const params = new URLSearchParams({
    contentType: file.type || 'application/octet-stream',
    ...(file.name ? { name: file.name } : {}),
  });
  const res = await fetch(`api/upload?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 413) {
    // From a reverse proxy in front of the helper, not from Signal.
    const error = new Error('HTTP 413');
    error.reason = 'proxyTooLarge';
    throw error;
  }
  if (!res.ok) {
    const error = new Error(data.error?.message ?? `HTTP ${res.status}`);
    error.code = data.error?.code;
    error.reason = data.error?.reason;
    throw error;
  }
  return data.uploadId;
}

// Files from the clipboard: screenshots, copied images, copied files.
// Text comes in plain; styles are set here, as in Signal.
$('compose').addEventListener('paste', e => {
  const files = [...(e.clipboardData?.files ?? [])];
  e.preventDefault();
  if (files.length > 0) {
    if (!editing) {
      addDrafts(files);
    }
    return;
  }
  insertPlain(e.clipboardData?.getData('text/plain') ?? '');
});
$('settings-open').append(icon('settings'));
$('settings-open').addEventListener('click', openSettings);
$('chat-menu-open').append(icon('more'));
$('chat-menu-open').addEventListener('click', ev => {
  ev.stopPropagation();
  if (selectedId) {
    openChatMenu(selectedId, $('chat-menu-open'));
  }
});
$('settings-close').append(icon('close'));
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', e => {
  if (e.target === $('settings')) {
    closeSettings();
  }
});
applyTheme(pageTheme());
$('sticker-open').append(icon('sticker'));
$('sticker-open').addEventListener('click', ev => {
  ev.stopPropagation();
  if (!$('sticker-picker').hidden) {
    closePopovers();
    return;
  }
  openStickerPicker($('sticker-open'));
});
$('emoji-open').append(icon('react'));
$('emoji-open').addEventListener('click', ev => {
  ev.stopPropagation();
  if (!$('emoji-picker').hidden) {
    closePopovers();
    return;
  }
  openEmojiPicker($('emoji-open'), insertEmoji);
});
$('attach').append(icon('attach'));
$('attach').addEventListener('click', () => $('attach-input').click());
$('attach-input').addEventListener('change', () => {
  addDrafts([...$('attach-input').files]);
  $('attach-input').value = '';
});
$('chat').addEventListener('dragover', e => {
  if (selectedId && e.dataTransfer?.types.includes('Files')) {
    e.preventDefault();
    $('chat').classList.add('dropping');
  }
});
$('chat').addEventListener('dragleave', e => {
  if (e.target === $('chat') || !$('chat').contains(e.relatedTarget)) {
    $('chat').classList.remove('dropping');
  }
});
$('chat').addEventListener('drop', e => {
  $('chat').classList.remove('dropping');
  if (selectedId && e.dataTransfer?.files.length) {
    e.preventDefault();
    addDrafts([...e.dataTransfer.files]);
  }
});

// --- forward -----------------------------------------------------------------

// Unlike Signal: any number of chats, and every chat, most recent first.
let forwarding = null;
const forwardSelected = new Set();

function canForward(m) {
  return (
    (m.kind === 'text' || m.kind === 'sticker') &&
    (Boolean(m.body) || m.attachments.length > 0 || Boolean(m.sticker))
  );
}

function forwardCandidates() {
  const query = $('forward-search').value.trim().toLowerCase();
  return [...conversations.values()]
    .filter(c => !c.blocked)
    .filter(
      c =>
        !query ||
        displayTitle(c).toLowerCase().includes(query) ||
        c.title.toLowerCase().includes(query)
    )
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

function renderForwardList() {
  $('forward-list').replaceChildren(
    ...forwardCandidates().map(c => {
      const li = el('li');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = forwardSelected.has(c.id);
      li.append(
        box,
        conversationAvatar(c, 36),
        el('span', 'title', displayTitle(c))
      );
      li.classList.toggle('checked', box.checked);
      li.addEventListener('click', e => {
        if (e.target !== box) {
          box.checked = !box.checked;
        }
        if (box.checked) {
          forwardSelected.add(c.id);
        } else {
          forwardSelected.delete(c.id);
        }
        li.classList.toggle('checked', box.checked);
        renderForwardCount();
      });
      return li;
    })
  );
  renderForwardCount();
}

function renderForwardCount() {
  const n = forwardSelected.size;
  $('forward-count').textContent =
    n === 0 ? 'Pick chats' : `${n} chat${n === 1 ? '' : 's'} selected`;
  $('forward-send').disabled = n === 0;
  const verb = forwarding?.kind === 'poll' ? 'Send' : 'Forward';
  $('forward-send').textContent = n > 1 ? `${verb} to ${n} chats` : verb;
}

function openForward(m) {
  forwarding = { kind: 'message', message: m };
  showForward([]);
}

// Signal can't forward a poll; this sends a new poll with the same question
// and options to each chat instead.
function openPollForward(poll, preselected) {
  forwarding = { kind: 'poll', poll };
  showForward(preselected);
}

function showForward(preselected) {
  const poll = forwarding.kind === 'poll';
  $('forward-title').textContent = poll ? 'Send poll' : 'Forward message';
  $('forward-note').hidden = !poll;
  $('forward-note').textContent = poll
    ? 'Each chat gets its own copy of this poll, with its own votes.'
    : '';
  forwardSelected.clear();
  for (const id of preselected) {
    forwardSelected.add(id);
  }
  $('forward-search').value = '';
  renderForwardList();
  $('forward').hidden = false;
  $('forward-search').focus();
}

function closeForward() {
  forwarding = null;
  $('forward').hidden = true;
}

async function sendForward() {
  if (!forwarding || forwardSelected.size === 0) {
    return;
  }
  const conversationIds = [...forwardSelected];
  const poll = forwarding.kind === 'poll';
  const done = poll ? 'Sent' : 'Forwarded';
  $('forward-send').disabled = true;
  try {
    const { results } = poll
      ? await api('api/pollSend', { conversationIds, ...forwarding.poll })
      : await api('api/forward', {
          messageId: forwarding.message.id,
          conversationIds,
        });
    const failed = results.filter(r => !r.ok);
    closeForward();
    if (poll && failed.length < results.length) {
      closePollCompose();
    }
    if (failed.length === 0) {
      toast(
        `${done} to ${results.length} chat${results.length === 1 ? '' : 's'}.`
      );
    } else {
      const names = failed
        .map(r => {
          const c = conversations.get(r.conversationId);
          const why = SEND_ERRORS[r.reason] ?? r.reason ?? 'refused';
          return `${c ? displayTitle(c) : 'A chat'}: ${why}`;
        })
        .join('\n');
      window.alert(
        `${done} to ${results.length - failed.length} of ${results.length} chats. Not sent:\n${names}`
      );
    }
  } catch (error) {
    $('forward-send').disabled = false;
    toast(
      SEND_ERRORS[error.reason] ??
        `Not ${poll ? 'sent' : 'forwarded'} (${error.code ?? error.message}).`
    );
  }
}

$('forward-close').append(icon('close'));
$('forward-close').addEventListener('click', closeForward);
$('forward').addEventListener('click', e => {
  if (e.target === $('forward')) {
    closeForward();
  }
});
$('forward-search').addEventListener('input', renderForwardList);
$('forward-send').addEventListener('click', sendForward);

// --- polls ---------------------------------------------------------------------

const POLL_MAX_OPTIONS = 10;
const POLL_MAX_LENGTH = 100;

function canSend() {
  return capabilities.includes('messages.send');
}

// As Signal's poll bubble: question, how to vote, then each option with its
// count and a bar against the number of people who voted.
function renderPoll(m) {
  const { poll } = m;
  const box = el('div', `poll${poll.pending ? ' pending' : ''}`);
  box.append(el('div', 'poll-question', poll.question));
  box.append(
    el(
      'div',
      'poll-status',
      poll.ended
        ? 'Final results'
        : poll.allowMultiple
          ? 'Select multiple'
          : 'Select one'
    )
  );
  const voting = !poll.ended && canSend();
  const voted = poll.uniqueVoters > 0;
  poll.options.forEach((option, index) => {
    const row = el(voting ? 'label' : 'div', 'poll-option');
    if (voting) {
      const check = el('input');
      check.type = 'checkbox';
      check.checked = option.mine;
      check.addEventListener('change', () => votePoll(m, index, check.checked));
      row.append(check);
    }
    const main = el('span', 'poll-main');
    const top = el('span', 'poll-top');
    top.append(el('span', 'poll-text', option.text));
    if (voted) {
      const count = el('span', 'poll-count', String(option.voters.length));
      if (poll.ended && option.mine) {
        count.prepend(el('span', 'poll-mine', '✓ '));
      }
      top.append(count);
    }
    const bar = el('span', 'poll-bar');
    const fill = el('span', 'poll-fill');
    fill.style.width = `${voted ? (option.voters.length / poll.uniqueVoters) * 100 : 0}%`;
    bar.append(fill);
    main.append(top, bar);
    row.append(main);
    box.append(row);
  });
  if (voted) {
    const view = el('button', 'poll-view', 'View votes');
    view.type = 'button';
    view.addEventListener('click', () => openPollVotes(m));
    box.append(view);
  } else {
    box.append(el('div', 'poll-none', 'No votes'));
  }
  return box;
}

async function votePoll(m, index, checked) {
  const picked = new Set(
    m.poll.options.flatMap((option, i) => (option.mine ? [i] : []))
  );
  if (checked) {
    if (!m.poll.allowMultiple) {
      picked.clear();
    }
    picked.add(index);
  } else {
    picked.delete(index);
  }
  const optionIndexes = [...picked].sort((a, b) => a - b);
  // Show the vote at once; Signal's update replaces this.
  putMessage({
    ...m,
    poll: {
      ...m.poll,
      pending: true,
      options: m.poll.options.map((option, i) => ({
        ...option,
        mine: picked.has(i),
      })),
    },
  });
  renderMessages();
  try {
    await api('api/pollVote', { messageId: m.id, optionIndexes });
  } catch (error) {
    if (messages.has(m.id)) {
      putMessage(m);
      renderMessages();
    }
    toast(
      SEND_ERRORS[error.reason] ??
        `Vote not sent (${error.code ?? error.message}).`
    );
  }
}

async function endPoll(m) {
  if (!window.confirm('End this poll? No one will be able to vote.')) {
    return;
  }
  try {
    await api('api/pollEnd', { messageId: m.id });
    closePollVotes();
  } catch (error) {
    toast(
      SEND_ERRORS[error.reason] ??
        `Poll not ended (${error.code ?? error.message}).`
    );
  }
}

function voterName(conversationId) {
  return conversations.get(conversationId)?.noteToSelf
    ? 'You'
    : nameOf(conversationId);
}

let pollVotesFor = null;

function openPollVotes(m) {
  pollVotesFor = m.id;
  const { poll } = m;
  const body = $('poll-votes-body');
  body.replaceChildren(el('div', 'poll-votes-question', poll.question));
  poll.options.forEach(option => {
    if (option.voters.length === 0) {
      return;
    }
    const section = el('section', 'poll-votes-option');
    const head = el('div', 'poll-votes-head');
    head.append(
      el('span', '', option.text),
      el(
        'span',
        'sub',
        `${option.voters.length} vote${option.voters.length === 1 ? '' : 's'}`
      )
    );
    section.append(head);
    for (const id of option.voters) {
      const row = el('div', 'poll-voter');
      const who = authorOf(id) ?? { title: voterName(id) };
      row.append(avatar(id, who, 28), el('span', '', voterName(id)));
      section.append(row);
    }
    body.append(section);
  });
  $('poll-votes-foot').hidden = !(poll.canEnd && canSend());
  $('poll-votes').hidden = false;
}

function closePollVotes() {
  pollVotesFor = null;
  $('poll-votes').hidden = true;
}

function pollOptionInput(value = '') {
  const input = el('input');
  input.autocomplete = 'off';
  input.placeholder = 'Option';
  input.value = value;
  input.addEventListener('input', syncPollOptions);
  return input;
}

// Like Signal's dialog: there is always one empty option to type into, up to
// ten; emptied options in the middle go away.
function syncPollOptions() {
  const box = $('poll-option-inputs');
  const inputs = [...box.children];
  inputs.forEach((input, i) => {
    if (
      input.value === '' &&
      i < inputs.length - 1 &&
      inputs.length > 2 &&
      document.activeElement !== input
    ) {
      input.remove();
    }
  });
  const left = [...box.children];
  const last = left[left.length - 1];
  if (last.value !== '' && left.length < POLL_MAX_OPTIONS) {
    box.append(pollOptionInput());
  }
  while (box.children.length < 2) {
    box.append(pollOptionInput());
  }
  $('poll-send').disabled = !readPollForm();
}

function graphemes(text) {
  return [...segmenter.segment(text)].length;
}

// The poll as typed, or null if Signal would not send it yet.
function readPollForm() {
  const question = $('poll-question').value.trim();
  const options = [...$('poll-option-inputs').children]
    .map(input => input.value.trim())
    .filter(Boolean);
  if (
    !question ||
    graphemes(question) > POLL_MAX_LENGTH ||
    options.length < 2 ||
    options.some(option => graphemes(option) > POLL_MAX_LENGTH)
  ) {
    return null;
  }
  return { question, options, allowMultiple: $('poll-multiple').checked };
}

function openPollCompose() {
  $('poll-question').value = '';
  $('poll-multiple').checked = false;
  $('poll-option-inputs').replaceChildren(pollOptionInput(), pollOptionInput());
  $('poll-send').disabled = true;
  $('poll-compose').hidden = false;
  $('poll-question').focus();
}

function closePollCompose() {
  $('poll-compose').hidden = true;
}

async function sendPollHere() {
  const poll = readPollForm();
  if (!poll || !selectedId) {
    return;
  }
  $('poll-send').disabled = true;
  try {
    const { results } = await api('api/pollSend', {
      conversationIds: [selectedId],
      ...poll,
    });
    const [result] = results;
    if (result?.ok) {
      closePollCompose();
    } else {
      $('poll-send').disabled = false;
      toast(SEND_ERRORS[result?.reason] ?? 'Poll not sent.');
    }
  } catch (error) {
    $('poll-send').disabled = false;
    toast(
      SEND_ERRORS[error.reason] ??
        `Poll not sent (${error.code ?? error.message}).`
    );
  }
}

$('poll-open').append(icon('poll'));
$('poll-open').addEventListener('click', openPollCompose);
$('poll-compose-close').append(icon('close'));
$('poll-compose-close').addEventListener('click', () => closePollCompose());
$('poll-question').addEventListener('input', syncPollOptions);
$('poll-multiple').addEventListener('change', syncPollOptions);
$('poll-option-inputs').addEventListener('focusout', () =>
  setTimeout(syncPollOptions)
);
$('poll-compose').addEventListener('submit', e => {
  e.preventDefault();
  sendPollHere();
});
$('poll-choose').addEventListener('click', () => {
  const poll = readPollForm();
  if (!poll) {
    toast('Add a question and at least two options.');
    return;
  }
  openPollForward(poll, selectedId ? [selectedId] : []);
});
$('poll-votes-close').append(icon('close'));
$('poll-votes-close').addEventListener('click', closePollVotes);
$('poll-end').addEventListener('click', () => {
  const m = messages.get(pollVotesFor);
  if (m) {
    endPoll(m);
  }
});
for (const id of ['poll-compose', 'poll-votes']) {
  $(id).addEventListener('click', e => {
    if (e.target === $(id)) {
      $(id).hidden = true;
    }
  });
}

// --- narrow windows ------------------------------------------------------------

// Below the breakpoint the chat list shows photos only, as Signal's does;
// search opens it full width over the chat.
function collapseSidebar() {
  document.querySelector('.sidebar').classList.remove('expanded');
}

$('chat').addEventListener('pointerdown', collapseSidebar);
$('search-open').append(icon('search'));
$('search-open').addEventListener('click', () => {
  document.querySelector('.sidebar').classList.add('expanded');
  $('search').focus();
});

$('composer').addEventListener('submit', e => {
  e.preventDefault();
  sendCurrent();
});
$('compose').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendCurrent();
  } else if (e.key === 'Escape' && (replyTo || editing)) {
    cancelReply();
  }
});
$('older').addEventListener('click', () => loadMessages({ older: true }));
$('search').addEventListener('input', renderConversations);
$('filter-unread').append(icon('filter'));
$('filter-unread').addEventListener('click', () =>
  setListFilter(listFilter, !unreadOnly)
);
$('banner-action').addEventListener('click', () =>
  api('api/retry', {}).catch(() => {})
);
$('reply-cancel').append(icon('close'));
$('lightbox-close').append(icon('close'));
$('lightbox-save').append(icon('download'));
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox').addEventListener('click', e => {
  if (e.target === $('lightbox') || e.target === $('lightbox-stage')) {
    closeLightbox();
  }
});
$('reply-cancel').addEventListener('click', cancelReply);
document.addEventListener('click', e => {
  if (!e.target.closest?.('.popover')) {
    closePopovers();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closePopovers();
    closeLightbox();
    if (!$('forward').hidden) {
      closeForward();
    } else {
      closePollCompose();
      closePollVotes();
      closeSettings();
    }
    collapseSidebar();
  }
});
$('messages').addEventListener('scroll', closePopovers, { passive: true });
// As Signal: reaching the newest message marks the chat read.
$('messages').addEventListener(
  'scroll',
  () => {
    const box = $('messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) {
      maybeMarkRead();
    }
  },
  { passive: true }
);
// Rambox may not move window focus on a click into the page.
document.addEventListener('pointerdown', () => setTimeout(maybeMarkRead, 0));
window.addEventListener('focus', maybeMarkRead);
document.addEventListener('visibilitychange', maybeMarkRead);
// Relative times in the list ("5m") move on.
setInterval(() => {
  if (conversations.size > 0) {
    renderConversations();
  }
}, 60_000);

renderBanner();
connectEvents();

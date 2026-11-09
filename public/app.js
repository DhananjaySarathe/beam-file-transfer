/*
 * Beam page script.
 *
 * The page keeps an event stream open to the server. Sending is an offer the
 * other device accepts; the receiving browser then downloads each file as a
 * normal download while this page (the sender) uploads it on request.
 *
 * Names, file names and text come from other devices, so everything is put on
 * the page as text nodes, never as HTML.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// ── Small helpers ─────────────────────────────────────────────────────────

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child != null && child !== false));
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function icon(name, extraClass = '') {
  const svg = svgEl('svg', { class: `icon ${extraClass}`.trim(), 'aria-hidden': 'true' });
  svg.append(svgEl('use', { href: `#i-${name}` }));
  return svg;
}

function formatBytes(bytes) {
  if (bytes < 1000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 999.5 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * A file name that truncates in the middle of a narrow space: the stem gets the
 * ellipsis and the extension always stays visible, so the receiver can see
 * what kind of file they are being offered.
 */
function fileNameNode(name, tag = 'span') {
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && name.length - dot <= 12;
  return el(
    tag,
    { class: 'file-name', title: name },
    el('span', { class: 'file-stem' }, hasExt ? name.slice(0, dot) : name),
    hasExt && el('span', { class: 'file-ext' }, name.slice(dot)),
  );
}

function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Storage can be unavailable (private windows, blocked site data); the page
// still works, it just forgets its name.
const store = {
  get(area, key) {
    try {
      return window[area].getItem(key);
    } catch {
      return null;
    }
  },
  set(area, key, value) {
    try {
      window[area].setItem(key, value);
    } catch {
      // ignore
    }
  },
};

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection-based copy
  }
  // Pages served over plain http on a local network have no clipboard API.
  const host = document.querySelector('dialog[open]') || document.body;
  const area = el('textarea', { class: 'offscreen', readonly: true, 'aria-hidden': 'true' });
  area.value = text;
  host.append(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function toast(message) {
  const box = $('toasts');
  const note = el('div', { class: 'toast' }, message);
  box.append(note);
  // Open dialogs sit in the browser's top layer; re-showing the toast box as a
  // popover puts it above them.
  if (box.showPopover) {
    try {
      box.popover = 'manual';
      if (box.matches(':popover-open')) box.hidePopover();
      box.showPopover();
    } catch {
      // plain fixed positioning still works
    }
  }
  setTimeout(() => note.classList.add('out'), 3200);
  setTimeout(() => {
    note.remove();
    if (!box.children.length && box.hidePopover) {
      try {
        box.hidePopover();
      } catch {
        // already hidden
      }
    }
  }, 3600);
}

// ── Identity ──────────────────────────────────────────────────────────────

const ADJECTIVES = ['Amber', 'Brisk', 'Calm', 'Coral', 'Dusty', 'Eager', 'Gentle', 'Hazel', 'Indigo', 'Jolly', 'Lucky', 'Mellow', 'Nimble', 'Olive', 'Plucky', 'Quiet', 'Rusty', 'Sunny', 'Tidy', 'Velvet', 'Witty', 'Zesty'];
const ANIMALS = ['Otter', 'Falcon', 'Koala', 'Lynx', 'Heron', 'Badger', 'Panda', 'Finch', 'Gecko', 'Moose', 'Wren', 'Tapir', 'Bison', 'Puffin', 'Marten', 'Ibis', 'Quokka', 'Robin', 'Stoat', 'Tern', 'Yak', 'Egret'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function detectDevice() {
  const ua = navigator.userAgent;
  const iPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  let system = 'Device';
  let kind = 'desktop';
  if (/iPhone|iPod/.test(ua)) [system, kind] = ['iPhone', 'phone'];
  else if (iPad) [system, kind] = ['iPad', 'tablet'];
  else if (/Android/.test(ua)) [system, kind] = ['Android', /Mobile/.test(ua) ? 'phone' : 'tablet'];
  else if (/Macintosh|Mac OS X/.test(ua)) [system, kind] = ['Mac', 'laptop'];
  else if (/Windows/.test(ua)) [system, kind] = ['Windows', 'desktop'];
  else if (/CrOS/.test(ua)) [system, kind] = ['Chromebook', 'laptop'];
  else if (/Linux/.test(ua)) [system, kind] = ['Linux', 'desktop'];

  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  return { kind, label: `${system} · ${browser}` };
}

// The key is this tab's secret; the server shows other devices only an id
// derived from it. It lives in sessionStorage so a reload keeps the identity
// while a second tab gets its own.
function freshKey() {
  const value = randomHex(16);
  store.set('sessionStorage', 'beam.key', value);
  return value;
}

let key = store.get('sessionStorage', 'beam.key');
if (!/^[0-9a-f]{32}$/.test(key || '')) key = freshKey();

const inst = randomHex(8); // one per page load
const device = detectDevice();
let myName = store.get('localStorage', 'beam.name');
if (!myName) {
  myName = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  store.set('localStorage', 'beam.name', myName);
}

// ── State ─────────────────────────────────────────────────────────────────

let me = null;
let joinUrl = null;
let sendTarget = null;
const peers = new Map(); // id -> { id, name, kind, label }
const names = new Map(); // id -> last known name, kept after a device leaves
const transfers = new Map(); // id -> transfer shown in the activity list
const offers = []; // incoming offers waiting for an answer; the first is on screen

const nameOf = (id) => names.get(id) || 'Unknown device';

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'X-Key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

// ── Connection ────────────────────────────────────────────────────────────

let stream = null;
let retryTimer = 0;

function setStatus(status) {
  $('status-dot').dataset.status = status;
  $('status-text').textContent = { online: 'This device', connecting: 'Connecting', offline: 'Disconnected' }[status];
}

function connect() {
  clearTimeout(retryTimer);
  if (stream) stream.close();
  setStatus('connecting');
  const query = new URLSearchParams({ key, inst, name: myName, kind: device.kind, label: device.label });
  stream = new EventSource(`/api/events?${query}`);
  stream.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  };
  stream.onerror = () => {
    setStatus('connecting');
    // The browser retries a dropped stream by itself. It gives up only when
    // the server refuses the request, so retry that case by hand.
    if (stream.readyState === EventSource.CLOSED) retryTimer = setTimeout(connect, 3000);
  };
}

// Events about a transfer can arrive before the request that created it has
// returned its id; they are held here and replayed once it is known.
let creating = 0;
const early = [];

function handle(msg) {
  const handler = handlers[msg.type];
  if (handler) handler(msg);
}

function knownTransfer(msg) {
  const t = transfers.get(msg.id);
  if (!t && creating > 0) early.push(msg);
  return t && !t.final ? t : null;
}

const handlers = {
  hello(msg) {
    me = msg.you;
    setStatus('online');
    peers.clear();
    for (const peer of msg.peers) rememberPeer(peer);
    renderPeers();
    if (me.name !== myName) api('POST', '/api/me', { name: myName }).catch(() => {});

    // Events sent while this page was offline are lost, so every transfer is
    // brought back in line with the server's picture of it.
    const live = new Map(msg.transfers.map((snap) => [snap.id, snap]));
    const endedById = new Map(msg.ended.map((end) => [end.id, end]));
    for (const t of transfers.values()) {
      if (t.final) continue;
      const snap = live.get(t.id);
      const end = endedById.get(t.id);
      if (snap) resync(t, snap);
      else finalize(t, end ? end.state : 'failed', end || {});
    }
    for (const offer of [...offers]) if (!live.has(offer.id)) removeOffer(offer.id);
    for (const snap of msg.transfers) {
      const missedOffer = snap.state === 'offered' && snap.to === me.id && !offers.some((offer) => offer.id === snap.id);
      if (missedOffer) offers.push(snap);
    }
    showOffer();
  },

  'peer-joined'(msg) {
    rememberPeer(msg.peer);
    renderPeers();
    // A device that dropped off mid-transfer is back: carry on where it stopped.
    for (const t of transfers.values()) {
      if (t.final || t.peerId !== msg.peer.id) continue;
      t.peerAway = false;
      if (t.dir === 'in' && t.activeIdx === -1) resumeDownloads(t);
      updateTransfer(t);
    }
  },

  'peer-updated'(msg) {
    rememberPeer(msg.peer);
    renderPeers();
    if (sendTarget === msg.peer.id) $('send-peer').textContent = msg.peer.name;
    for (const t of transfers.values()) if (t.peerId === msg.peer.id) updateTransfer(t);
  },

  'peer-left'(msg) {
    peers.delete(msg.id);
    renderPeers();
    for (const t of transfers.values()) {
      if (t.final || t.peerId !== msg.id) continue;
      t.peerAway = true;
      updateTransfer(t);
    }
    if (sendTarget === msg.id && $('send-dialog').open) {
      $('send-dialog').close();
      toast(`${nameOf(msg.id)} disconnected`);
    }
  },

  offer(msg) {
    offers.push(msg.transfer);
    showOffer();
    buzz(120);
  },

  transfer(msg) {
    const withdrawn = removeOffer(msg.id);
    if (withdrawn) {
      if (msg.state === 'cancelled') toast(`${nameOf(withdrawn.from)} cancelled the transfer`);
      if (msg.state === 'expired') toast(`The offer from ${nameOf(withdrawn.from)} timed out`);
      return;
    }
    const t = knownTransfer(msg);
    if (!t) return;
    if (msg.state === 'accepted') {
      t.state = 'accepted';
      updateTransfer(t);
    } else {
      finalize(t, msg.state, msg);
    }
  },

  'send-file'(msg) {
    const t = knownTransfer(msg);
    if (t && t.dir === 'out') uploadFile(t, msg.idx, msg.attempt);
  },

  file(msg) {
    const t = knownTransfer(msg);
    if (!t) return;
    if (msg.state === 'active') {
      clearTimeout(t.stuckTimer);
      t.fileStates[msg.idx] = 'active';
      t.activeIdx = msg.idx;
      t.activeSent = 0;
      t.needsTap = -1;
      t.interrupted = false;
    } else if (msg.state === 'done') {
      setFileSize(t, msg.idx, msg.size);
      t.fileStates[msg.idx] = 'done';
      t.activeIdx = -1;
      t.activeSent = 0;
      const next = t.fileStates.indexOf('pending');
      if (t.dir === 'in' && next !== -1) startDownload(t, next);
    } else if (msg.state === 'interrupted') {
      t.fileStates[msg.idx] = 'pending';
      t.activeIdx = -1;
      t.activeSent = 0;
      t.interrupted = true;
      t.interruptReason = msg.reason;
      if (t.dir === 'in') {
        t.needsTap = msg.idx;
        t.tapLabel = 'Retry';
      }
    }
    updateTransfer(t);
  },

  progress(msg) {
    const t = knownTransfer(msg);
    if (!t) return;
    setFileSize(t, msg.idx, msg.size);
    t.activeIdx = msg.idx;
    t.activeSent = msg.sent;
    updateTransfer(t);
  },

  text(msg) {
    addTextItem(msg.from, msg.text);
    buzz(60);
  },

  replaced(msg) {
    if (msg.inst === inst) return; // our own reconnect replacing a stale stream
    stream.close();
    setStatus('offline');
    for (const t of transfers.values()) if (!t.final) finalize(t, 'failed');
    for (const offer of [...offers]) removeOffer(offer.id);
    peers.clear();
    renderPeers();
    showBanner('This device is now connected from another tab.', 'Use this tab instead', () => {
      key = freshKey();
      hideBanner();
      connect();
    });
  },
};

/** A short vibration on phones. Browsers only allow it once the page has been touched. */
function buzz(ms) {
  if (navigator.vibrate && navigator.userActivation && navigator.userActivation.hasBeenActive) navigator.vibrate(ms);
}

/**
 * The size in an offer is what the sender's browser reported; the number of
 * bytes it actually sends can differ (phones re-encode photos). Once the real
 * size is known, use it so the totals and the progress bar are right.
 */
function setFileSize(t, idx, size) {
  if (typeof size !== 'number' || t.files[idx].size === size) return;
  t.files = t.files.map((file, i) => (i === idx ? { ...file, size } : file));
  t.totalSize = t.files.reduce((sum, file) => sum + file.size, 0);
}

function rememberPeer(peer) {
  peers.set(peer.id, peer);
  names.set(peer.id, peer.name);
}

function showBanner(text, actionLabel, onAction) {
  $('banner-text').textContent = text;
  $('banner-action').textContent = actionLabel;
  $('banner-action').onclick = onAction;
  $('banner').hidden = false;
}

function hideBanner() {
  $('banner').hidden = true;
}

// ── Devices ───────────────────────────────────────────────────────────────

const hasFiles = (event) => Array.from((event.dataTransfer && event.dataTransfer.types) || []).includes('Files');

function filesFromDrop(dataTransfer) {
  const files = [];
  let skippedFolder = false;
  if (dataTransfer.items && dataTransfer.items.length) {
    for (const item of dataTransfer.items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) {
        skippedFolder = true;
        continue;
      }
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } else {
    files.push(...dataTransfer.files);
  }
  if (skippedFolder) toast('Folders can’t be sent as they are. Zip the folder first.');
  return files;
}

/** Highlight `node` while files are dragged over it and hand them to `onFiles` when dropped. */
function makeDropTarget(node, onFiles) {
  let depth = 0;
  const reset = () => {
    depth = 0;
    node.classList.remove('is-target');
  };
  node.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    node.classList.add('is-target');
  });
  node.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  node.addEventListener('dragleave', () => {
    if (--depth <= 0) reset();
  });
  node.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    reset();
    onFiles(filesFromDrop(event.dataTransfer));
  });
}

function peerCard(peer) {
  const card = el(
    'button',
    { class: 'peer', type: 'button', onclick: () => openSend(peer.id) },
    el('span', { class: 'peer-icon' }, icon(peer.kind)),
    el('span', { class: 'peer-name' }, peer.name),
    el('span', { class: 'peer-label' }, peer.label || 'Device'),
    el('span', { class: 'peer-drop' }, 'Drop to send'),
  );
  makeDropTarget(card, (files) => sendFiles(peer.id, files));
  return el('li', {}, card);
}

function addDeviceCard() {
  return el(
    'li',
    {},
    el(
      'button',
      { class: 'peer add', type: 'button', onclick: () => $('join-dialog').showModal() },
      el('span', { class: 'peer-icon' }, icon('plus')),
      el('span', { class: 'peer-name' }, 'Add a device'),
      el('span', { class: 'peer-label' }, 'Show the QR code'),
    ),
  );
}

function renderPeers() {
  const list = [...peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('peers').replaceChildren(...list.map(peerCard), addDeviceCard());
  $('peers').hidden = list.length === 0;
  $('empty').hidden = list.length > 0;
  $('lede').textContent = list.length
    ? 'Pick a device to send it files, text or a link.'
    : 'Nobody else is here yet. Open Beam on another device to get started.';
}

// ── Join panel ────────────────────────────────────────────────────────────

function drawQr(box, text) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const pad = 3;
  const size = count + pad * 2;
  let path = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + pad} ${row + pad}h1v1h-1z`;
    }
  }
  // Always black on white: scanners need that polarity even in dark mode.
  const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, 'shape-rendering': 'crispEdges' });
  svg.append(svgEl('rect', { width: size, height: size, fill: '#fff' }), svgEl('path', { d: path, fill: '#000' }));
  box.replaceChildren(svg);
}

function renderJoin() {
  for (const box of document.querySelectorAll('[data-join]')) {
    box.replaceChildren($('join-template').content.cloneNode(true));
    const qrBox = box.querySelector('[data-qr]');
    const urlRow = box.querySelector('.url-row');
    if (!joinUrl) {
      qrBox.hidden = true;
      urlRow.hidden = true;
      box.querySelector('[data-join-help]').textContent =
        'This computer isn’t on a network yet. Connect it to Wi-Fi, then reload this page to get an address other devices can open.';
      continue;
    }
    try {
      drawQr(qrBox, joinUrl);
    } catch {
      qrBox.hidden = true;
    }
    box.querySelector('[data-url]').textContent = joinUrl.replace(/^http:\/\//, '');
    const copy = box.querySelector('[data-copy]');
    copy.addEventListener('click', async () => {
      const ok = await copyText(joinUrl);
      copy.textContent = ok ? 'Copied' : 'Copy failed';
      setTimeout(() => (copy.textContent = 'Copy link'), 1600);
    });
  }
}

async function loadJoinUrl() {
  // When this page was opened as "localhost", that address is useless to
  // other devices; ask the server for the one on the local network.
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  joinUrl = local ? null : location.origin;
  if (local) {
    try {
      const info = await (await fetch('/api/info')).json();
      joinUrl = info.urls[0] || null;
    } catch {
      joinUrl = null;
    }
  }
  renderJoin();
}

// ── Sending ───────────────────────────────────────────────────────────────

function openSend(peerId) {
  sendTarget = peerId;
  $('send-peer').textContent = nameOf(peerId);
  $('send-text').value = '';
  $('send-text-btn').disabled = true;
  $('send-dialog').showModal();
}

async function sendFiles(peerId, files) {
  files = files.filter((file) => file instanceof File);
  if (!files.length) return;
  const meta = files.map((file) => ({ name: file.name, size: file.size, type: file.type }));
  creating++;
  try {
    const { id } = await api('POST', '/api/transfers', { to: peerId, files: meta });
    addTransfer({ id, dir: 'out', peerId, files: meta, blobs: files });
  } catch (err) {
    toast(err.message);
  } finally {
    creating--;
    early.splice(0).forEach(handle);
  }
}

function uploadFile(t, idx, attempt) {
  const blob = t.blobs && t.blobs[idx];
  if (!blob) return;
  const previous = t.uploads.get(idx);
  if (previous) previous.abort();
  // XMLHttpRequest streams a File from disk, so even very large files never
  // have to fit in memory.
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `/api/transfers/${t.id}/files/${idx}?attempt=${attempt}`);
  xhr.setRequestHeader('X-Key', key);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.onloadend = () => {
    if (t.uploads.get(idx) === xhr) t.uploads.delete(idx);
  };
  t.uploads.set(idx, xhr);
  xhr.send(blob);
}

// ── Receiving ─────────────────────────────────────────────────────────────

function showOffer() {
  document.title = offers.length ? `(${offers.length}) Beam` : 'Beam';
  const dialog = $('offer-dialog');
  const offer = offers[0];
  if (!offer) {
    if (dialog.open) dialog.close();
    return;
  }
  if (dialog.open && dialog.dataset.id === offer.id) return;

  const count = offer.files.length;
  dialog.dataset.id = offer.id;
  $('offer-title').textContent = `${nameOf(offer.from)} wants to send you ${count === 1 ? 'a file' : `${count} files`}`;
  $('offer-files').replaceChildren(
    ...offer.files.slice(0, 4).map((file) =>
      el('li', {}, fileNameNode(file.name), el('span', { class: 'file-size' }, formatBytes(file.size))),
    ),
  );
  const more = count > 4 ? `and ${count - 4} more · ` : '';
  $('offer-more').textContent = count > 1 ? `${more}${formatBytes(offer.totalSize)} in total` : '';
  $('offer-more').hidden = count === 1;
  setOfferBusy(false);
  if (!dialog.open) dialog.showModal();
}

function removeOffer(id) {
  const index = offers.findIndex((offer) => offer.id === id);
  if (index === -1) return null;
  const [offer] = offers.splice(index, 1);
  showOffer();
  return offer;
}

function setOfferBusy(busy) {
  $('offer-accept').disabled = busy;
  $('offer-decline').disabled = busy;
}

let answering = false;

async function answerOffer(accept) {
  const offer = offers[0];
  if (!offer || answering) return;
  answering = true;
  setOfferBusy(true);
  try {
    if (accept) {
      const { dlKey } = await api('POST', `/api/transfers/${offer.id}/accept`);
      // The sender may have cancelled while the request was on its way.
      if (offers.includes(offer)) {
        const t = addTransfer({ id: offer.id, dir: 'in', peerId: offer.from, files: offer.files });
        t.state = 'accepted';
        t.dlKey = dlKey;
        startDownload(t, 0);
        updateTransfer(t);
      }
    } else {
      await api('POST', `/api/transfers/${offer.id}/decline`);
    }
  } catch (err) {
    if (offers.includes(offer)) toast(err.message);
  }
  answering = false;
  removeOffer(offer.id);
}

const fileUrl = (t, idx) => `/api/transfers/${t.id}/files/${idx}?k=${t.dlKey}`;

/** Bring a transfer in line with the server's snapshot of it after a reconnect. */
function resync(t, snap) {
  t.peerAway = !peers.has(t.peerId);
  if (snap.state === 'accepted') t.state = 'accepted';
  t.fileStates = snap.done.map((done, i) => (done ? 'done' : i === snap.active ? 'active' : 'pending'));
  t.activeIdx = snap.active;
  t.activeSent = snap.sent;
  if (snap.active >= 0) {
    clearTimeout(t.stuckTimer);
    t.needsTap = -1;
    t.interrupted = false;
  }
  if (t.dir === 'out') {
    // The request to start uploading may have been one of the missed events.
    if (snap.active >= 0 && !snap.uploading && !t.uploads.has(snap.active)) uploadFile(t, snap.active, snap.attempt);
  } else if (snap.active === -1) {
    resumeDownloads(t);
  }
  updateTransfer(t);
}

/** Start the next file that still has to come down, if the sender is there to send it. */
function resumeDownloads(t) {
  const next = t.fileStates.indexOf('pending');
  if (t.final || t.state !== 'accepted' || t.peerAway || next === -1) return;
  startDownload(t, next);
}

/**
 * Ask the browser to download a file. A hidden frame is used so the page
 * itself never navigates; the browser hands the response to its own download
 * manager, which writes straight to disk.
 */
function startDownload(t, idx) {
  const frame = el('iframe', { hidden: true, tabindex: '-1', 'aria-hidden': 'true', src: fileUrl(t, idx) });
  document.body.append(frame);
  t.frames.push(frame);

  // If the request never reaches the server, the browser held the download
  // back. Offer a link instead: a tap on it is always allowed to download.
  clearTimeout(t.stuckTimer);
  t.stuckTimer = setTimeout(() => {
    if (t.final || t.fileStates[idx] !== 'pending') return;
    t.needsTap = idx;
    t.tapLabel = 'Save file';
    updateTransfer(t);
  }, 4000);
}

// ── Activity list ─────────────────────────────────────────────────────────

function addTransfer({ id, dir, peerId, files, blobs = null }) {
  const t = {
    id,
    dir, // 'out' or 'in'
    peerId,
    files,
    blobs,
    totalSize: files.reduce((sum, file) => sum + file.size, 0),
    state: 'offered', // offered → accepted → done | declined | cancelled | expired | failed
    final: false,
    endedBy: null,
    reason: null,
    fileStates: files.map(() => 'pending'),
    activeIdx: -1,
    activeSent: 0,
    interrupted: false,
    interruptReason: '',
    peerAway: false, // the other device dropped off; the transfer waits for it
    needsTap: -1, // index of a file the person has to tap to download
    tapLabel: '',
    dlKey: null,
    uploads: new Map(),
    frames: [],
    stuckTimer: 0,
    ui: null,
  };
  transfers.set(id, t);

  const ui = { actionKey: null };
  ui.root = el(
    'li',
    { class: 'item' },
    el('div', { class: 'item-icon' }, icon(dir === 'out' ? 'up' : 'down')),
    el(
      'div',
      { class: 'item-body' },
      files.length === 1 ? fileNameNode(files[0].name, 'p') : el('p', { class: 'file-name' }, `${files.length} files`),
      (ui.sub = el('p', { class: 'item-sub' })),
      (ui.bar = el('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, (ui.fill = el('div', { class: 'bar-fill' })))),
      (ui.status = el('p', { class: 'item-status' })),
    ),
    (ui.actions = el('div', { class: 'item-actions' })),
  );
  t.ui = ui;
  $('activity').prepend(ui.root);
  $('activity-section').hidden = false;
  updateTransfer(t);
  return t;
}

function statusText(t, percent) {
  const peer = nameOf(t.peerId);
  const sending = t.dir === 'out';
  switch (t.state) {
    case 'offered':
      return `Waiting for ${peer} to accept`;
    case 'done':
      return sending ? 'Sent' : 'Saved to your downloads';
    case 'declined':
      return `${peer} declined`;
    case 'expired':
      return sending ? `${peer} didn’t answer in time` : 'Timed out';
    case 'failed':
      return 'The connection dropped before this finished';
    case 'cancelled':
      if (t.reason === 'peer-left') return `${peer} disconnected`;
      return me && t.endedBy === me.id ? 'Cancelled' : `Cancelled by ${peer}`;
    default:
  }
  if (t.peerAway) return `${peer} went offline. This carries on if they come back`;
  if (t.activeIdx >= 0) {
    const which = t.files.length > 1 ? ` ${t.activeIdx + 1} of ${t.files.length} · ${t.files[t.activeIdx].name}` : '';
    return `${sending ? 'Sending' : 'Receiving'}${which} · ${percent}%`;
  }
  if (!sending && t.needsTap >= 0) {
    const name = t.files[t.needsTap].name;
    if (t.tapLabel !== 'Retry') return `Your browser paused the download of ${name}`;
    return (
      {
        'receiver-closed': `The download of ${name} was stopped`,
        timeout: `${peer} didn’t start sending ${name}`,
        'connection-lost': `The connection dropped while receiving ${name}`,
        stalled: `${name} stopped coming through`,
      }[t.interruptReason] || `${name} was interrupted`
    );
  }
  if (sending && t.interrupted) {
    const why =
      {
        'receiver-closed': `${peer}’s browser stopped the download`,
        timeout: 'This device didn’t start sending in time',
        'connection-lost': 'The upload was cut off',
        stalled: 'The upload stopped moving',
      }[t.interruptReason] || 'Interrupted';
    return `${why}. Waiting for ${peer} to retry`;
  }
  return sending ? `Accepted. Waiting for ${peer}’s browser` : 'Starting the download';
}

function updateTransfer(t) {
  const { ui } = t;
  const finished = t.files.reduce((sum, file, i) => sum + (t.fileStates[i] === 'done' ? file.size : 0), 0);
  const moved = Math.min(t.totalSize, finished + (t.activeIdx >= 0 ? t.activeSent : 0));
  const percent = t.state === 'done' ? 100 : t.totalSize ? Math.floor((moved / t.totalSize) * 100) : 0;

  ui.root.dataset.state = t.state;
  ui.sub.textContent = `${t.dir === 'out' ? 'To' : 'From'} ${nameOf(t.peerId)} · ${formatBytes(t.totalSize)}`;
  ui.status.textContent = statusText(t, percent);
  ui.bar.hidden = t.state !== 'accepted';
  ui.bar.setAttribute('aria-valuenow', String(percent));
  ui.fill.style.width = `${percent}%`;

  // Progress arrives several times a second; only rebuild the buttons when
  // the set of buttons changes, so a click is never lost to a re-render.
  const tap = !t.final && t.dir === 'in' && t.needsTap >= 0 && !t.peerAway;
  const actionKey = t.final ? 'final' : tap ? `tap:${t.needsTap}:${t.tapLabel}` : 'live';
  if (actionKey === ui.actionKey) return;
  ui.actionKey = actionKey;

  if (t.final) {
    ui.root.dataset.final = '1';
    ui.actions.replaceChildren(dismissButton(ui.root, () => transfers.delete(t.id)));
    ui.actions.classList.add('solo');
    refreshActivity();
    return;
  }
  const buttons = [];
  if (tap) {
    buttons.push(
      el('a', { class: 'btn small primary', href: fileUrl(t, t.needsTap), download: t.files[t.needsTap].name }, t.tapLabel),
    );
  }
  buttons.push(
    el(
      'button',
      {
        class: 'btn small',
        type: 'button',
        onclick: () => api('POST', `/api/transfers/${t.id}/cancel`).catch((err) => toast(err.message)),
      },
      'Cancel',
    ),
  );
  ui.actions.replaceChildren(...buttons);
}

function finalize(t, state, details = {}) {
  if (t.final) return;
  t.state = state;
  t.final = true;
  t.endedBy = details.by || null;
  t.reason = details.reason || null;
  t.needsTap = -1;
  t.activeIdx = -1;
  if (state === 'done') t.fileStates.fill('done');
  clearTimeout(t.stuckTimer);
  for (const xhr of t.uploads.values()) xhr.abort();
  t.uploads.clear();
  t.blobs = null;
  // Leave the frames in place for a moment so the browser has taken over the
  // last download before they go.
  const frames = t.frames;
  t.frames = [];
  setTimeout(() => frames.forEach((frame) => frame.remove()), 5000);
  updateTransfer(t);
}

function dismissButton(root, onDismiss) {
  return el(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': 'Dismiss',
      onclick: () => {
        root.remove();
        if (onDismiss) onDismiss();
        refreshActivity();
      },
    },
    icon('close'),
  );
}

function addTextItem(fromId, text) {
  const trimmed = text.trim();
  const link = /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
  const copy = el('button', { class: 'btn small', type: 'button' }, 'Copy');
  copy.addEventListener('click', async () => {
    const ok = await copyText(text);
    copy.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => (copy.textContent = 'Copy'), 1600);
  });
  const root = el(
    'li',
    { class: 'item', 'data-final': '1' },
    el('div', { class: 'item-icon' }, icon('text')),
    el('div', { class: 'item-body' }, el('p', { class: 'item-sub' }, `From ${nameOf(fromId)}`), el('pre', { class: 'item-text' }, text)),
  );
  root.append(
    el(
      'div',
      { class: 'item-actions' },
      link && el('a', { class: 'btn small', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open'),
      copy,
      dismissButton(root),
    ),
  );
  $('activity').prepend(root);
  refreshActivity();
}

function refreshActivity() {
  const list = $('activity');
  $('activity-section').hidden = list.children.length === 0;
  $('clear-activity').hidden = !list.querySelector('[data-final]');
}

// ── Wiring ────────────────────────────────────────────────────────────────

function wire() {
  const sendDialog = $('send-dialog');
  const offerDialog = $('offer-dialog');
  const nameDialog = $('name-dialog');
  const joinDialog = $('join-dialog');
  const fileInput = $('file-input');

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => button.closest('dialog').close());
  }
  // Clicking the dimmed area around a dialog closes it. The offer dialog is
  // left out: an offer needs an explicit answer.
  for (const dialog of [sendDialog, nameDialog, joinDialog]) {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // Send dialog: files
  $('pick-files').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length || !sendTarget) return;
    sendDialog.close();
    sendFiles(sendTarget, files);
  });
  makeDropTarget($('pick-files'), (files) => {
    if (!files.length || !sendTarget) return;
    sendDialog.close();
    sendFiles(sendTarget, files);
  });
  sendDialog.addEventListener('paste', (event) => {
    const files = [...((event.clipboardData && event.clipboardData.files) || [])];
    if (!files.length || !sendTarget) return;
    event.preventDefault();
    sendDialog.close();
    sendFiles(sendTarget, files);
  });

  // Send dialog: text
  const textArea = $('send-text');
  textArea.addEventListener('input', () => {
    $('send-text-btn').disabled = !textArea.value.trim();
  });
  textArea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('text-form').requestSubmit();
  });
  $('text-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = textArea.value;
    if (!text.trim() || !sendTarget) return;
    const target = sendTarget;
    $('send-text-btn').disabled = true;
    try {
      await api('POST', '/api/text', { to: target, text });
      sendDialog.close();
      toast(`Sent to ${nameOf(target)}`);
    } catch (err) {
      $('send-text-btn').disabled = false;
      toast(err.message);
    }
  });

  // Incoming offers
  $('offer-accept').addEventListener('click', () => answerOffer(true));
  $('offer-decline').addEventListener('click', () => answerOffer(false));
  offerDialog.addEventListener('cancel', (event) => {
    event.preventDefault(); // Escape means "no", not "ask me later"
    answerOffer(false);
  });

  // This device's name
  $('me').addEventListener('click', () => {
    $('name-input').value = myName;
    nameDialog.showModal();
    $('name-input').select();
  });
  $('name-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('name-input').value.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name) return;
    myName = name;
    store.set('localStorage', 'beam.name', name);
    $('me-name').textContent = name;
    nameDialog.close();
    try {
      await api('POST', '/api/me', { name });
    } catch (err) {
      toast(err.message);
    }
  });

  $('clear-activity').addEventListener('click', () => {
    for (const item of $('activity').querySelectorAll('[data-final]')) item.remove();
    for (const t of [...transfers.values()]) if (t.final) transfers.delete(t.id);
    refreshActivity();
  });

  // Dropping a file anywhere else must not make the browser open it.
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.target.closest && event.target.closest('.peer, .dropzone')) return;
    toast(peers.size ? 'Drop files onto a device to send them' : 'Open Beam on another device first');
  });

  window.addEventListener('beforeunload', (event) => {
    if (![...transfers.values()].some((t) => !t.final)) return;
    event.preventDefault(); // closing this page would cut the transfer off
    event.returnValue = '';
  });
  window.addEventListener('pagehide', () => {
    // Tell the server right away so this device disappears from other screens.
    try {
      navigator.sendBeacon('/api/bye', JSON.stringify({ key }));
    } catch {
      // the server notices the closed stream a few seconds later
    }
    if (stream) stream.close();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) connect();
  });
  document.addEventListener('visibilitychange', () => {
    // Phones drop the stream while the page is in the background.
    const replaced = !$('banner').hidden;
    if (document.visibilityState === 'visible' && !replaced && stream && stream.readyState !== EventSource.OPEN) connect();
  });
}

$('me-name').textContent = myName;
wire();
renderPeers();
loadJoinUrl();
connect();

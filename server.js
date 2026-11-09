#!/usr/bin/env node
'use strict';

/*
 * Beam — browser-based file transfer between devices.
 *
 * How a transfer works:
 *   1. Every open page keeps an event stream (SSE) to this server and sees the
 *      other pages in the same "room" (the same network) as devices.
 *   2. The sender offers files to a device and the receiver accepts.
 *   3. The receiver's browser requests each file as an ordinary download. That
 *      request is held open while the server asks the sender to upload the
 *      file, and the upload is piped straight into the download.
 *
 * Nothing is written to disk and only a few socket buffers are held in memory,
 * so file size is limited by the devices' own storage, not by this server.
 */

const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline, Transform } = require('node:stream');

const DEFAULTS = {
  publicDir: path.join(__dirname, 'public'),
  trustProxy: false, // read the client address from X-Forwarded-For
  maxJsonBytes: 1024 * 1024,
  maxTextLength: 100_000,
  maxFilesPerTransfer: 500,
  maxTransfersPerSender: 50,
  offerTtlMs: 5 * 60_000, // an unanswered offer expires
  idleTtlMs: 30 * 60_000, // an accepted transfer with no activity expires
  reconnectGraceMs: 5_000, // how long a dropped event stream may take to come back
  uploadWaitMs: 30_000, // how long a download waits for the sender to start uploading
  stallMs: 120_000, // a file that stops moving for this long is cut loose (dead connection)
  endedTtlMs: 10 * 60_000, // how long a finished transfer's outcome is remembered for reconnecting pages
  heartbeatMs: 20_000,
  sweepMs: 15_000, // how often expired offers and idle transfers are cleared
  progressIntervalMs: 150,
  log: () => {}, // called with one line per notable transfer event
};

const KINDS = new Set(['phone', 'tablet', 'laptop', 'desktop']);
const KEY_RE = /^[0-9a-f]{32,64}$/;
const TRANSFER_ACTION = /^\/api\/transfers\/([0-9a-f]{24})\/(accept|decline|cancel)$/;
const TRANSFER_FILE = /^\/api\/transfers\/([0-9a-f]{24})\/files\/(\d{1,4})$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// The page shows names and text that come from other devices, so it is locked
// down to its own scripts and styles.
const PAGE_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-cache',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const token = (bytes) => crypto.randomBytes(bytes).toString('hex');

// A page proves who it is with a secret key; other devices only ever see this
// id derived from it.
const idFromKey = (key) => crypto.createHash('sha256').update(`beam:${key}`).digest('hex').slice(0, 16);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** One line of display text: no control or direction-override characters, capped length. */
function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .trim();
}

function cleanFileName(value) {
  const base = clean(String(value ?? '').split(/[\\/]/).pop(), 255);
  return base && base !== '.' && base !== '..' ? base : 'file';
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function isPrivateAddress(ip) {
  if (!ip || ip === '::1') return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT range, used by VPN meshes
    );
  }
  return /^(fe80:|f[cd])/i.test(ip);
}

function ipv6Prefix64(ip) {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':');
}

/** Addresses other devices on the network can use to reach this server. */
function lanUrls(port) {
  const found = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const a of addresses || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) found.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  return found.sort((x, y) => rank(x) - rank(y)).map((ip) => `http://${ip}:${port}`);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function createApp(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  /** id -> { id, room, inst, name, kind, label, res, dropTimer } */
  const clients = new Map();
  /** id -> { id, from, to, fromInst, toInst, files, totalSize, state, dlKey, createdAt, touchedAt } */
  const transfers = new Map();
  /** id -> how a recent transfer ended, for pages that were offline when it happened */
  const ended = new Map();

  const involves = (t, clientId) => t.from === clientId || t.to === clientId;

  // ── Devices ────────────────────────────────────────────────────────────

  function send(client, data) {
    const res = client && client.res;
    if (!res || res.destroyed || res.writableEnded) return;
    // A page that has stopped reading (a sleeping phone) must not make us
    // buffer events forever; drop the stream and let it reconnect.
    if (res.writableLength > 1024 * 1024) return void res.destroy();
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function broadcast(room, data, exceptId) {
    for (const c of clients.values()) if (c.room === room && c.id !== exceptId) send(c, data);
  }

  const publicPeer = (c) => ({ id: c.id, name: c.name, kind: c.kind, label: c.label });

  /**
   * Devices see each other when they share a room. Everything on a private
   * network is one room; on a public deployment, devices behind the same
   * public address share one.
   */
  function roomOf(req) {
    let ip = req.socket.remoteAddress || '';
    if (cfg.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) ip = forwarded;
    }
    ip = ip.replace(/^::ffff:/i, '').replace(/%.*$/, '');
    if (isPrivateAddress(ip)) return 'local';
    return `net:${net.isIPv6(ip) ? ipv6Prefix64(ip) : ip}`;
  }

  function authenticate(req) {
    const key = req.headers['x-key'];
    const client = typeof key === 'string' && KEY_RE.test(key) ? clients.get(idFromKey(key)) : null;
    if (!client) throw new HttpError(401, 'Not connected');
    return client;
  }

  function reachablePeer(client, id) {
    const peer = typeof id === 'string' ? clients.get(id) : null;
    if (!peer || peer.id === client.id || peer.room !== client.room) throw new HttpError(404, 'That device is no longer here');
    if (!peer.res) throw new HttpError(409, 'That device is offline right now');
    return peer;
  }

  /**
   * Remove a device from the room. `gone` means its page was closed, which ends
   * everything it was doing. Otherwise it only went quiet (a phone locking its
   * screen, a Wi-Fi drop): unanswered offers are withdrawn, but a transfer that
   * was already accepted is kept so it can carry on if the same page returns.
   */
  function dropClient(client, gone) {
    if (clients.get(client.id) !== client) return;
    clients.delete(client.id);
    clearTimeout(client.dropTimer);
    if (client.res) {
      const res = client.res;
      client.res = null;
      res.end();
    }
    for (const t of [...transfers.values()]) {
      if (!involves(t, client.id)) continue;
      if (gone || t.state === 'offered') finishTransfer(t, 'cancelled', { by: client.id, reason: 'peer-left' });
      else t.files.forEach((_, idx) => abortAttempt(t, idx, 'peer-away'));
    }
    broadcast(client.room, { type: 'peer-left', id: client.id });
  }

  /** A device whose event stream has dropped is still plainly there while its files are moving. */
  const isMovingFiles = (clientId) =>
    [...transfers.values()].some((t) => involves(t, clientId) && t.files.some((f) => f.active && f.active.req));

  function scheduleDrop(client) {
    client.dropTimer = setTimeout(() => {
      if (isMovingFiles(client.id)) scheduleDrop(client);
      else dropClient(client, false);
    }, cfg.reconnectGraceMs);
    client.dropTimer.unref();
  }

  function openEventStream(req, res, url) {
    const key = url.searchParams.get('key') || '';
    if (!KEY_RE.test(key)) throw new HttpError(400, 'Missing or malformed key');
    const id = idFromKey(key);
    const inst = clean(url.searchParams.get('inst'), 32);
    const room = roomOf(req);
    const kind = url.searchParams.get('kind');
    const profile = {
      name: clean(url.searchParams.get('name'), 40) || 'Unnamed device',
      kind: KINDS.has(kind) ? kind : 'desktop',
      label: clean(url.searchParams.get('label'), 40),
    };

    let client = clients.get(id);
    if (client && client.room !== room) {
      dropClient(client, true); // it moved to another network
      client = null;
    }

    // A different page load of the same tab cannot continue what the old page
    // was doing: its files and download links went away with it.
    for (const t of [...transfers.values()]) {
      if (involves(t, id) && (t.from === id ? t.fromInst : t.toInst) !== inst) {
        finishTransfer(t, 'cancelled', { by: id, reason: 'peer-left' });
      }
    }

    let announce = null;
    if (!client) {
      client = { id, room, inst, ...profile, res: null, dropTimer: null };
      clients.set(id, client);
      announce = 'peer-joined';
    } else {
      clearTimeout(client.dropTimer);
      client.dropTimer = null;
      if (client.res) {
        const old = client.res;
        send(client, { type: 'replaced', inst });
        client.res = null;
        old.end();
      }
      if (client.inst !== inst) {
        Object.assign(client, profile, { inst });
        announce = 'peer-updated';
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.on('error', () => {});
    client.res = res;

    res.on('close', () => {
      if (client.res !== res) return; // already replaced by a newer stream
      client.res = null;
      scheduleDrop(client);
    });

    // Events sent while a page was offline are lost, so every (re)connection
    // starts from a full picture of the transfers it is part of.
    send(client, {
      type: 'hello',
      you: publicPeer(client),
      peers: [...clients.values()].filter((c) => c.room === room && c.id !== id).map(publicPeer),
      transfers: [...transfers.values()].filter((t) => involves(t, id)).map(snapshot),
      ended: [...ended.values()].filter((e) => involves(e, id)).map(({ id: tid, state, by, reason }) => ({ id: tid, state, by, reason })),
    });
    if (announce) broadcast(room, { type: announce, peer: publicPeer(client) }, id);
  }

  // ── Transfers ──────────────────────────────────────────────────────────

  const publicTransfer = (t) => ({
    id: t.id,
    from: t.from,
    to: t.to,
    totalSize: t.totalSize,
    files: t.files.map(({ name, size, type }) => ({ name, size, type })),
  });

  const snapshot = (t) => {
    const idx = t.files.findIndex((f) => f.active);
    const a = idx === -1 ? null : t.files[idx].active;
    return {
      ...publicTransfer(t),
      state: t.state,
      done: t.files.map((f) => f.done),
      active: idx,
      attempt: a ? a.n : 0,
      uploading: Boolean(a && a.req),
      sent: a ? a.sent : 0,
    };
  };

  const nameOf = (clientId) => (clients.get(clientId) || { name: 'a device that left' }).name;
  const routeOf = (t) => `${nameOf(t.from)} -> ${nameOf(t.to)}`;

  function notify(t, data) {
    send(clients.get(t.from), data);
    send(clients.get(t.to), data);
  }

  function getTransfer(id) {
    const t = transfers.get(id);
    if (!t) throw new HttpError(404, 'That transfer is no longer available');
    return t;
  }

  function finishTransfer(t, state, extra = {}) {
    if (!transfers.delete(t.id)) return;
    t.state = state;
    t.files.forEach((_, idx) => abortAttempt(t, idx, state, true));
    ended.set(t.id, { id: t.id, from: t.from, to: t.to, state, by: extra.by, reason: extra.reason, at: Date.now() });
    cfg.log(`${routeOf(t)}: ${state}${extra.reason ? ` (${extra.reason})` : ''}`);
    notify(t, { type: 'transfer', id: t.id, state, ...extra });
  }

  /** Stop the download/upload pair that is moving a file, leaving the file requestable again. */
  function abortAttempt(t, idx, reason, silent = false) {
    const file = t.files[idx];
    const a = file.active;
    if (!a) return;
    file.active = null;
    clearTimeout(a.timer);
    if (a.req) a.req.destroy();
    if (!a.res.destroyed) {
      if (a.res.headersSent) {
        a.res.destroy(); // the browser sees a failed download, not a truncated file
      } else {
        a.res.writeHead(204);
        a.res.end();
      }
    }
    if (silent) return;
    cfg.log(`${routeOf(t)}: file ${idx + 1} of ${t.files.length} interrupted (${reason})`);
    notify(t, { type: 'file', id: t.id, idx, state: 'interrupted', reason });
  }

  function createTransfer(client, body) {
    const peer = reachablePeer(client, body.to);
    const list = Array.isArray(body.files) ? body.files : [];
    if (list.length < 1 || list.length > cfg.maxFilesPerTransfer) {
      throw new HttpError(400, `Send between 1 and ${cfg.maxFilesPerTransfer} files at a time`);
    }
    const files = list.map((f) => ({
      name: cleanFileName(f && f.name),
      size: f ? f.size : NaN,
      type: clean(f && f.type, 100),
      done: false,
      attempts: 0,
      active: null,
    }));
    if (files.some((f) => !Number.isSafeInteger(f.size) || f.size < 0)) throw new HttpError(400, 'Invalid file size');
    let live = 0;
    for (const t of transfers.values()) if (t.from === client.id) live++;
    if (live >= cfg.maxTransfersPerSender) throw new HttpError(429, 'Too many transfers in progress');

    const now = Date.now();
    const t = {
      id: token(12),
      from: client.id,
      to: peer.id,
      fromInst: client.inst,
      toInst: peer.inst,
      files,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      state: 'offered',
      dlKey: null,
      createdAt: now,
      touchedAt: now,
    };
    transfers.set(t.id, t);
    cfg.log(`${routeOf(t)}: offered ${files.length} file${files.length === 1 ? '' : 's'}, ${t.totalSize} bytes`);
    send(peer, { type: 'offer', transfer: publicTransfer(t) });
    return t;
  }

  function actOnTransfer(client, t, action) {
    if (action === 'cancel') {
      if (client.id !== t.from && client.id !== t.to) throw new HttpError(403, 'Not your transfer');
      return finishTransfer(t, 'cancelled', { by: client.id });
    }
    if (client.id !== t.to) throw new HttpError(403, 'Not your transfer');
    if (t.state !== 'offered') throw new HttpError(409, 'Already answered');
    if (action === 'decline') return finishTransfer(t, 'declined', { by: client.id });

    cfg.log(`${routeOf(t)}: accepted`);
    t.state = 'accepted';
    t.dlKey = token(16);
    t.touchedAt = Date.now();
    send(clients.get(t.from), { type: 'transfer', id: t.id, state: 'accepted' });
    return { dlKey: t.dlKey };
  }

  const downloadHeaders = (file, length) => ({
    'Content-Type': 'application/octet-stream',
    ...(length == null ? {} : { 'Content-Length': length }),
    'Content-Disposition': contentDisposition(file.name),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });

  /**
   * The receiver's browser asks for a file. This is a plain navigation (so the
   * browser saves it natively, whatever its size), which means it cannot carry
   * headers: it is authorised by the per-transfer key in the URL instead. Any
   * failure answers 204 so the page that started it stays put; the page learns
   * what happened from its event stream.
   */
  function download(req, res, url, id, idx) {
    const t = transfers.get(id);
    const file = t && t.files[idx];
    const sender = t && clients.get(t.from);
    const allowed = t && t.state === 'accepted' && safeEqual(url.searchParams.get('k') || '', t.dlKey);
    if (!allowed || !file || file.done || !sender || !sender.res) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, downloadHeaders(file));
      return res.end();
    }

    // Asking again (a retry, or a second tap) replaces an attempt in flight.
    abortAttempt(t, idx, 'superseded', true);

    const attempt = { n: ++file.attempts, res, req: null, length: null, sent: 0, lastTick: 0, movedAt: Date.now(), timer: null };
    file.active = attempt;
    attempt.timer = setTimeout(() => abortAttempt(t, idx, 'timeout'), cfg.uploadWaitMs);
    attempt.timer.unref();
    res.on('error', () => {});
    res.on('close', () => {
      if (file.active !== attempt || res.writableFinished) return;
      // This also fires when a failed upload tears the pair down; say which end broke.
      const uploadDied = attempt.req && attempt.req.destroyed && !attempt.req.complete;
      abortAttempt(t, idx, uploadDied ? 'connection-lost' : 'receiver-closed');
    });

    t.touchedAt = Date.now();
    notify(t, { type: 'file', id: t.id, idx, state: 'active' });
    send(sender, { type: 'send-file', id: t.id, idx, attempt: attempt.n });
  }

  /** The sender uploads the file a download is waiting for; pipe one into the other. */
  function upload(req, res, url, client, id, idx) {
    const t = getTransfer(id);
    if (client.id !== t.from) throw new HttpError(403, 'Not your transfer');
    const file = t.files[idx];
    const a = file && file.active;
    if (!a || a.req || a.n !== Number(url.searchParams.get('attempt'))) {
      throw new HttpError(409, 'Nothing is waiting for this file');
    }

    // The upload's own length is the truth, not the size in the offer. A
    // browser reports a picked file's size from metadata, and the bytes it
    // then reads can differ: Android hands over photos re-encoded or with
    // location data stripped. With no length at all (a chunked upload) the
    // download is passed on the same way and simply ends when the upload does.
    const declared = req.headers['content-length'];
    const length = typeof declared === 'string' && /^\d+$/.test(declared) ? Number(declared) : null;
    if (length !== file.size) cfg.log(`${routeOf(t)}: file ${idx + 1} is ${length ?? 'an unknown number of'} bytes, offered as ${file.size}`);

    clearTimeout(a.timer);
    a.req = req;
    a.length = length;
    a.movedAt = Date.now();
    a.res.writeHead(200, downloadHeaders(file, length));

    const counter = new Transform({
      transform(chunk, _encoding, done) {
        a.sent += chunk.length;
        const now = Date.now();
        a.movedAt = now;
        if (now - a.lastTick >= cfg.progressIntervalMs) {
          a.lastTick = now;
          t.touchedAt = now;
          notify(t, { type: 'progress', id: t.id, idx, sent: a.sent, size: a.length ?? undefined });
        }
        done(null, chunk);
      },
    });

    pipeline(req, counter, a.res, (err) => {
      if (file.active !== a) return; // aborted from elsewhere, already reported
      if (err || (a.length !== null && a.sent !== a.length)) return abortAttempt(t, idx, 'connection-lost');
      file.active = null;
      file.done = true;
      t.touchedAt = Date.now();
      sendJson(res, 200, { ok: true });
      notify(t, { type: 'file', id: t.id, idx, state: 'done', size: a.sent });
      if (t.files.every((f) => f.done)) finishTransfer(t, 'done');
    });
  }

  function sweep() {
    const now = Date.now();
    for (const t of [...transfers.values()]) {
      // A connection that died without closing (a phone that went to sleep)
      // would otherwise hold its file, and its device, forever.
      t.files.forEach((f, idx) => {
        if (f.active && f.active.req && now - f.active.movedAt > cfg.stallMs) abortAttempt(t, idx, 'stalled');
      });
      const idleFor = now - t.touchedAt;
      if (t.state === 'offered' && idleFor > cfg.offerTtlMs) finishTransfer(t, 'expired');
      else if (t.state === 'accepted' && idleFor > cfg.idleTtlMs && !t.files.some((f) => f.active)) finishTransfer(t, 'expired');
    }
    for (const [id, e] of ended) if (now - e.at > cfg.endedTtlMs) ended.delete(id);
  }

  // ── HTTP ───────────────────────────────────────────────────────────────

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > cfg.maxJsonBytes) throw new HttpError(413, 'Request too large');
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (value && typeof value === 'object') return value;
    } catch {
      // fall through
    }
    throw new HttpError(400, 'Invalid JSON');
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'Bad path');
    }
    if (rel.includes('\0')) throw new HttpError(400, 'Bad path');
    if (rel.endsWith('/')) rel += 'index.html';
    const filePath = path.join(cfg.publicDir, rel);
    if (!filePath.startsWith(cfg.publicDir + path.sep)) throw new HttpError(404, 'Not found');
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!stat.isFile()) throw new HttpError(404, 'Not found');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      ...PAGE_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    pipeline(fs.createReadStream(filePath), res, () => {});
  }

  async function route(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://beam.invalid');
    } catch {
      throw new HttpError(400, 'Bad request');
    }
    const { pathname } = url;
    const { method } = req;

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return serveStatic(req, res, pathname);
    }

    if (pathname === '/api/events' && method === 'GET') return openEventStream(req, res, url);
    if (pathname === '/api/info' && method === 'GET') return sendJson(res, 200, { urls: lanUrls(server.address().port) });

    if (pathname === '/api/bye' && method === 'POST') {
      // Sent with sendBeacon as a page closes, which cannot set headers.
      const { key } = await readJson(req);
      const client = typeof key === 'string' && KEY_RE.test(key) ? clients.get(idFromKey(key)) : null;
      if (client) dropClient(client, true);
      return sendJson(res, 200, { ok: true });
    }

    const fileMatch = TRANSFER_FILE.exec(pathname);
    if (fileMatch && (method === 'GET' || method === 'HEAD')) {
      return download(req, res, url, fileMatch[1], Number(fileMatch[2]));
    }

    // Everything below is called by a page's script and must carry its key.
    const client = authenticate(req);

    if (fileMatch && method === 'PUT') return upload(req, res, url, client, fileMatch[1], Number(fileMatch[2]));

    if (pathname === '/api/me' && method === 'POST') {
      const name = clean((await readJson(req)).name, 40);
      if (!name) throw new HttpError(400, 'Name cannot be empty');
      client.name = name;
      broadcast(client.room, { type: 'peer-updated', peer: publicPeer(client) }, client.id);
      return sendJson(res, 200, { you: publicPeer(client) });
    }

    if (pathname === '/api/text' && method === 'POST') {
      const body = await readJson(req);
      const peer = reachablePeer(client, body.to);
      const { text } = body;
      if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'Nothing to send');
      if (text.length > cfg.maxTextLength) throw new HttpError(413, 'That text is too long to send');
      send(peer, { type: 'text', from: client.id, text });
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/transfers' && method === 'POST') {
      const t = createTransfer(client, await readJson(req));
      return sendJson(res, 201, { id: t.id });
    }

    const actionMatch = TRANSFER_ACTION.exec(pathname);
    if (actionMatch && method === 'POST') {
      const result = actOnTransfer(client, getTransfer(actionMatch[1]), actionMatch[2]);
      return sendJson(res, 200, result || { ok: true });
    }

    throw new HttpError(404, 'Not found');
  }

  function fail(res, err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent || res.destroyed) return void res.destroy();
    // The request body may not have been read (a rejected upload), so the
    // connection is not reused.
    sendJson(res, status, { error: status === 500 ? 'Something went wrong on the server' : err.message }, { Connection: 'close' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => fail(res, err));
  });
  server.requestTimeout = 0; // large uploads may legitimately take hours
  server.on('clientError', (_err, socket) => socket.destroy());

  const heartbeat = setInterval(() => {
    for (const c of clients.values()) if (c.res && !c.res.destroyed) c.res.write(': keep-alive\n\n');
  }, cfg.heartbeatMs);
  const sweeper = setInterval(sweep, cfg.sweepMs);
  heartbeat.unref();
  sweeper.unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(sweeper);
    for (const c of clients.values()) clearTimeout(c.dropTimer);
  });

  return server;
}

// ── Command line ─────────────────────────────────────────────────────────

/** A QR code drawn with half-block characters, so a phone can scan the terminal. */
function terminalQr(text) {
  const qrcode = require('./public/vendor/qrcode.js');
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const lines = [];
  for (let r = -2; r < n + 2; r += 2) {
    let line = '';
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    // Black on white regardless of the terminal theme; scanners need that polarity.
    lines.push(`  \x1b[30;107m${line}\x1b[0m`);
  }
  return lines.join('\n');
}

function printBanner(port) {
  const urls = lanUrls(port);
  const out = ['', '  Beam is running', '', `  This computer   http://localhost:${port}`];
  if (urls.length) {
    urls.forEach((u, i) => out.push(`  ${i ? '             ' : 'Other devices'}   ${u}`));
    if (process.stdout.isTTY) {
      try {
        out.push('', '  Scan to open on a phone that is on the same network:', '', terminalQr(urls[0]));
      } catch {
        // the QR code is a convenience; the address above is enough
      }
    }
  } else {
    out.push('', '  No network connection found. Join a Wi-Fi network to reach other devices.');
  }
  out.push('', '  Press Ctrl+C to stop.', '');
  console.log(out.join('\n'));
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3210;
  const log = (line) => console.log(`  ${new Date().toTimeString().slice(0, 8)}  ${line}`);
  const server = createApp({ trustProxy: process.env.TRUST_PROXY === '1', log });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Try another one:  PORT=${port + 1} npm start`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, process.env.HOST || undefined, () => printBanner(port));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeAllConnections();
    });
  }
}

module.exports = { createApp };

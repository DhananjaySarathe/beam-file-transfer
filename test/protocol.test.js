'use strict';

// End-to-end tests of the server: each test starts its own instance and drives
// it over real HTTP the way two browsers would.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { createApp } = require('../server.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function startServer(t, options = {}) {
  const server = createApp({ reconnectGraceMs: 100, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/** A stand-in for one browser tab. */
class Device {
  constructor(base, name, headers = {}) {
    this.base = base;
    this.name = name;
    this.headers = headers;
    this.key = crypto.randomBytes(16).toString('hex');
    this.inst = crypto.randomBytes(4).toString('hex');
    this.events = [];
    this.waiters = [];
  }

  async connect() {
    const query = new URLSearchParams({ key: this.key, inst: this.inst, name: this.name, kind: 'laptop', label: 'Test' });
    this.req = http.get(`${this.base}/api/events?${query}`, { headers: this.headers }, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const line = buffer
            .slice(0, end)
            .split('\n')
            .find((l) => l.startsWith('data: '));
          buffer = buffer.slice(end + 2);
          if (line) {
            this.events.push(JSON.parse(line.slice(6)));
            this.waiters = this.waiters.filter((w) => !w());
          }
        }
      });
      res.on('error', () => {});
    });
    this.req.on('error', () => {});
    const hello = await this.next((e) => e.type === 'hello');
    this.id = hello.you.id;
    return hello;
  }

  /** The first event not yet consumed that matches; waits for one if needed. */
  next(match, timeoutMs = 3000) {
    const take = () => {
      const i = this.events.findIndex(match);
      return i === -1 ? null : this.events.splice(i, 1)[0];
    };
    const found = take();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = () => {
        const event = take();
        if (!event) return false;
        clearTimeout(timer);
        resolve(event);
        return true;
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`${this.name}: no matching event; unread: ${JSON.stringify(this.events.map((e) => e.type))}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async api(method, path, body, useKey = true) {
    const res = await fetch(this.base + path, {
      method,
      headers: { ...(useKey ? { 'X-Key': this.key } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...this.headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  close() {
    this.req.destroy();
  }
}

async function pair(t, options) {
  const base = await startServer(t, options);
  const a = new Device(base, 'Sender');
  const b = new Device(base, 'Receiver');
  await a.connect();
  await b.connect();
  await a.next((e) => e.type === 'peer-joined');
  return { base, a, b };
}

async function offerAndAccept(a, b, files) {
  const created = await a.api('POST', '/api/transfers', { to: b.id, files });
  assert.equal(created.status, 201);
  const { id } = created.body;
  const offer = await b.next((e) => e.type === 'offer' && e.transfer.id === id);
  const accepted = await b.api('POST', `/api/transfers/${id}/accept`);
  assert.equal(accepted.status, 200);
  await a.next((e) => e.type === 'transfer' && e.id === id && e.state === 'accepted');
  return { id, dlKey: accepted.body.dlKey, offer: offer.transfer };
}

function openUpload(device, id, idx, attempt, size) {
  const req = http.request(`${device.base}/api/transfers/${id}/files/${idx}?attempt=${attempt}`, {
    method: 'PUT',
    headers: { 'X-Key': device.key, 'Content-Length': size, 'Content-Type': 'application/octet-stream' },
  });
  const done = new Promise((resolve) => {
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (error) => resolve({ error }));
  });
  return { req, done };
}

/** Resolves once response headers arrive, which is when the sender has started uploading. */
function openDownload(base, id, idx, k, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/transfers/${id}/files/${idx}?k=${k}`, { method }, (res) => resolve({ req, res }));
    req.on('error', reject);
    req.end();
  });
}

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('aborted')));
  });
}

async function moveFile(a, b, t, idx, data) {
  const download = openDownload(b.base, t.id, idx, t.dlKey);
  const ask = await a.next((e) => e.type === 'send-file' && e.id === t.id && e.idx === idx);
  const upload = openUpload(a, t.id, idx, ask.attempt, data.length);
  upload.req.end(data);
  const { res } = await download;
  const body = await collect(res);
  return { res, body, upload: await upload.done };
}

test('devices on the same network see each other and disappear when they close', async (t) => {
  const base = await startServer(t);
  const a = new Device(base, 'Amber Koala');
  const b = new Device(base, 'Quiet Heron');

  const helloA = await a.connect();
  assert.deepEqual(helloA.peers, []);
  const helloB = await b.connect();
  assert.deepEqual(helloB.peers, [{ id: a.id, name: 'Amber Koala', kind: 'laptop', label: 'Test' }]);
  const joined = await a.next((e) => e.type === 'peer-joined');
  assert.equal(joined.peer.name, 'Quiet Heron');
  assert.notEqual(a.id, b.id);
  assert.ok(!JSON.stringify(helloB).includes(a.key), 'a device never learns another device’s key');

  const renamed = await b.api('POST', '/api/me', { name: '  Kitchen‮   iPad\n' });
  assert.equal(renamed.body.you.name, 'Kitchen iPad');
  assert.equal((await a.next((e) => e.type === 'peer-updated')).peer.name, 'Kitchen iPad');

  b.close();
  assert.equal((await a.next((e) => e.type === 'peer-left')).id, b.id);
});

test('a file streams from sender to receiver intact', async (t) => {
  const { a, b } = await pair(t);
  const data = crypto.randomBytes(8 * 1024 * 1024 + 123);
  const transfer = await offerAndAccept(a, b, [{ name: 'holiday video.mov', size: data.length, type: 'video/quicktime' }]);
  assert.equal(transfer.offer.from, a.id);
  assert.equal(transfer.offer.totalSize, data.length);

  const { res, body, upload } = await moveFile(a, b, transfer, 0, data);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(Number(res.headers['content-length']), data.length);
  assert.match(res.headers['content-disposition'], /^attachment; filename="holiday video\.mov"; filename\*=UTF-8''holiday%20video\.mov$/);
  assert.equal(sha256(body), sha256(data));
  assert.equal(upload.status, 200);

  for (const device of [a, b]) {
    await device.next((e) => e.type === 'file' && e.state === 'active');
    await device.next((e) => e.type === 'progress' && e.sent > 0);
    await device.next((e) => e.type === 'file' && e.state === 'done');
    await device.next((e) => e.type === 'transfer' && e.state === 'done');
  }

  // Once delivered, the link is dead.
  const again = await openDownload(b.base, transfer.id, 0, transfer.dlKey);
  assert.equal(again.res.statusCode, 204);
});

test('several files in one transfer, including an empty one and awkward names', async (t) => {
  const { a, b } = await pair(t);
  const files = [
    { data: Buffer.from('first'), name: 'notes.txt' },
    { data: Buffer.alloc(0), name: 'empty.bin' },
    { data: crypto.randomBytes(70_000), name: 'Résumé “final” 日本.pdf' },
    { data: Buffer.from('x'), name: '../../etc/passwd' },
  ];
  const transfer = await offerAndAccept(
    a,
    b,
    files.map((f) => ({ name: f.name, size: f.data.length, type: '' })),
  );
  assert.deepEqual(
    transfer.offer.files.map((f) => f.name),
    ['notes.txt', 'empty.bin', 'Résumé “final” 日本.pdf', 'passwd'],
  );

  const head = await openDownload(b.base, transfer.id, 2, transfer.dlKey, 'HEAD');
  assert.equal(head.res.statusCode, 200);
  assert.match(head.res.headers['content-disposition'], /^attachment;/);

  for (const idx of [2, 0, 1, 3]) {
    const { res, body } = await moveFile(a, b, transfer, idx, files[idx].data);
    assert.equal(res.statusCode, 200);
    assert.ok(body.equals(files[idx].data), `file ${idx} arrived intact`);
    if (idx === 2) {
      assert.match(res.headers['content-disposition'], /filename\*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%9Cfinal%E2%80%9D%20%E6%97%A5%E6%9C%AC\.pdf$/);
      assert.match(res.headers['content-disposition'], /filename="R_sum_ _final_ __\.pdf"/);
    }
  }
  await a.next((e) => e.type === 'transfer' && e.state === 'done');
  await b.next((e) => e.type === 'transfer' && e.state === 'done');
});

test('a large file is piped through without being held in memory', async (t) => {
  const { a, b } = await pair(t);
  const chunk = crypto.randomBytes(1024 * 1024);
  const chunks = 400;
  const size = chunk.length * chunks;
  const transfer = await offerAndAccept(a, b, [{ name: 'big.bin', size, type: '' }]);

  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const upload = openUpload(a, transfer.id, 0, ask.attempt, size);
  const expected = crypto.createHash('sha256');
  let produced = 0;
  const source = new Readable({
    read() {
      if (produced++ < chunks) {
        expected.update(chunk);
        this.push(chunk);
      } else {
        this.push(null);
      }
    },
  });
  source.pipe(upload.req);

  const before = process.memoryUsage().rss;
  const { res } = await download;
  // A receiver that stalls must slow the sender down rather than fill the server.
  res.pause();
  await new Promise((resolve) => setTimeout(resolve, 400));
  const stalledAt = produced;
  const grown = process.memoryUsage().rss - before;
  res.resume();

  const actual = crypto.createHash('sha256');
  let received = 0;
  for await (const part of res) {
    actual.update(part);
    received += part.length;
  }
  assert.equal(received, size);
  assert.equal(actual.digest('hex'), expected.digest('hex'));
  assert.equal((await upload.done).status, 200);
  assert.ok(stalledAt < chunks / 2, `sender was held back while the receiver stalled (produced ${stalledAt} of ${chunks} MB)`);
  assert.ok(grown < 150 * 1024 * 1024, `memory grew by ${Math.round(grown / 1e6)} MB while stalled`);
});

test('an offer can be declined or withdrawn', async (t) => {
  const { a, b } = await pair(t);
  const file = [{ name: 'a.txt', size: 1, type: 'text/plain' }];

  const first = (await a.api('POST', '/api/transfers', { to: b.id, files: file })).body.id;
  await b.next((e) => e.type === 'offer');
  assert.equal((await b.api('POST', `/api/transfers/${first}/decline`)).status, 200);
  const declined = await a.next((e) => e.type === 'transfer' && e.id === first);
  assert.equal(declined.state, 'declined');
  assert.equal((await b.api('POST', `/api/transfers/${first}/accept`)).status, 404);

  const second = (await a.api('POST', '/api/transfers', { to: b.id, files: file })).body.id;
  await b.next((e) => e.type === 'offer');
  assert.equal((await a.api('POST', `/api/transfers/${second}/cancel`)).status, 200);
  const cancelled = await b.next((e) => e.type === 'transfer' && e.id === second);
  assert.deepEqual([cancelled.state, cancelled.by], ['cancelled', a.id]);
});

test('an offer nobody answers expires', async (t) => {
  const { a, b } = await pair(t, { offerTtlMs: 40, sweepMs: 20 });
  const { id } = (await a.api('POST', '/api/transfers', { to: b.id, files: [{ name: 'a.txt', size: 1, type: '' }] })).body;
  for (const device of [a, b]) {
    const ended = await device.next((e) => e.type === 'transfer' && e.id === id);
    assert.equal(ended.state, 'expired');
  }
  assert.equal((await b.api('POST', `/api/transfers/${id}/accept`)).status, 404);
});

test('cancelling mid-transfer breaks the download instead of leaving a short file', async (t) => {
  const { a, b } = await pair(t);
  const size = 4 * 1024 * 1024;
  const transfer = await offerAndAccept(a, b, [{ name: 'movie.mp4', size, type: 'video/mp4' }]);

  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const upload = openUpload(a, transfer.id, 0, ask.attempt, size);
  upload.req.write(Buffer.alloc(size / 2));
  const { res } = await download;
  const body = collect(res);
  await b.next((e) => e.type === 'progress');

  assert.equal((await b.api('POST', `/api/transfers/${transfer.id}/cancel`)).status, 200);
  await assert.rejects(body, 'the receiver sees a failed download');
  assert.ok((await upload.done).error, 'the sender’s upload is cut off');
  for (const device of [a, b]) {
    const ended = await device.next((e) => e.type === 'transfer' && e.id === transfer.id);
    assert.deepEqual([ended.state, ended.by], ['cancelled', b.id]);
  }
});

test('an interrupted download can be retried', async (t) => {
  const { a, b } = await pair(t);
  const data = crypto.randomBytes(3 * 1024 * 1024);
  const transfer = await offerAndAccept(a, b, [{ name: 'photo.jpg', size: data.length, type: 'image/jpeg' }]);

  // First try: the receiver's connection drops part-way.
  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  assert.equal(ask.attempt, 1);
  const upload = openUpload(a, transfer.id, 0, ask.attempt, data.length);
  upload.req.write(data.subarray(0, 1024 * 1024));
  const { req, res } = await download;
  res.on('error', () => {});
  await b.next((e) => e.type === 'progress');
  req.destroy();
  for (const device of [a, b]) {
    const interrupted = await device.next((e) => e.type === 'file' && e.state === 'interrupted');
    assert.equal(interrupted.reason, 'receiver-closed');
  }
  assert.ok((await upload.done).error);

  // A stale upload for the abandoned attempt is refused.
  const stale = openUpload(a, transfer.id, 0, 1, data.length);
  stale.req.end(data);
  const refused = await stale.done;
  assert.ok(refused.error || refused.status === 409);

  // Second try succeeds and completes the transfer.
  const retry = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const again = await a.next((e) => e.type === 'send-file');
  assert.equal(again.attempt, 2);
  const second = openUpload(a, transfer.id, 0, again.attempt, data.length);
  second.req.end(data);
  const body = await collect((await retry).res);
  assert.equal(sha256(body), sha256(data));
  await b.next((e) => e.type === 'transfer' && e.state === 'done');
});

test('a download gives up politely when the sender never starts uploading', async (t) => {
  const { a, b } = await pair(t, { uploadWaitMs: 50 });
  const transfer = await offerAndAccept(a, b, [{ name: 'a.txt', size: 5, type: '' }]);
  const { res } = await openDownload(b.base, transfer.id, 0, transfer.dlKey);
  assert.equal(res.statusCode, 204);
  const interrupted = await b.next((e) => e.type === 'file' && e.state === 'interrupted');
  assert.equal(interrupted.reason, 'timeout');
});

test('only the two devices in a transfer can touch it', async (t) => {
  const { base, a, b } = await pair(t);
  const c = new Device(base, 'Stranger');
  await c.connect();
  const data = Buffer.from('secret');
  const created = await a.api('POST', '/api/transfers', { to: b.id, files: [{ name: 's.txt', size: data.length, type: '' }] });
  const { id } = created.body;

  assert.equal((await c.api('POST', `/api/transfers/${id}/accept`)).status, 403);
  assert.equal((await c.api('POST', `/api/transfers/${id}/cancel`)).status, 403);
  assert.equal((await a.api('POST', `/api/transfers/${id}/accept`)).status, 403, 'the sender cannot accept for the receiver');
  assert.equal((await a.api('POST', '/api/transfers', { to: b.id, files: [] }, false)).status, 401);
  assert.equal((await b.api('POST', `/api/transfers/${'0'.repeat(24)}/accept`)).status, 404);

  // Not downloadable before it is accepted, nor with the wrong key afterwards.
  assert.equal((await openDownload(base, id, 0, '')).res.statusCode, 204);
  const { dlKey } = (await b.api('POST', `/api/transfers/${id}/accept`)).body;
  assert.equal((await openDownload(base, id, 0, 'f'.repeat(32))).res.statusCode, 204);
  assert.equal((await b.api('POST', `/api/transfers/${id}/accept`)).status, 409);

  // A third device cannot feed bytes into someone else's download.
  const download = openDownload(base, id, 0, dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const forged = openUpload(c, id, 0, ask.attempt, data.length);
  forged.req.end(Buffer.from('forged'));
  const rejected = await forged.done;
  assert.ok(rejected.error || rejected.status === 403);

  const real = openUpload(a, id, 0, ask.attempt, data.length);
  real.req.end(data);
  assert.equal((await collect((await download).res)).toString(), 'secret');
});

test('offers are validated', async (t) => {
  const { a, b } = await pair(t, { maxFilesPerTransfer: 3 });
  const offer = (files, to = b.id) => a.api('POST', '/api/transfers', { to, files });
  const ok = { name: 'a', size: 1, type: '' };

  assert.equal((await offer([])).status, 400);
  assert.equal((await offer([ok, ok, ok, ok])).status, 400);
  assert.equal((await offer([{ name: 'a', size: -1 }])).status, 400);
  assert.equal((await offer([{ name: 'a', size: '5' }])).status, 400);
  assert.equal((await offer([{ name: 'a', size: 1.5 }])).status, 400);
  assert.equal((await offer([null])).status, 400);
  assert.equal((await offer([ok], a.id)).status, 404, 'cannot send to yourself');
  assert.equal((await offer([ok], 'nobody')).status, 404);
});

test('a file whose real size differs from the offer still arrives whole', async (t) => {
  // Phones report a picked photo's size from metadata and then hand over a
  // different number of bytes (re-encoded, or with location data stripped).
  const { a, b } = await pair(t);
  const shorter = crypto.randomBytes(300_000);
  const longer = crypto.randomBytes(900_000);
  const unknown = crypto.randomBytes(500_000);
  const transfer = await offerAndAccept(a, b, [
    { name: 'shorter.jpg', size: 332_000, type: 'image/jpeg' },
    { name: 'longer.jpg', size: 332_000, type: 'image/jpeg' },
    { name: 'unknown.jpg', size: 332_000, type: 'image/jpeg' },
  ]);

  for (const [idx, data] of [shorter, longer].entries()) {
    const { res, body, upload } = await moveFile(a, b, transfer, idx, data);
    assert.equal(res.statusCode, 200);
    assert.equal(Number(res.headers['content-length']), data.length, 'the download is told the real size');
    assert.equal(sha256(body), sha256(data));
    assert.equal(upload.status, 200);
    for (const device of [a, b]) {
      const done = await device.next((e) => e.type === 'file' && e.idx === idx && e.state === 'done');
      assert.equal(done.size, data.length, 'both pages learn the real size');
    }
  }

  // An upload with no declared length at all (chunked).
  const download = openDownload(b.base, transfer.id, 2, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file' && e.idx === 2);
  const req = http.request(`${a.base}/api/transfers/${transfer.id}/files/2?attempt=${ask.attempt}`, {
    method: 'PUT',
    headers: { 'X-Key': a.key },
  });
  const uploaded = new Promise((resolve) => req.on('response', (res) => res.resume().on('end', () => resolve(res.statusCode))));
  req.write(unknown.subarray(0, 200_000));
  req.end(unknown.subarray(200_000));
  const { res } = await download;
  assert.equal(res.headers['content-length'], undefined);
  assert.equal(sha256(await collect(res)), sha256(unknown));
  assert.equal(await uploaded, 200);
  await b.next((e) => e.type === 'transfer' && e.state === 'done');
});

test('an upload that is cut short never reaches the receiver as a complete file', async (t) => {
  const { a, b } = await pair(t);
  const transfer = await offerAndAccept(a, b, [{ name: 'a.bin', size: 1000, type: '' }]);
  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const upload = openUpload(a, transfer.id, 0, ask.attempt, 1000);
  upload.req.write(Buffer.alloc(400));
  const body = collect((await download).res);
  await b.next((e) => e.type === 'progress');
  upload.req.destroy(); // the sender vanishes with 600 bytes still to go

  await assert.rejects(body);
  const interrupted = await b.next((e) => e.type === 'file' && e.state === 'interrupted');
  assert.equal(interrupted.reason, 'connection-lost');
});

test('text reaches the other device', async (t) => {
  const { a, b } = await pair(t, { maxTextLength: 60 });
  const text = 'https://example.com/a?b=1\n<script>alert(1)</script>  ';
  assert.equal((await a.api('POST', '/api/text', { to: b.id, text })).status, 200);
  assert.deepEqual(await b.next((e) => e.type === 'text'), { type: 'text', from: a.id, text });

  assert.equal((await a.api('POST', '/api/text', { to: b.id, text: 'x'.repeat(61) })).status, 413);
  assert.equal((await a.api('POST', '/api/text', { to: b.id, text: '   ' })).status, 400);
  assert.equal((await a.api('POST', '/api/text', { to: b.id, text: 42 })).status, 400);
});

test('reloading the page cancels what that page was doing', async (t) => {
  const { a, b } = await pair(t);
  const transfer = await offerAndAccept(a, b, [{ name: 'a.txt', size: 1, type: '' }]);

  a.close();
  const reloaded = new Device(a.base, 'Sender');
  reloaded.key = a.key; // same tab, new page load
  const hello = await reloaded.connect();
  assert.equal(reloaded.id, a.id);
  assert.deepEqual(hello.transfers, []);

  const ended = await b.next((e) => e.type === 'transfer' && e.id === transfer.id);
  assert.deepEqual([ended.state, ended.reason], ['cancelled', 'peer-left']);
  assert.equal((await openDownload(b.base, transfer.id, 0, transfer.dlKey)).res.statusCode, 204);
});

test('a dropped event stream that comes straight back keeps its transfers', async (t) => {
  const { a, b } = await pair(t, { reconnectGraceMs: 2000 });
  const data = Buffer.from('still here');
  const transfer = await offerAndAccept(a, b, [{ name: 'a.txt', size: data.length, type: '' }]);

  b.close();
  const back = new Device(b.base, 'Receiver');
  back.key = b.key;
  back.inst = b.inst; // same page, the browser reconnected by itself
  const hello = await back.connect();
  assert.deepEqual(
    hello.transfers.map((snap) => [snap.id, snap.state]),
    [[transfer.id, 'accepted']],
  );

  const { body } = await moveFile(a, back, transfer, 0, data);
  assert.equal(body.toString(), 'still here');
});

test('a device that goes quiet keeps its accepted transfer and resumes when it returns', async (t) => {
  const { a, b } = await pair(t);
  const files = [Buffer.from('first file'), Buffer.from('second file')];
  const transfer = await offerAndAccept(
    a,
    b,
    files.map((data, i) => ({ name: `${i}.txt`, size: data.length, type: '' })),
  );
  await moveFile(a, b, transfer, 0, files[0]);
  const unanswered = (await a.api('POST', '/api/transfers', { to: b.id, files: [{ name: 'later.txt', size: 1, type: '' }] })).body.id;

  // The receiver's phone locks: its stream drops and does not come back in time.
  b.close();
  assert.equal((await a.next((e) => e.type === 'peer-left')).id, b.id);
  const withdrawn = await a.next((e) => e.type === 'transfer' && e.id === unanswered);
  assert.deepEqual([withdrawn.state, withdrawn.reason], ['cancelled', 'peer-left'], 'an unanswered offer does not wait around');
  assert.ok(!a.events.some((e) => e.type === 'transfer' && e.id === transfer.id), 'the accepted transfer is kept');
  assert.equal((await a.api('POST', '/api/text', { to: b.id, text: 'hi' })).status, 404, 'it is not reachable meanwhile');

  // Same page comes back and is told exactly where things stand.
  const back = new Device(b.base, 'Receiver');
  back.key = b.key;
  back.inst = b.inst;
  const hello = await back.connect();
  assert.equal((await a.next((e) => e.type === 'peer-joined')).peer.id, b.id);
  assert.equal(hello.transfers.length, 1);
  const snap = hello.transfers[0];
  assert.deepEqual([snap.id, snap.state, snap.done, snap.active], [transfer.id, 'accepted', [true, false], -1]);
  assert.deepEqual(hello.ended, [{ id: unanswered, state: 'cancelled', by: b.id, reason: 'peer-left' }]);

  const { body } = await moveFile(a, back, transfer, 1, files[1]);
  assert.equal(body.toString(), 'second file');
  await back.next((e) => e.type === 'transfer' && e.state === 'done');
});

test('a page that was offline when its transfer finished learns the outcome on return', async (t) => {
  const { a, b } = await pair(t, { reconnectGraceMs: 60 });
  const data = crypto.randomBytes(1024 * 1024);
  const transfer = await offerAndAccept(a, b, [{ name: 'a.bin', size: data.length, type: '' }]);

  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const upload = openUpload(a, transfer.id, 0, ask.attempt, data.length);
  upload.req.write(data.subarray(0, 4096));
  const body = collect((await download).res);

  // The sender's event stream drops while its upload carries on and completes.
  a.close();
  await new Promise((resolve) => setTimeout(resolve, 150));
  upload.req.end(data.subarray(4096));
  assert.equal(sha256(await body), sha256(data));
  await b.next((e) => e.type === 'transfer' && e.state === 'done');

  const back = new Device(a.base, 'Sender');
  back.key = a.key;
  back.inst = a.inst;
  const hello = await back.connect();
  assert.deepEqual(hello.transfers, []);
  assert.deepEqual(hello.ended, [{ id: transfer.id, state: 'done' }]);
});

test('nothing can be downloaded while the sender is unreachable', async (t) => {
  const { a, b } = await pair(t, { reconnectGraceMs: 5000 });
  const data = Buffer.from('worth the wait');
  const transfer = await offerAndAccept(a, b, [{ name: 'a.txt', size: data.length, type: '' }]);

  a.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await openDownload(b.base, transfer.id, 0, transfer.dlKey)).res.statusCode, 204);

  const back = new Device(a.base, 'Sender');
  back.key = a.key;
  back.inst = a.inst;
  await back.connect();
  const { body } = await moveFile(back, b, transfer, 0, data);
  assert.equal(body.toString(), 'worth the wait');
});

test('a device is not dropped while its files are still moving', async (t) => {
  const { a, b } = await pair(t, { reconnectGraceMs: 60 });
  const data = crypto.randomBytes(2 * 1024 * 1024);
  const transfer = await offerAndAccept(a, b, [{ name: 'a.bin', size: data.length, type: '' }]);

  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const upload = openUpload(a, transfer.id, 0, ask.attempt, data.length);
  upload.req.write(data.subarray(0, 1024 * 1024));
  const { res } = await download;
  const body = collect(res);

  b.close(); // only the event stream; the download itself is still running
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(!a.events.some((e) => e.type === 'peer-left'), 'still listed while the download runs');

  upload.req.end(data.subarray(1024 * 1024));
  assert.equal(sha256(await body), sha256(data));
  await a.next((e) => e.type === 'transfer' && e.state === 'done');
  assert.equal((await a.next((e) => e.type === 'peer-left')).id, b.id, 'and dropped once it is idle');
});

test('a file that stops moving is cut loose so it can be retried', async (t) => {
  const { a, b } = await pair(t, { stallMs: 80, sweepMs: 30 });
  const transfer = await offerAndAccept(a, b, [{ name: 'a.bin', size: 1000, type: '' }]);
  const download = openDownload(b.base, transfer.id, 0, transfer.dlKey);
  const ask = await a.next((e) => e.type === 'send-file');
  const upload = openUpload(a, transfer.id, 0, ask.attempt, 1000);
  upload.req.write(Buffer.alloc(400)); // then silence
  const body = collect((await download).res);
  body.catch(() => {});

  const interrupted = await b.next((e) => e.type === 'file' && e.state === 'interrupted');
  assert.equal(interrupted.reason, 'stalled');
  await assert.rejects(body);
  assert.equal((await b.api('POST', `/api/transfers/${transfer.id}/cancel`)).status, 200, 'the transfer itself is still there');
});

test('closing the page ends its transfers at once', async (t) => {
  const { a, b } = await pair(t, { reconnectGraceMs: 60_000 });
  const transfer = await offerAndAccept(a, b, [{ name: 'a.txt', size: 1, type: '' }]);
  const bye = await fetch(`${a.base}/api/bye`, { method: 'POST', body: JSON.stringify({ key: a.key }) });
  assert.equal(bye.status, 200);
  const ended = await b.next((e) => e.type === 'transfer' && e.id === transfer.id);
  assert.deepEqual([ended.state, ended.reason], ['cancelled', 'peer-left']);
  assert.equal((await b.next((e) => e.type === 'peer-left')).id, a.id);
});

test('on a public server, only devices behind the same address see each other', async (t) => {
  const base = await startServer(t, { trustProxy: true });
  const home1 = new Device(base, 'Home laptop', { 'X-Forwarded-For': '203.0.113.7' });
  const home2 = new Device(base, 'Home phone', { 'X-Forwarded-For': '203.0.113.7, 10.0.0.1' });
  const cafe = new Device(base, 'Café laptop', { 'X-Forwarded-For': '198.51.100.20' });
  await home1.connect();
  const helloHome2 = await home2.connect();
  const helloCafe = await cafe.connect();

  assert.deepEqual(
    helloHome2.peers.map((p) => p.name),
    ['Home laptop'],
  );
  assert.deepEqual(helloCafe.peers, []);
  const crossRoom = await cafe.api('POST', '/api/transfers', { to: home1.id, files: [{ name: 'a', size: 1, type: '' }] });
  assert.equal(crossRoom.status, 404);
  assert.equal((await cafe.api('POST', '/api/text', { to: home1.id, text: 'hi' })).status, 404);
});

test('static files are served only from the public folder', async (t) => {
  const base = await startServer(t);
  const raw = (path, method = 'GET') =>
    new Promise((resolve, reject) => {
      const { hostname, port } = new URL(base);
      const req = http.request({ hostname, port, path, method }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  const page = await raw('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'self'/);
  assert.match(page.body, /<title>Beam<\/title>/);
  assert.equal((await raw('/app.js')).status, 200);

  for (const path of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/..%5cserver.js', '/vendor/../../package.json', '/%00', '/nope.js', '/vendor']) {
    const res = await raw(path);
    assert.ok([400, 404].includes(res.status), `${path} -> ${res.status}`);
    assert.ok(!res.body.includes('createApp'), `${path} must not leak server code`);
  }
  assert.equal((await raw('/', 'POST')).status, 405);
  assert.equal((await raw('/api/nope')).status, 401);
});

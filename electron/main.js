'use strict';

/*
 * Beam as a Mac app. It starts the same server `npm start` does, inside the
 * app, and shows Beam's own page in a window. Other devices still just open
 * the address in their browser; nothing changes for them.
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('../server.js');

const FIRST_PORT = Number(process.env.PORT) || 3210;
const PORTS_TO_TRY = 20;

let server = null;
let port = 0;
let win = null;

/** Start the server on the first free port from FIRST_PORT upwards. */
function listen(tryPort, left) {
  return new Promise((resolve, reject) => {
    const s = createApp({ log: (line) => console.log(line) });
    s.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && left > 1) resolve(listen(tryPort + 1, left - 1));
      else reject(err);
    });
    s.listen(tryPort, () => {
      server = s;
      port = tryPort;
      resolve();
    });
  });
}

/** A path in Downloads that does not overwrite anything: "photo (2).jpg". */
function freePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(dir, `${stem} (${n})${ext}`);
  return candidate;
}

function openWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 380,
    minHeight: 520,
    title: 'Beam',
    backgroundColor: '#f6f3ea',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const home = `http://localhost:${port}`;

  // Received files go straight to Downloads, as they do in a browser.
  win.webContents.session.on('will-download', (_event, item) => {
    item.setSavePath(freePath(app.getPath('downloads'), path.basename(item.getFilename())));
  });
  // The window only ever shows Beam; any other link opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(home)) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadURL(home);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    try {
      await listen(FIRST_PORT, PORTS_TO_TRY);
    } catch (err) {
      dialog.showErrorBox('Beam could not start', `No free port between ${FIRST_PORT} and ${FIRST_PORT + PORTS_TO_TRY - 1}.\n\n${err.message}`);
      app.quit();
      return;
    }
    openWindow();
  });

  // Closing the window stops Beam: a server left running with no window would
  // keep this Mac reachable on the network without anyone seeing it.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (!server) return;
    server.close();
    server.closeAllConnections();
  });
}

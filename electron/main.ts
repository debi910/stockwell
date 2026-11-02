// The Windows app. One PC (the "main PC") keeps the books and runs a small server;
// the other PC opens the same books over the office network, like TallyPrime Gold's multi-user mode.
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, buildApp, checkBackupFile, logError } from '../src/server/app';
import type { Books } from '../src/server/books';
import { todayISO } from '../src/core/dates';

const PORT = 7400;
type Config = { mode: 'main' | 'client'; address?: string; lastBackup?: string };

const userData = app.getPath('userData');
const configFile = path.join(userData, 'config.json');
const docs = path.join(app.getPath('documents'), 'Stockwell');
const defaultBackupDir = path.join(docs, 'Backups');
const dbPath = path.join(userData, 'stockwell.db');
const setupPage = path.join(__dirname, 'setup.html');

const readConfig = (): Config | null => {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return null; }
};
const writeConfig = (c: Config) => {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(`${configFile}.tmp`, JSON.stringify(c, null, 2));
  fs.renameSync(`${configFile}.tmp`, configFile); // never leave a half-written config behind
};

const lanAddresses = () =>
  Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

/** An office PC's address: an IPv4 address or a plain PC name. Nothing that could smuggle in a path or a port. */
const ADDRESS_RE = /^(\d{1,3}(\.\d{1,3}){3}|[A-Za-z0-9][A-Za-z0-9-]{0,62}(\.[A-Za-z0-9-]{1,63})*)$/;

const errorLog = path.join(userData, 'logs', 'errors.log');

// Never die silently: write the problem down and keep going where that is safe.
process.on('uncaughtException', (err) => logError(errorLog, 'main', err));
process.on('unhandledRejection', (err) => logError(errorLog, 'main (promise)', err));

const withTimeout = <T>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} took too long`)), ms))]);

let win: BrowserWindow | null = null;
let config = readConfig();
let appOrigin = ''; // where the books screens are served from; only that page may use the desktop functions
let server: FastifyInstance | null = null;
let books: Books | null = null;
let closing = false;

// ----- who may call what -----
const originOf = (url: string | undefined) => { try { return new URL(url ?? '').origin; } catch { return ''; } };
const isSetupPage = (url: string | undefined) => { try { const u = new URL(url ?? ''); return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname)).endsWith(path.normalize('/setup.html')); } catch { return false; } };
function fromBooks(e: IpcMainInvokeEvent) {
  if (!appOrigin || originOf(e.senderFrame?.url) !== appOrigin) throw new Error('Not allowed');
}
function fromSetup(e: IpcMainInvokeEvent) {
  if (!isSetupPage(e.senderFrame?.url)) throw new Error('Not allowed');
}

function createWindow(preload: 'preload.cjs' | 'preload-setup.cjs') {
  win = new BrowserWindow({
    width: 1366, height: 800, minWidth: 1100, minHeight: 640,
    title: 'Stockwell', backgroundColor: '#fbf8f1', show: false,
    webPreferences: { preload: path.join(__dirname, preload), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
  });
  win.setMenuBarVisibility(false); // no menu, so F5 and Ctrl+R stay free for vouchers
  win.removeMenu();
  win.once('ready-to-show', () => { win?.maximize(); win?.show(); });

  // If the screen process crashes, reload it; the books are on the server and are not affected.
  // A screen that keeps crashing is not reloaded forever.
  const crashes: number[] = [];
  win.webContents.on('render-process-gone', (_e, details) => {
    logError(errorLog, 'screen crashed', new Error(details.reason));
    if (details.reason === 'clean-exit') return;
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > 5 * 60_000) crashes.shift();
    if (crashes.length > 3) {
      dialog.showMessageBox({ type: 'error', title: 'Stockwell', message: 'The Stockwell window keeps closing.', detail: `Your saved entries are safe. Please restart the PC and open Stockwell again. Details are in ${errorLog}.` });
      return;
    }
    setTimeout(() => win?.webContents.reload(), 500);
  });
  win.webContents.on('unresponsive', () => logError(errorLog, 'screen', new Error('Window stopped responding')));

  // Only the GST portal, WhatsApp and similar links leave the app, and only in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https:|mailto:|whatsapp:)/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // The window itself never wanders off to another page.
  win.webContents.on('will-navigate', (e, url) => {
    const ok = (appOrigin && originOf(url) === appOrigin) || isSetupPage(url);
    if (!ok) e.preventDefault();
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  return win;
}

async function daily(force = false) {
  if (!books || closing) return;
  const dir = books.company().backup_dir || defaultBackupDir;
  if (!force && config?.lastBackup === todayISO()) return;
  try {
    await backup(books, dir);
    config = { ...(config as Config), lastBackup: todayISO() };
    writeConfig(config);
  } catch (e) {
    logError(errorLog, 'backup', e);
    // A pen drive that is not plugged in should not stop the daily copy: fall back to Documents.
    if (dir !== defaultBackupDir) {
      try { await backup(books, defaultBackupDir); } catch (e2) { logError(errorLog, 'backup (fallback)', e2); }
    }
  }
}

async function startMain() {
  const built = await buildApp({ dbPath, uiDir: path.join(__dirname, '../ui'), errorLog, defaultBackupDir });
  server = built.app;
  books = built.books;
  await server.listen({ port: PORT, host: '0.0.0.0' });

  // Daily backup: once a day while the app is open, and again when it closes.
  daily();
  setInterval(() => daily(), 60 * 60 * 1000);
  return `http://127.0.0.1:${PORT}`;
}

app.on('before-quit', async (e) => {
  if (closing || !server) return;
  e.preventDefault();
  try {
    await withTimeout(daily(true), 20_000, 'Closing backup');
  } catch (err) { logError(errorLog, 'closing backup', err); }
  closing = true;
  try { await withTimeout(server.close(), 10_000, 'Closing the books'); } // closes the database cleanly
  catch (err) { logError(errorLog, 'closing', err); }
  app.quit();
});

async function open() {
  if (!config) {
    const w = createWindow('preload-setup.cjs');
    await w.loadFile(setupPage);
    return;
  }
  try {
    if (config.mode === 'client' && !ADDRESS_RE.test(config.address ?? '')) throw new Error('bad address');
    const url = config.mode === 'main' ? await startMain() : `http://${config.address}:${PORT}`;
    appOrigin = originOf(url);
    const w = createWindow('preload.cjs');
    await w.loadURL(url);
  } catch (e: any) {
    logError(errorLog, 'open', e);
    const msg = config.mode === 'main'
      ? `Stockwell could not start on this PC: ${e.message}. Is Stockwell already open?`
      : `Could not reach the main PC at ${config.address}. Check that the main PC is on and Stockwell is open there, and that both PCs are on the same network.`;
    appOrigin = '';
    // The setup page needs the setup functions, so it always opens in a fresh setup window.
    if (win && !win.isDestroyed()) win.destroy();
    const w = createWindow('preload-setup.cjs');
    await w.loadFile(setupPage, { query: { error: msg, address: config.address ?? '' } });
  }
}

// ----- functions the books screens call (see src/ui/api.ts) -----
const PRINT_PATH = /^\/api\/vouchers\/\d+\/print$/;
ipcMain.handle('savePdf', async (e, url: string, fileName: string) => {
  fromBooks(e);
  let u: URL;
  try { u = new URL(String(url)); } catch { throw new Error('Not a bill'); }
  if (u.origin !== appOrigin || !PRINT_PATH.test(u.pathname)) throw new Error('Only bills can be saved as PDF');
  const dir = path.join(docs, 'Bills');
  fs.mkdirSync(dir, { recursive: true });
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await withTimeout(pdfWin.loadURL(u.toString()), 30_000, 'Opening the bill');
    const pdf = await withTimeout(pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true }), 30_000, 'Making the PDF');
    const safe = String(fileName ?? 'bill').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+/, '').slice(0, 120) || 'bill';
    const file = path.join(dir, safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`);
    fs.writeFileSync(file, pdf);
    return file;
  } finally {
    pdfWin.destroy();
  }
});

ipcMain.handle('saveFile', async (e, fileName: string, content: string) => {
  fromBooks(e);
  const dir = path.join(docs, 'GST');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(fileName ?? 'file.json').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 120);
  const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(dir, safe), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(content ?? ''));
  return r.filePath;
});

ipcMain.handle('openExternal', async (e, url: string) => {
  fromBooks(e);
  url = String(url ?? '');
  if (!/^(https:|whatsapp:|upi:|mailto:)/i.test(url)) throw new Error('Blocked link');
  if (url.startsWith('whatsapp:') && !app.getApplicationNameForProtocol(url)) throw new Error('WhatsApp Desktop is not installed');
  await shell.openExternal(url);
});

ipcMain.handle('showInFolder', async (e, file: string) => {
  fromBooks(e);
  // Only files Stockwell itself saved (bills and GST files).
  const p = path.resolve(String(file ?? ''));
  if (!p.startsWith(path.resolve(docs) + path.sep)) throw new Error('Not allowed');
  shell.showItemInFolder(p);
});

ipcMain.handle('chooseFolder', async (e) => {
  fromBooks(e);
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('connection', async (e) => {
  fromBooks(e);
  return {
    mode: config?.mode ?? 'main',
    address: config?.address ?? '127.0.0.1',
    lanAddresses: lanAddresses(),
    dataDir: config?.mode === 'main' ? userData : undefined,
  };
});

ipcMain.handle('resetConnection', async (e) => {
  fromBooks(e);
  fs.rmSync(configFile, { force: true });
  app.relaunch();
  app.quit(); // runs the closing backup first
});

/** Puts a backup back in place of the current books. Owner only, main PC only. */
ipcMain.handle('restore', async (e, token: string | null) => {
  fromBooks(e);
  if (config?.mode !== 'main' || !server || !books) throw new Error('Restoring is done on the main PC.');
  const s = await server.inject({ method: 'GET', url: '/api/session', headers: token ? { 'x-stockwell-token': String(token) } : {} });
  const session = JSON.parse(s.body);
  if (session.usersEnabled && session.user?.role !== 'owner') throw new Error('Only an Owner can restore a backup.');

  const pick = await dialog.showOpenDialog(win!, {
    title: 'Choose the backup to restore',
    defaultPath: books.company().backup_dir || defaultBackupDir,
    filters: [{ name: 'Stockwell backup', extensions: ['db'] }], properties: ['openFile'],
  });
  if (pick.canceled || !pick.filePaths[0]) return;
  const file = pick.filePaths[0];
  if (path.resolve(file) === path.resolve(dbPath)) throw new Error('That is the books file in use now. Choose a backup copy.');
  const info = checkBackupFile(file);
  const answer = await dialog.showMessageBox(win!, {
    type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Restore backup',
    message: `Replace the current books with this backup?`,
    detail: `${path.basename(file)}\nCompany: ${info.company || '(not set)'}\nVouchers: ${info.vouchers}${info.lastDate ? `, last entry on ${info.lastDate}` : ''}\n\nEntries made after this backup will not be in the restored books. The current books are kept as a safety copy. Stockwell restarts after restoring.`,
  });
  if (answer.response !== 0) return;

  // Keep a safety copy of the current books first, while they are still open and consistent.
  const safetyDir = path.join(userData, 'safety-copies');
  fs.mkdirSync(safetyDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const safety = path.join(safetyDir, `stockwell-before-restore-${stamp}.db`);
  await books.db.backup(safety);

  closing = true;
  await server.close(); // closes the database and folds the write-ahead log into the file
  try {
    for (const ext of ['-wal', '-shm']) fs.rmSync(dbPath + ext, { force: true });
    fs.copyFileSync(file, `${dbPath}.restoring`);
    fs.renameSync(`${dbPath}.restoring`, dbPath);
  } catch (err) {
    logError(errorLog, 'restore', err);
    try { fs.copyFileSync(safety, dbPath); } catch (err2) { logError(errorLog, 'restore (undo)', err2); }
    dialog.showErrorBox('Restore failed', `The backup could not be put in place, so the books were left as they were. Details are in ${errorLog}.`);
  }
  app.relaunch();
  app.exit(0);
});

// ----- first-run setup page -----
ipcMain.handle('setup:lan', async (e) => { fromSetup(e); return lanAddresses(); });
ipcMain.handle('setup:test', async (e, address: string) => {
  fromSetup(e);
  if (!ADDRESS_RE.test(String(address ?? ''))) return false;
  try {
    const r = await fetch(`http://${address}:${PORT}/api/meta`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
});
ipcMain.handle('setup:choose', async (e, mode: 'main' | 'client', address?: string) => {
  fromSetup(e);
  if (mode !== 'main' && mode !== 'client') throw new Error('Choose main PC or second PC');
  if (mode === 'client' && !ADDRESS_RE.test(String(address ?? ''))) throw new Error('Type the main PC address, like 192.168.1.10');
  writeConfig({ mode, address: mode === 'client' ? address : undefined });
  app.relaunch();
  app.exit(0);
});

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(open);
  app.on('window-all-closed', () => app.quit());
}

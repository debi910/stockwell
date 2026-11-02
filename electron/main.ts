// The Windows app. One PC (the "main PC") keeps the books and runs a small server;
// the other PC opens the same books over the office network, like TallyPrime Gold's multi-user mode.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backup, buildApp, logError } from '../src/server/app';
import { todayISO } from '../src/core/dates';

const PORT = 7400;
type Config = { mode: 'main' | 'client'; address?: string; lastBackup?: string };

const userData = app.getPath('userData');
const configFile = path.join(userData, 'config.json');
const docs = path.join(app.getPath('documents'), 'Stockwell');

const readConfig = (): Config | null => {
  try { return JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch { return null; }
};
const writeConfig = (c: Config) => { fs.mkdirSync(userData, { recursive: true }); fs.writeFileSync(configFile, JSON.stringify(c, null, 2)); };

const lanAddresses = () =>
  Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

const errorLog = path.join(userData, 'logs', 'errors.log');

// Never die silently: write the problem down and keep going where that is safe.
process.on('uncaughtException', (err) => logError(errorLog, 'main', err));
process.on('unhandledRejection', (err) => logError(errorLog, 'main (promise)', err));

let win: BrowserWindow | null = null;
let config = readConfig();

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function createWindow() {
  win = new BrowserWindow({
    width: 1366, height: 800, minWidth: 1100, minHeight: 640,
    title: 'Stockwell', backgroundColor: '#fbf8f1', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: false },
  });
  win.setMenuBarVisibility(false); // no menu, so F5 and Ctrl+R stay free for vouchers
  win.removeMenu();
  win.once('ready-to-show', () => win?.maximize());
  win.once('ready-to-show', () => win?.show());
  // Links to the GST portal and WhatsApp open outside the app.
  // If the screen process crashes, reload it; the books are on the server and are not affected.
  win.webContents.on('render-process-gone', (_e, details) => {
    logError(errorLog, 'screen crashed', new Error(details.reason));
    if (details.reason !== 'clean-exit') setTimeout(() => win?.webContents.reload(), 500);
  });
  win.webContents.on('unresponsive', () => logError(errorLog, 'screen', new Error('Window stopped responding')));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return win;
}

async function startMain() {
  const dbPath = path.join(userData, 'stockwell.db');
  const { app: server, books } = await buildApp({ dbPath, uiDir: path.join(__dirname, '../ui'), errorLog });
  await server.listen({ port: PORT, host: '0.0.0.0' });

  // Daily backup: once a day while the app is open, and again when it closes.
  const daily = async (force = false) => {
    const dir = books.company().backup_dir;
    if (!dir) return;
    if (!force && config?.lastBackup === todayISO()) return;
    try {
      await backup(books, dir);
      config = { ...(config as Config), lastBackup: todayISO() };
      writeConfig(config);
    } catch (e) { logError(errorLog, 'backup', e); }
  };
  daily();
  setInterval(daily, 60 * 60 * 1000);
  app.on('before-quit', async (e) => {
    if ((app as any).__closing) return;
    e.preventDefault();
    (app as any).__closing = true;
    try {
      await daily(true);
      await server.close(); // closes the database cleanly
    } catch (err) { logError(errorLog, 'closing', err); }
    app.quit();
  });
  return `http://127.0.0.1:${PORT}`;
}

async function open() {
  const w = createWindow();
  if (!config) {
    await w.loadFile(path.join(__dirname, 'setup.html'));
    return;
  }
  try {
    const url = config.mode === 'main' ? await startMain() : `http://${config.address}:${PORT}`;
    await w.loadURL(url);
  } catch (e: any) {
    const msg = config.mode === 'main'
      ? `Stockwell could not start on this PC: ${e.message}. Is Stockwell already open?`
      : `Could not reach the main PC at ${config.address}. Check that the main PC is on and Stockwell is open there, and that both PCs are on the same network.`;
    await w.loadFile(path.join(__dirname, 'setup.html'), { query: { error: msg, address: config.address ?? '' } });
  }
}

// ----- functions the screens call (see src/ui/api.ts) -----
ipcMain.handle('savePdf', async (_e, url: string, fileName: string) => {
  const dir = path.join(docs, 'Bills');
  fs.mkdirSync(dir, { recursive: true });
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pdfWin.loadURL(url);
    const pdf = await pdfWin.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
    const file = path.join(dir, fileName.replace(/[\\/:*?"<>|]/g, '-'));
    fs.writeFileSync(file, pdf);
    return file;
  } finally {
    pdfWin.destroy();
  }
});

ipcMain.handle('saveFile', async (_e, fileName: string, content: string) => {
  const dir = path.join(docs, 'GST');
  fs.mkdirSync(dir, { recursive: true });
  const r = await dialog.showSaveDialog(win!, { defaultPath: path.join(dir, fileName), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, content);
  return r.filePath;
});

ipcMain.handle('openExternal', async (_e, url: string) => {
  if (!/^(https?|whatsapp|upi|mailto):/i.test(url)) throw new Error('Blocked link');
  if (url.startsWith('whatsapp:') && !app.getApplicationNameForProtocol(url)) throw new Error('WhatsApp Desktop is not installed');
  await shell.openExternal(url);
});

ipcMain.handle('showInFolder', async (_e, file: string) => shell.showItemInFolder(file));

ipcMain.handle('chooseFolder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('connection', async () => ({
  mode: config?.mode ?? 'main',
  address: config?.address ?? '127.0.0.1',
  lanAddresses: lanAddresses(),
  dataDir: config?.mode === 'main' ? userData : undefined,
}));

ipcMain.handle('resetConnection', async () => {
  fs.rmSync(configFile, { force: true });
  app.relaunch();
  app.exit(0);
});

// ----- first-run setup page -----
ipcMain.handle('setup:lan', async () => lanAddresses());
ipcMain.handle('setup:test', async (_e, address: string) => {
  try {
    const r = await fetch(`http://${address}:${PORT}/api/meta`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
});
ipcMain.handle('setup:choose', async (_e, mode: 'main' | 'client', address?: string) => {
  writeConfig({ mode, address: mode === 'client' ? address : undefined });
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(open);
app.on('window-all-closed', () => app.quit());

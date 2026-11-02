import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';
import { Books, BooksError, VOUCHER_TYPES } from './books';
import * as R from './reports';
import { gstr1, gstr3b, ewayBillJson, ewayCandidates } from './gstExport';
import { billMessage, invoiceHtml, reminderMessage } from './invoice';
import { fetchTallyMasters, importTallyMasters, parseTallyMasters } from './tally';
import { installAuth, type Users } from './users';
import { STATES, GST_RATES } from '../core/gst';
import { financialYear, todayISO } from '../core/dates';

export interface AppOptions {
  dbPath: string;
  uiDir?: string;
  logger?: boolean;
  /** File where unexpected errors are written, so a problem can be traced later. */
  errorLog?: string;
  /** Where backups go when no folder is chosen in Company settings (Documents\\Stockwell\\Backups on Windows). */
  defaultBackupDir?: string;
}

/** Appends one line to the error log; never throws (a full disk must not crash the server). */
export function logError(file: string | undefined, where: string, err: unknown) {
  const e = err as Error;
  const line = `${new Date().toISOString()} [${where}] ${e?.message ?? String(err)}\n${e?.stack ?? ''}\n`;
  if (!file) { console.error(line); return; }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, line);
  } catch { console.error(line); }
}

type Q = Record<string, string | undefined>;

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; books: Books; users: Users }> {
  const db = openDb(opts.dbPath);
  const books = new Books(db);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (err instanceof BooksError) return reply.status(400).send({ error: err.message });
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.status(400).send({ error: 'That name is already used.' });
    if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return reply.status(400).send({ error: 'This is used in other entries, so it cannot be removed or changed this way.' });
    if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') return reply.status(503).send({ error: 'The books are busy with another save. Please press Ctrl+A again.' });
    if (e.code === 'SQLITE_FULL') { logError(opts.errorLog, 'disk', err); return reply.status(507).send({ error: 'The disk on the main PC is full. Nothing was saved. Free some space and try again.' }); }
    if (e.code?.startsWith?.('FST_ERR_CTP') || (e as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ error: 'The request was not understood. Please try again.' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    logError(opts.errorLog, `server ${_req.method} ${_req.url.split('?')[0]}`, err);
    return reply.status(500).send({ error: `Something went wrong and nothing was saved. (${e.message || 'unknown error'})` });
  });

  app.addHook('onClose', async () => db.close());
  const users = installAuth(app, books);

  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const asOf = (q: Q) => q.to || q.asOf || todayISO();

  // ----- reference data -----
  // Basic browser protections for every page and answer.
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    return payload;
  });
  app.get('/api/meta', async () => ({
    states: STATES, gstRates: GST_RATES, voucherTypes: VOUCHER_TYPES, today: todayISO(), version: '0.1.0',
  }));
  app.get('/api/company', async () => ({ ...books.company(), fy: financialYear(todayISO()), default_backup_dir: opts.defaultBackupDir ?? '' }));
  app.put('/api/company', async (req) => books.updateCompany(req.body as Record<string, never>));

  // ----- accounting masters -----
  app.get('/api/groups', async () => books.groups());
  app.post('/api/groups', async (req) => books.createGroup(req.body as { name: string; parentId: number }));
  app.get('/api/ledgers', async () => {
    const balances = new Map(R.yearBalances(books, todayISO()).map((b) => [b.id, b.balance]));
    return books.ledgers().map((l) => ({ ...l, balance: balances.get(l.id) ?? 0, bill_wise: books.isBillWise(l.id) }));
  });
  app.get('/api/ledgers/:id', async (req) => books.ledger(Number((req.params as Q).id)));
  app.post('/api/ledgers', async (req) => books.createLedger(req.body as never));
  app.put('/api/ledgers/:id', async (req) => books.updateLedger(Number((req.params as Q).id), req.body as never));
  app.delete('/api/ledgers/:id', async (req) => { books.deleteLedger(Number((req.params as Q).id)); return { ok: true }; });

  // ----- inventory masters -----
  app.get('/api/units', async () => books.units());
  app.post('/api/units', async (req) => books.createUnit(req.body as never));
  app.get('/api/stock-groups', async () => books.stockGroups());
  app.post('/api/stock-groups', async (req) => books.createStockGroup((req.body as { name: string }).name));
  app.get('/api/items', async () => {
    const stock = new Map(R.stockSummary(books, todayISO()).map((s) => [s.id, s.closing_qty]));
    return (books.items() as { id: number }[]).map((i) => ({ ...i, stock: stock.get(i.id) ?? 0 }));
  });
  app.get('/api/items/:id', async (req) => books.item(Number((req.params as Q).id)));
  app.post('/api/items', async (req) => books.createItem(req.body as never));
  app.put('/api/items/:id', async (req) => books.updateItem(Number((req.params as Q).id), req.body as never));
  app.get('/api/items/:id/batches', async (req) => books.batches(Number((req.params as Q).id), (req.query as Q).asOf));

  // ----- vouchers -----
  app.get('/api/vouchers', async (req) => {
    const q = req.query as Q;
    return books.vouchers({ from: q.from, to: q.to, type: q.type, ledgerId: num(q.ledgerId) });
  });
  app.get('/api/vouchers/next-number', async (req) => {
    const q = req.query as Q;
    return books.nextNumber(q.type as never, q.date || todayISO());
  });
  app.get('/api/vouchers/:id', async (req) => books.voucher(Number((req.params as Q).id)));
  app.post('/api/vouchers', async (req) => books.createVoucher(req.body as never));
  app.put('/api/vouchers/:id', async (req) => books.updateVoucher(Number((req.params as Q).id), req.body as never));
  app.post('/api/vouchers/:id/cancel', async (req) => books.cancelVoucher(Number((req.params as Q).id)));
  app.put('/api/vouchers/:id/ewb', async (req) => {
    const id = Number((req.params as Q).id);
    const ewbNo = String((req.body as { ewbNo?: unknown } | null)?.ewbNo ?? '').trim();
    if (ewbNo && !/^\d{12}$/.test(ewbNo)) throw new BooksError('An e-Way Bill number has 12 digits.');
    const v = books.db.prepare(`SELECT ewb_no, cancelled FROM vouchers WHERE id=?`).get(id) as { ewb_no: string | null; cancelled: number } | undefined;
    if (!v) throw new BooksError('Voucher not found.');
    if (v.cancelled) throw new BooksError('This voucher is cancelled. Cancel its e-Way Bill on the portal too.');
    books.db.transaction(() => {
      books.db.prepare(`UPDATE vouchers SET ewb_no=? WHERE id=?`).run(ewbNo || null, id);
      books.audit('voucher', id, 'ewb', { before: v.ewb_no ?? '', after: ewbNo });
    })();
    return books.voucher(id);
  });
  app.get('/api/vouchers/:id/print', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
    // The bill page runs no scripts at all, whatever a name or address in it says.
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    reply.header('X-Content-Type-Options', 'nosniff');
    return invoiceHtml(books, Number((req.params as Q).id));
  });
  app.get('/api/vouchers/:id/whatsapp', async (req) => billMessage(books, Number((req.params as Q).id)));

  // ----- reports -----
  app.get('/api/reports/trial-balance', async (req) => R.trialBalance(books, asOf(req.query as Q)));
  app.get('/api/reports/profit-loss', async (req) => {
    const q = req.query as Q;
    const to = asOf(q);
    return R.profitAndLoss(books, q.from || maxDate(financialYear(to).start, books.company().books_from), to);
  });
  app.get('/api/reports/balance-sheet', async (req) => R.balanceSheet(books, asOf(req.query as Q)));
  app.get('/api/reports/ledger/:id', async (req) => {
    const q = req.query as Q;
    const to = asOf(q);
    return R.ledgerStatement(books, Number((req.params as Q).id), q.from || maxDate(financialYear(to).start, books.company().books_from), to);
  });
  app.get('/api/reports/day-book', async (req) => {
    const q = req.query as Q;
    const to = asOf(q);
    return R.dayBook(books, q.from || to, to);
  });
  app.get('/api/reports/stock-summary', async (req) => {
    const q = req.query as Q;
    return R.stockSummary(books, asOf(q), q.from);
  });
  app.get('/api/reports/outstanding', async (req) => {
    const q = req.query as Q;
    const bills = books.pendingBills({ asOf: asOf(q), ledgerId: num(q.ledgerId) });
    const kind = q.kind ?? 'receivable';
    return bills.filter((b) => (kind === 'receivable' ? b.pending > 0 : b.pending < 0));
  });
  app.get('/api/reports/pending-bills/:ledgerId', async (req) => books.pendingBills({ ledgerId: Number((req.params as Q).ledgerId), asOf: (req.query as Q).asOf || undefined }));
  app.get('/api/reports/alerts', async (req) => R.alerts(books, asOf(req.query as Q)));
  app.get('/api/reports/reminder/:ledgerId', async (req) => reminderMessage(books, Number((req.params as Q).ledgerId)));

  // ----- GST -----
  app.get('/api/gst/gstr1', async (req) => gstr1(books, (req.query as Q).period || todayISO().slice(0, 7)));
  app.get('/api/gst/gstr3b', async (req) => gstr3b(books, (req.query as Q).period || todayISO().slice(0, 7)));
  app.get('/api/gst/eway-candidates', async (req) => {
    const q = req.query as Q;
    const to = asOf(q);
    return ewayCandidates(books, q.from || to, to, q.all === '1');
  });
  app.post('/api/gst/eway-json', async (req) => ewayBillJson(books, (req.body as { ids: number[] }).ids ?? []));

  // ----- utilities -----
  app.post('/api/import/tally', { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const body = (req.body ?? {}) as { xml?: string; url?: string };
    if (body.xml !== undefined && typeof body.xml !== 'string') throw new BooksError('The Tally file could not be read.');
    const xml = body.xml ?? (await fetchTallyMasters(body.url || 'http://localhost:9000'));
    return importTallyMasters(books, parseTallyMasters(xml));
  });
  app.post('/api/backup', async (req) => {
    const dir = books.company().backup_dir || opts.defaultBackupDir;
    if (!dir) throw new BooksError('Choose a backup folder in Company settings first.');
    return backup(books, dir);
  });
  app.get('/api/audit', async () => books.auditLog());
  app.post('/api/client-error', { bodyLimit: 32 * 1024 }, async (req) => {
    const b = (req.body ?? {}) as { message?: string; stack?: string };
    logError(opts.errorLog, 'screen', Object.assign(new Error(String(b.message ?? '').slice(0, 500)), { stack: String(b.stack ?? '').slice(0, 8000) }));
    return { ok: true };
  });

  if (opts.uiDir && fs.existsSync(opts.uiDir)) {
    await app.register(fastifyStatic, { root: opts.uiDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }

  return { app, books, users };
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

/** Copies the live database to a dated file and keeps the newest 30 copies. */
export async function backup(books: Books, dir: string) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {
    throw new BooksError(`Cannot use the backup folder ${dir}. Is the pen drive plugged in?`);
  }
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `stockwell-${stamp}.db`);
  const part = `${file}.part`;
  await books.db.backup(part);
  // Open the copy and check it, so a bad pen drive is found today and not on the day the copy is needed.
  try {
    const copy = new Database(part, { readonly: true });
    try {
      const r = copy.pragma('integrity_check', { simple: true });
      if (r !== 'ok') throw new Error(String(r));
      copy.prepare('SELECT COUNT(*) FROM vouchers').get();
    } finally { copy.close(); }
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw new BooksError(`The backup copy did not check out (${(e as Error).message}). Try another folder or pen drive.`);
  }
  fs.renameSync(part, file);
  prune(dir);
  books.db.prepare(`UPDATE company SET last_backup=? WHERE id=1`).run(new Date().toISOString());
  return { file };
}

/** Keeps the newest 30 copies, plus the last copy of each older month for two years. */
function prune(dir: string) {
  const all = fs.readdirSync(dir).filter((f) => /^stockwell-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse();
  const keep = new Set(all.slice(0, 30));
  const months = new Set<string>();
  for (const f of all) {
    const month = f.slice(10, 17);
    if (!months.has(month)) { months.add(month); if (months.size <= 24) keep.add(f); }
  }
  for (const f of all) if (!keep.has(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use; try next time */ } }
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.db.part')) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
}

/** Checks that a file is a whole Stockwell books file before it is restored. */
export function checkBackupFile(file: string): { company: string; vouchers: number; lastDate: string | null } {
  let db: Database.Database;
  try { db = new Database(file, { readonly: true, fileMustExist: true }); } catch { throw new BooksError('That file could not be opened.'); }
  try {
    const r = db.pragma('integrity_check', { simple: true });
    if (r !== 'ok') throw new BooksError('That backup is damaged and cannot be restored.');
    const c = db.prepare(`SELECT name FROM company WHERE id=1`).get() as { name: string } | undefined;
    const v = db.prepare(`SELECT COUNT(*) n, MAX(date) d FROM vouchers`).get() as { n: number; d: string | null };
    return { company: c?.name ?? '', vouchers: v.n, lastDate: v.d };
  } catch (e) {
    if (e instanceof BooksError) throw e;
    throw new BooksError('That file is not a Stockwell backup.');
  } finally { db.close(); }
}

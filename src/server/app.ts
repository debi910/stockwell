import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db';
import { Books, BooksError, VOUCHER_TYPES, isoDate } from './books';
import * as R from './reports';
import { gstr1, gstr3b, gstr2bMatch, ewayBillJson, ewayCandidates, periodRange } from './gstExport';
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
    if (err instanceof BooksError) return reply.status(400).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.status(400).send({ error: 'That name is already used.' });
    if (e.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return reply.status(400).send({ error: 'This is used in other entries, so it cannot be removed or changed this way.' });
    if (e.code === 'SQLITE_BUSY' || e.code === 'SQLITE_LOCKED') return reply.status(503).send({ error: 'The books are busy with another save. Please press Ctrl+A again.' });
    if (e.code === 'SQLITE_FULL') { logError(opts.errorLog, 'disk', err); return reply.status(507).send({ error: 'The disk on the main PC is full. Nothing was saved. Free some space and try again.' }); }
    if (e.code?.startsWith?.('FST_ERR_CTP') || (e as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ error: 'The request was not understood. Please try again.' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    // A field of the wrong kind (a number where text belongs, a list that is not a list) is the sender's mistake, not a crash.
    if (err instanceof TypeError || err instanceof RangeError || /datatype mismatch|parameter values|bind|SQLite3 can only bind/i.test(e.message ?? '')) {
      logError(opts.errorLog, `bad input ${_req.method} ${_req.url.split('?')[0]}`, err);
      return reply.status(400).send({ error: 'Some details were not in the right form (text, number or date). Check the entry and try again.' });
    }
    logError(opts.errorLog, `server ${_req.method} ${_req.url.split('?')[0]}`, err);
    return reply.status(500).send({ error: `Something went wrong and nothing was saved. (${e.message || 'unknown error'})` });
  });

  app.addHook('onClose', async () => db.close());
  // Dates and months in report links must be real ones: a typo gives a clear message, never a crash or a blank report.
  app.addHook('preValidation', async (req) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    for (const k of ['asOf', 'from', 'to', 'date']) if (q[k] !== undefined && q[k] !== '') isoDate(q[k], `The ${k === 'asOf' ? 'as-on' : k} date`);
    for (const k of ['period', 'toPeriod']) {
      if (q[k] !== undefined && q[k] !== '' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(String(q[k]))) throw Object.assign(new BooksError(`The ${k === 'period' ? 'month' : 'last month'} must look like 2026-10.`));
    }
    const p = (req.params ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) if (/id$/i.test(k) && !/^\d+$/.test(String(v))) throw new BooksError('That entry was not found.');
    for (const k of ['ledgerId', 'partyId', 'itemId', 'stockGroupId']) if (q[k] !== undefined && q[k] !== '' && !/^\d+$/.test(String(q[k]))) throw new BooksError('That entry was not found.');
  });
  const users = installAuth(app, books);

  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  /** A text filter from the address: blank means no filter. */
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : undefined);
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
    states: STATES, gstRates: GST_RATES, voucherTypes: VOUCHER_TYPES, today: todayISO(), version: '0.3.0', godowns: books.godowns(), priceLevels: books.priceLevels(),
  }));
  // Every change to the books writes an edit-log row, so its newest id tells open screens on any PC that something changed.
  // Each open Stockwell asks every few seconds, which also tells the main PC how many PCs are working now.
  const lastSeen = new Map<string, number>();
  app.get('/api/changes', async (req) => {
    const now = Date.now();
    lastSeen.set(req.ip, now);
    for (const [ip, t] of lastSeen) if (now - t > 20_000) lastSeen.delete(ip);
    return { v: (books.db.prepare(`SELECT COALESCE(MAX(id),0) AS v FROM audit`).get() as { v: number }).v, pcs: lastSeen.size };
  });
  app.get('/api/company', async () => ({ ...books.company(), fy: financialYear(todayISO()), default_backup_dir: opts.defaultBackupDir ?? '' }));
  app.put('/api/company', async (req) => books.updateCompany(req.body as Record<string, never>));

  // ----- accounting masters -----
  app.get('/api/groups', async () => books.groups());
  app.get('/api/salesmen', async () => books.salesmen());
  // Areas (beats/routes) already used on parties, for the pick lists.
  app.get('/api/areas', async () => (books.db.prepare(`SELECT DISTINCT beat AS name FROM ledgers WHERE TRIM(COALESCE(beat,''))<>'' ORDER BY beat COLLATE NOCASE`).all() as { name: string }[]).map((r) => r.name));
  app.post('/api/salesmen', async (req) => books.createSalesman(req.body as Record<string, unknown>));
  app.put('/api/salesmen/:id', async (req) => books.updateSalesman(Number((req.params as Q).id), req.body as Record<string, unknown>));
  app.delete('/api/salesmen/:id', async (req) => books.deleteSalesman(Number((req.params as Q).id)));
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
  app.get('/api/items/:id', async (req) => {
    const id = Number((req.params as Q).id);
    const item = books.item(id);
    return {
      ...item,
      rates: books.db.prepare(`SELECT from_date, gst_rate FROM item_gst_rates WHERE item_id=? ORDER BY from_date`).all(id),
      prices: Object.fromEntries((books.db.prepare(`SELECT level, rate FROM price_list WHERE item_id=?`).all(id) as { level: string; rate: number }[]).map((p) => [p.level, p.rate])),
    };
  });
  app.post('/api/items', async (req) => books.createItem(req.body as never));
  app.put('/api/items/:id', async (req) => books.updateItem(Number((req.params as Q).id), req.body as never));
  app.get('/api/items/:id/batches', async (req) => {
    const q = req.query as Q;
    return books.batches(Number((req.params as Q).id), q.asOf, 0, q.godownId ? Number(q.godownId) : null);
  });
  app.post('/api/items/gst-rate', async (req) => books.changeGstRate(req.body as never));
  app.delete('/api/items/:id/gst-rate', async (req) => books.removeGstRate(Number((req.params as Q).id), String((req.query as Q).from ?? '')));
  app.put('/api/items/:id/prices', async (req) => books.setPrices(Number((req.params as Q).id), (req.body ?? {}) as Record<string, unknown>));
  app.get('/api/godowns', async () => books.godowns());
  app.post('/api/godowns', async (req) => books.createGodown((req.body as { name?: string } | null)?.name ?? ''));
  app.put('/api/godowns/:id', async (req) => books.renameGodown(Number((req.params as Q).id), (req.body as { name?: string } | null)?.name ?? ''));
  /** Alt+S stock query: stock by godown and batch, and the last rates, for one item. */
  app.get('/api/items/:id/query', async (req) => {
    const id = Number((req.params as Q).id);
    const item = books.item(id);
    const on = (req.query as Q).asOf || todayISO();
    const godowns = books.godowns().map((g) => ({ ...g, qty: books.stockOf(id, on, 0, g.id) })).filter((g) => g.qty !== 0 || g.id === 1);
    const lastRate = (type: string) => books.db.prepare(`SELECT v.date, v.number, p.name AS party, iv.rate FROM inventory iv JOIN vouchers v ON v.id=iv.voucher_id
      LEFT JOIN ledgers p ON p.id=v.party_id WHERE iv.item_id=? AND v.type=? AND v.cancelled=0 AND v.optional=0 ORDER BY v.date DESC, v.id DESC LIMIT 5`).all(id, type);
    return { item, rate: books.rateOn(item, on), stock: books.stockOf(id, on), godowns, batches: books.batches(id, on).filter((b) => b.qty !== 0), purchases: lastRate('purchase'), sales: lastRate('sales') };
  });

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
  app.delete('/api/vouchers/:id', async (req) => books.deleteVoucher(Number((req.params as Q).id)));
  app.post('/api/vouchers/:id/cancel', async (req) => books.cancelVoucher(Number((req.params as Q).id)));
  app.post('/api/vouchers/:id/bounce', async (req) => books.bounceCheque(Number((req.params as Q).id), (req.body ?? {}) as never));
  app.put('/api/vouchers/:id/bank-date', async (req) => books.setBankDate(Number((req.params as Q).id), (req.body as { date?: string } | null)?.date ?? null));
  /** Page Up / Page Down in a voucher: the previous or next voucher of the same type. */
  app.get('/api/vouchers/:id/neighbour', async (req) => {
    const id = Number((req.params as Q).id);
    const q = req.query as Q;
    const next = q.dir === 'next';
    if (!id) {
      const last = books.db.prepare(`SELECT id, type FROM vouchers WHERE type=? ORDER BY date DESC, id DESC LIMIT 1`).get(q.type ?? '');
      return last ?? null;
    }
    const v = books.db.prepare(`SELECT id, type, date FROM vouchers WHERE id=?`).get(id) as { id: number; type: string; date: string } | undefined;
    if (!v) throw new BooksError('Voucher not found.');
    return books.db.prepare(`SELECT id, type FROM vouchers WHERE type=? AND ${next ? '(date>? OR (date=? AND id>?))' : '(date<? OR (date=? AND id<?))'}
      ORDER BY date ${next ? 'ASC' : 'DESC'}, id ${next ? 'ASC' : 'DESC'} LIMIT 1`).get(v.type, v.date, v.date, v.id) ?? null;
  });
  /** Ctrl+R / Alt+R: the narration of the last voucher of this type (and party, with Alt+R). */
  app.get('/api/vouchers/last-narration', async (req) => {
    const q = req.query as Q;
    const row = books.db.prepare(`SELECT narration FROM vouchers WHERE type=? AND narration<>'' ${q.partyId ? 'AND party_id=?' : ''} ORDER BY id DESC LIMIT 1`)
      .get(...[q.type ?? '', ...(q.partyId ? [Number(q.partyId)] : [])]) as { narration: string } | undefined;
    return { narration: row?.narration ?? '' };
  });
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
    return R.dayBook(books, q.from || to, to, text(q.salesman));
  });
  app.get('/api/reports/stock-summary', async (req) => {
    const q = req.query as Q;
    return R.stockSummary(books, asOf(q), q.from);
  });
  app.get('/api/reports/outstanding', async (req) => {
    const q = req.query as Q;
    const bills = books.pendingBills({ asOf: asOf(q), ledgerId: num(q.ledgerId) });
    const kind = q.kind ?? 'receivable';
    const sm = text(q.salesman)?.toLowerCase();
    return bills.filter((b) => (kind === 'receivable' ? b.pending > 0 : b.pending < 0) && (!sm || (b.salesman || '').toLowerCase() === sm));
  });
  app.get('/api/reports/pending-bills/:ledgerId', async (req) => books.pendingBills({ ledgerId: Number((req.params as Q).ledgerId), asOf: (req.query as Q).asOf || undefined }));
  app.get('/api/reports/alerts', async (req) => R.alerts(books, asOf(req.query as Q)));
  const range = (q: Q) => {
    const to = asOf(q);
    return { from: q.from || maxDate(financialYear(to).start, books.company().books_from), to };
  };
  app.get('/api/reports/register', async (req) => { const q = req.query as Q; const r = range(q); return R.register(books, q.type || 'sales', r.from, r.to, text(q.salesman)); });
  app.get('/api/reports/sales-by', async (req) => { const q = req.query as Q; const r = range(q); return R.salesBy(books, q.by || 'party', r.from, r.to, {
      salesman: text(q.salesman), beat: text(q.beat), partyId: num(q.partyId), itemId: num(q.itemId), stockGroupId: num(q.stockGroupId),
    });
  });
  app.get('/api/reports/godown-stock', async (req) => R.godownStock(books, asOf(req.query as Q)));
  app.get('/api/reports/scheme-claims', async (req) => { const r = range(req.query as Q); return R.schemeClaims(books, r.from, r.to); });
  app.get('/api/reports/brs/:ledgerId', async (req) => R.bankReconciliation(books, Number((req.params as Q).ledgerId), asOf(req.query as Q)));
  app.get('/api/reports/pdc', async (req) => R.pdcRegister(books, asOf(req.query as Q)));
  app.get('/api/reports/pending-orders', async (req) => R.pendingOrders(books, (req.query as Q).kind === 'purchase' ? 'purchase' : 'sales'));
  app.get('/api/reports/tds', async (req) => { const r = range(req.query as Q); return R.tdsRegister(books, r.from, r.to); });
  app.get('/api/reports/reminder/:ledgerId', async (req) => reminderMessage(books, Number((req.params as Q).ledgerId)));

  // ----- GST -----
  app.get('/api/gst/gstr1', async (req) => {
    const q = req.query as Q;
    return gstr1(books, q.period || todayISO().slice(0, 7), { toPeriod: q.toPeriod || undefined, iff: q.iff === '1' });
  });
  app.get('/api/gst/gstr3b', async (req) => { const q = req.query as Q; return gstr3b(books, q.period || todayISO().slice(0, 7), q.toPeriod || undefined); });
  app.post('/api/gst/gstr2b', { bodyLimit: 20 * 1024 * 1024 }, async (req) => {
    const b = (req.body ?? {}) as { json?: unknown; period?: string; toPeriod?: string };
    let data = b.json;
    if (typeof data === 'string') { try { data = JSON.parse(data); } catch { throw new BooksError('The GSTR-2B file is not valid JSON.'); } }
    const { from, to } = periodRange(b.period || todayISO().slice(0, 7), b.toPeriod || undefined);
    return gstr2bMatch(books, data, from, to);
  });
  app.get('/api/gst/eway-candidates', async (req) => {
    const q = req.query as Q;
    const to = asOf(q);
    return ewayCandidates(books, q.from || to, to, q.all === '1');
  });
  app.post('/api/gst/eway-json', async (req) => ewayBillJson(books, Array.isArray((req.body as { ids?: unknown })?.ids) ? (req.body as { ids: number[] }).ids : (() => { throw new BooksError('Choose the bills for the e-Way Bill.'); })()));

  // ----- utilities -----
  app.post('/api/import/tally', { bodyLimit: 30 * 1024 * 1024 }, async (req) => {
    const body = (req.body ?? {}) as { xml?: string; url?: string };
    if (body.xml !== undefined && typeof body.xml !== 'string') throw new BooksError('The Tally file could not be read.');
    const xml = body.xml ?? (await fetchTallyMasters(body.url || 'http://localhost:9000'));
    return importTallyMasters(books, parseTallyMasters(xml));
  });
  app.post('/api/backup', async () => {
    if (!books.company().backup_dir && !opts.defaultBackupDir) throw new BooksError('Choose a backup folder in Company settings first.');
    const r = await backupAll(books, opts.defaultBackupDir ?? '');
    if (!r.local && !r.cloud) throw new BooksError(r.errors.join(' '));
    return r;
  });
  // Folders on this (main) PC that a cloud drive keeps in step with the internet, e.g. Google Drive for desktop.
  app.get('/api/backup/cloud-folders', async () => cloudFolders());
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

/** Folders a cloud drive app keeps in step with the internet on this PC (Google Drive first: it is free up to 15 GB). */
export function cloudFolders(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }) {
  const found: { name: string; path: string }[] = [];
  const add = (name: string, p: string | undefined) => { if (p && exists(p) && !found.some((f) => f.path === p)) found.push({ name, path: path.join(p, 'Stockwell Backups') }); };
  if (process.platform === 'win32' || env.STOCKWELL_TEST_CLOUD) {
    for (const d of 'DEFGHIJKLMNOPQRSTUVWXYZ') add('Google Drive', `${d}:\\My Drive`);
  }
  const home = env.USERPROFILE || env.HOME;
  if (home) { add('Google Drive', path.join(home, 'Google Drive')); add('Google Drive', path.join(home, 'My Drive')); }
  add('OneDrive', env.OneDrive);
  if (home) add('Dropbox', path.join(home, 'Dropbox'));
  return found;
}

/** Backs up to the backup folder (or Documents) and to the cloud folder, if one is set. One failing does not stop the other.
 *  When each last worked, and what went wrong, is kept in the company record so every PC can show it. */
export async function backupAll(books: Books, defaultDir: string) {
  const c = books.company();
  const errors: string[] = [];
  const now = new Date().toISOString();
  let local: string | null = null;
  let cloud: string | null = null;
  const localDir = c.backup_dir || defaultDir;
  try { if (localDir) local = (await backup(books, localDir)).file; } catch (e) {
    errors.push((e as Error).message);
    // A pen drive that is not plugged in should not stop the copy: fall back to Documents.
    if (defaultDir && localDir !== defaultDir) { try { local = (await backup(books, defaultDir)).file; } catch (e2) { errors.push((e2 as Error).message); } }
  }
  if (c.cloud_backup_dir && path.resolve(c.cloud_backup_dir) !== path.resolve(localDir || '.')) {
    try { cloud = (await backup(books, c.cloud_backup_dir)).file; } catch (e) { errors.push(`Cloud folder: ${(e as Error).message}`); }
  }
  books.db.prepare(`UPDATE company SET last_backup=CASE WHEN @local THEN @now ELSE last_backup END,
    last_cloud_backup=CASE WHEN @cloud THEN @now ELSE last_cloud_backup END, backup_error=@err WHERE id=1`)
    .run({ local: local ? 1 : 0, cloud: cloud ? 1 : 0, now, err: errors.join(' ').slice(0, 500) });
  return { local, cloud, errors };
}

/** Whether the automatic backup is due: every few hours as set (or once a day), counted from the last good copy. */
export function backupDue(books: Books, now = new Date()): boolean {
  const c = books.company();
  if (!c.last_backup) return true;
  const last = new Date(c.last_backup);
  if (Number.isNaN(last.getTime())) return true;
  const hours = Number(c.backup_every_hours) || 24; // 0 = once a day
  // A missed cloud copy is tried again on the next round too.
  const cloudBehind = !!c.cloud_backup_dir && (!c.last_cloud_backup || c.last_cloud_backup < c.last_backup);
  return now.getTime() - last.getTime() >= hours * 3600_000 || (cloudBehind && now.getTime() - last.getTime() >= 15 * 60_000);
}

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

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
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
}

type Q = Record<string, string | undefined>;

export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; books: Books; users: Users }> {
  const db = openDb(opts.dbPath);
  const books = new Books(db);
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 50 * 1024 * 1024 });

  app.setErrorHandler((err, _req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (err instanceof BooksError) return reply.status(400).send({ error: err.message });
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.status(400).send({ error: 'That name is already used.' });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.status(500).send({ error: e.message || 'Something went wrong.' });
  });

  app.addHook('onClose', async () => db.close());
  const users = installAuth(app, books);

  const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));
  const asOf = (q: Q) => q.to || q.asOf || todayISO();

  // ----- reference data -----
  app.get('/api/meta', async () => ({
    states: STATES, gstRates: GST_RATES, voucherTypes: VOUCHER_TYPES, today: todayISO(), version: '0.1.0',
  }));
  app.get('/api/company', async () => ({ ...books.company(), fy: financialYear(todayISO()) }));
  app.put('/api/company', async (req) => books.updateCompany(req.body as Record<string, never>));

  // ----- accounting masters -----
  app.get('/api/groups', async () => books.groups());
  app.post('/api/groups', async (req) => books.createGroup(req.body as { name: string; parentId: number }));
  app.get('/api/ledgers', async () => {
    const balances = new Map(R.ledgerBalances(books, todayISO()).map((b) => [b.id, b.balance]));
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
    const { ewbNo } = req.body as { ewbNo: string };
    books.db.prepare(`UPDATE vouchers SET ewb_no=? WHERE id=?`).run(String(ewbNo ?? '').trim(), id);
    return books.voucher(id);
  });
  app.get('/api/vouchers/:id/print', async (req, reply) => {
    reply.type('text/html; charset=utf-8');
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
  app.get('/api/reports/pending-bills/:ledgerId', async (req) => books.pendingBills({ ledgerId: Number((req.params as Q).ledgerId) }));
  app.get('/api/reports/alerts', async (req) => R.alerts(books, asOf(req.query as Q)));
  app.get('/api/reports/reminder/:ledgerId', async (req) => reminderMessage(books, Number((req.params as Q).ledgerId)));

  // ----- GST -----
  app.get('/api/gst/gstr1', async (req) => gstr1(books, (req.query as Q).period || todayISO().slice(0, 7)));
  app.get('/api/gst/gstr3b', async (req) => gstr3b(books, (req.query as Q).period || todayISO().slice(0, 7)));
  app.get('/api/gst/eway-candidates', async (req) => {
    const q = req.query as Q;
    const to = asOf(q);
    return ewayCandidates(books, q.from || to, to);
  });
  app.post('/api/gst/eway-json', async (req) => ewayBillJson(books, (req.body as { ids: number[] }).ids ?? []));

  // ----- utilities -----
  app.post('/api/import/tally', async (req) => {
    const body = req.body as { xml?: string; url?: string };
    const xml = body.xml ?? (await fetchTallyMasters(body.url || 'http://localhost:9000'));
    return importTallyMasters(books, parseTallyMasters(xml));
  });
  app.post('/api/backup', async (req) => {
    const dir = (req.body as { dir?: string })?.dir || books.company().backup_dir;
    if (!dir) throw new BooksError('Choose a backup folder in Company settings first.');
    return backup(books, dir);
  });
  app.get('/api/audit', async () => books.auditLog());

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
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `stockwell-${stamp}.db`);
  await books.db.backup(file);
  const old = fs.readdirSync(dir).filter((f) => /^stockwell-.*\.db$/.test(f)).sort();
  for (const f of old.slice(0, Math.max(0, old.length - 30))) fs.unlinkSync(path.join(dir, f));
  return { file };
}

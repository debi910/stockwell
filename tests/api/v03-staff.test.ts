// v0.3: what the firm's accounts staff asked for first. Opening stock date, ledger date, salesmen with
// salesman/area/item/month analysis, automatic local + cloud backup, and four PCs working at once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedDistributor, setup } from './helpers';
import { backupAll, backupDue, cloudFolders } from '../../src/server/app';
import { todayISO } from '../../src/core/dates';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;
const post = (body: Record<string, unknown>) => ctx.call('POST', '/api/vouchers', body);
const stockOn = async (name: string, asOf: string) =>
  (await ctx.call<any[]>('GET', `/api/reports/stock-summary?asOf=${asOf}`)).find((s) => s.name === name).closing_qty;
const sale = (partyId: number, date: string, qty: number, extra: Record<string, unknown> = {}) =>
  post({ type: 'sales', date, partyId, lines: [{ itemId: m.ghee.id, qty, rate: 60000, freeQty: 0 }], ...extra });

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
});

describe('opening stock with its own "as on" date', () => {
  beforeEach(async () => {
    await ctx.call('PUT', `/api/items/${m.ghee.id}`, { opening_qty: 20, opening_value: 20 * 50000, opening_date: '2026-10-15' });
  });

  it('counts the opening stock only from its date', async () => {
    expect(await stockOn('Patanjali Cow Ghee 1L', '2026-10-14')).toBe(0);
    expect(await stockOn('Patanjali Cow Ghee 1L', '2026-10-15')).toBe(20);
    await expect(sale(m.ramesh.id, '2026-10-10', 5)).rejects.toThrow(/Not enough stock/);
    await sale(m.ramesh.id, '2026-10-16', 5);
    expect(await stockOn('Patanjali Cow Ghee 1L', '2026-10-31')).toBe(15);
    // In October's Stock Summary the opening stock comes in during the month.
    const oct = (await ctx.call<any[]>('GET', '/api/reports/stock-summary?from=2026-10-01&asOf=2026-10-31')).find((s) => s.name === 'Patanjali Cow Ghee 1L');
    expect(oct).toMatchObject({ opening_qty: 0, inward: 20, outward: 5, closing_qty: 15 });
    const nov = (await ctx.call<any[]>('GET', '/api/reports/stock-summary?from=2026-11-01&asOf=2026-11-30')).find((s) => s.name === 'Patanjali Cow Ghee 1L');
    expect(nov).toMatchObject({ opening_qty: 15, inward: 0 });
  });

  it('refuses a later opening date when goods were already sold before it', async () => {
    await sale(m.ramesh.id, '2026-10-16', 5);
    await expect(ctx.call('PUT', `/api/items/${m.ghee.id}`, { opening_date: '2026-10-20' })).rejects.toThrow(/below zero/);
    await expect(ctx.call('PUT', `/api/items/${m.ghee.id}`, { opening_date: '2026-03-01' })).rejects.toThrow(/before the books start/);
    await expect(ctx.call('PUT', `/api/items/${m.ghee.id}`, { opening_date: '31-31-26' })).rejects.toThrow();
    // Blank (or the books start) means "from the start".
    const it = await ctx.call('PUT', `/api/items/${m.ghee.id}`, { opening_date: '' });
    expect(it.opening_date).toBeNull();
    expect(await stockOn('Patanjali Cow Ghee 1L', '2026-05-01')).toBe(20);
  });

  it('keeps profit right and the Balance Sheet and Trial Balance balanced around the date', async () => {
    await sale(m.ramesh.id, '2026-10-16', 5);
    const before = await ctx.call('GET', '/api/reports/balance-sheet?asOf=2026-09-30');
    expect(before.totalAssets).toBe(before.totalLiabilities);
    expect(before.closingStock).toBe(0);
    const after = await ctx.call('GET', '/api/reports/balance-sheet?asOf=2026-10-31');
    expect(after.totalAssets).toBe(after.totalLiabilities);
    expect(after.closingStock).toBe(15 * 50000);
    // Sold 5 bought at ₹500 for ₹600: gross profit ₹500 whichever period holds the opening date.
    const pl = await ctx.call('GET', '/api/reports/profit-loss?from=2026-04-01&to=2026-10-31');
    expect(pl.openingStock).toBe(20 * 50000);
    expect(pl.grossProfit).toBe(5 * 10000);
    const plOct = await ctx.call('GET', '/api/reports/profit-loss?from=2026-10-01&to=2026-10-31');
    expect(plOct.grossProfit).toBe(5 * 10000);
    const plSep = await ctx.call('GET', '/api/reports/profit-loss?from=2026-04-01&to=2026-09-30');
    expect(plSep.grossProfit).toBe(0);
    const tb = await ctx.call('GET', '/api/reports/trial-balance?asOf=2026-10-31');
    // The opening stock has no capital entry here, so it shows as a difference in opening balances, as in Tally.
    expect(tb.openingDiff).toBe(20 * 50000);
    expect(tb.totalDr - tb.totalCr).toBe(tb.openingDiff);
    const tbSep = await ctx.call('GET', '/api/reports/trial-balance?asOf=2026-09-30');
    expect(tbSep.openingDiff).toBe(0);
    expect(tbSep.totalDr).toBe(tbSep.totalCr);
  });
});

describe('ledger date', () => {
  it('dates a new ledger today unless a date is given, and keeps it on alteration', async () => {
    const a = await ctx.call('POST', '/api/ledgers', { name: 'Behera Stores', group_id: m.g('Sundry Debtors') });
    expect(a.created_on).toBe(todayISO());
    const b = await ctx.call('POST', '/api/ledgers', { name: 'Nayak Kirana', group_id: m.g('Sundry Debtors'), created_on: '2026-06-01' });
    expect(b.created_on).toBe('2026-06-01');
    const b2 = await ctx.call('PUT', `/api/ledgers/${b.id}`, { phone: '9437011111', created_on: '' });
    expect(b2.created_on).toBe('2026-06-01');
    await expect(ctx.call('PUT', `/api/ledgers/${b.id}`, { created_on: '2026-02-30' })).rejects.toThrow(/ledger date/i);
    const list = await ctx.call<any[]>('GET', '/api/ledgers');
    expect(list.find((l) => l.id === b.id).created_on).toBe('2026-06-01');
  });
});

describe('salesmen', () => {
  let rinku: any;
  beforeEach(async () => {
    await post({ type: 'purchase', date: '2026-10-01', partyId: m.supplier.id, refNo: 'P1', lines: [{ itemId: m.ghee.id, qty: 200, rate: 50000 }] });
    rinku = await ctx.call('POST', '/api/salesmen', { name: 'Rinku Das', phone: '94370 22222', area: 'Saheed Nagar' });
    await ctx.call('PUT', `/api/ledgers/${m.ramesh.id}`, { salesman: 'rinku das', beat: 'Saheed Nagar' });
    await ctx.call('PUT', `/api/ledgers/${m.kalpana.id}`, { salesman: 'Sonu', beat: 'Old Town' }); // a new name joins the list
  });

  it('keeps one list of names, adds new ones from the ledger and refuses duplicates', async () => {
    const list = await ctx.call<any[]>('GET', '/api/salesmen');
    expect(list.map((s) => s.name).sort()).toEqual(['Rinku Das', 'Sonu']);
    expect((await ctx.call('GET', `/api/ledgers/${m.ramesh.id}`)).salesman).toBe('Rinku Das');
    await expect(ctx.call('POST', '/api/salesmen', { name: 'RINKU DAS' })).rejects.toThrow(/already exists/);
    await expect(ctx.call('POST', '/api/salesmen', { name: '  ' })).rejects.toThrow(/required/);
    expect(rinku.phone).toBe('9437022222');
  });

  it('puts the party\'s salesman on a bill unless another is chosen, and refuses unknown names', async () => {
    const a = await sale(m.ramesh.id, '2026-10-05', 2);
    expect(a.salesman).toBe('Rinku Das');
    const b = await sale(m.ramesh.id, '2026-10-05', 1, { salesman: 'sonu' });
    expect(b.salesman).toBe('Sonu');
    const c = await sale(m.kolkata.id, '2026-10-05', 1);
    expect(c.salesman).toBe('');
    await expect(sale(m.ramesh.id, '2026-10-05', 1, { salesman: 'Nobody' })).rejects.toThrow(/no salesman "Nobody"/);
    // An alteration that does not mention the salesman keeps the one on the bill.
    const b2 = await ctx.call('PUT', `/api/vouchers/${b.id}`, { type: 'sales', date: '2026-10-05', partyId: m.ramesh.id, lines: [{ itemId: m.ghee.id, qty: 3, rate: 60000, freeQty: 0 }] });
    expect(b2.salesman).toBe('Sonu');
  });

  it('carries a new name to parties and old bills, and will not delete a name in use', async () => {
    const a = await sale(m.ramesh.id, '2026-10-05', 2);
    await ctx.call('PUT', `/api/salesmen/${rinku.id}`, { name: 'Rinku Kumar Das' });
    expect((await ctx.call('GET', `/api/vouchers/${a.id}`)).salesman).toBe('Rinku Kumar Das');
    expect((await ctx.call('GET', `/api/ledgers/${m.ramesh.id}`)).salesman).toBe('Rinku Kumar Das');
    await expect(ctx.call('DELETE', `/api/salesmen/${rinku.id}`)).rejects.toThrow(/not active instead/);
    const spare = await ctx.call('POST', '/api/salesmen', { name: 'Spare' });
    await ctx.call('DELETE', `/api/salesmen/${spare.id}`);
    expect((await ctx.call<any[]>('GET', '/api/salesmen')).some((s) => s.name === 'Spare')).toBe(false);
  });

  it('analyses sales by salesman, area, item and month, with filters, collections and dues', async () => {
    const s1 = await sale(m.ramesh.id, '2026-10-05', 10); // Rinku, Saheed Nagar, Oct
    await sale(m.ramesh.id, '2026-11-05', 5); // Rinku, Nov
    await sale(m.kalpana.id, '2026-11-06', 4); // Sonu, Old Town
    await post({ type: 'sales', date: '2026-11-07', partyId: m.kalpana.id, salesman: 'Sonu', lines: [{ itemId: m.curd.id, qty: 0, rate: 4500 }] }).catch(() => {});
    await post({ type: 'receipt', date: '2026-10-20', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: s1.total, bills: [{ ref: s1.number, amount: s1.total }] }] });
    const q = (s: string) => ctx.call('GET', `/api/reports/sales-by?from=2026-04-01&to=2026-11-30&${s}`);

    const bySm = await q('by=salesman');
    const r = bySm.rows.find((x: any) => x.name === 'Rinku Das');
    expect(r).toMatchObject({ value: 15 * 60000, bills: 2, collected: s1.total });
    expect(r.outstanding).toBe(Math.round(15 * 60000 * 1.12) - s1.total);
    expect(bySm.rows.find((x: any) => x.name === 'Sonu').value).toBe(4 * 60000);
    expect(bySm.totals.value).toBe(19 * 60000);

    const months = await q('by=month&salesman=Rinku%20Das');
    expect(months.rows.map((x: any) => [x.name, x.value])).toEqual([['2026-10', 10 * 60000], ['2026-11', 5 * 60000]]);

    const byArea = await q('by=beat');
    expect(byArea.rows.find((x: any) => x.name === 'Old Town').value).toBe(4 * 60000);

    const items = await q(`by=item&salesman=Sonu`);
    expect(items.rows).toHaveLength(1);
    expect(items.rows[0]).toMatchObject({ name: 'Patanjali Cow Ghee 1L', qty: 4 });

    const oneItemBySm = await q(`by=salesman&itemId=${m.ghee.id}`);
    expect(oneItemBySm.itemLevel).toBe(true);
    expect(oneItemBySm.rows.find((x: any) => x.name === 'Rinku Das').qty).toBe(15);

    const dayBook = await ctx.call<any[]>('GET', '/api/reports/day-book?from=2026-04-01&to=2026-11-30&salesman=Sonu');
    expect(dayBook.every((v) => v.salesman === 'Sonu')).toBe(true);
    expect(dayBook.length).toBeGreaterThan(0);
    const reg = await ctx.call('GET', '/api/reports/register?type=sales&from=2026-04-01&to=2026-11-30&salesman=Rinku%20Das');
    expect(reg.totals.count).toBe(2);
    const out = await ctx.call<any[]>('GET', '/api/reports/outstanding?kind=receivable&asOf=2026-11-30&salesman=Sonu');
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((b) => b.salesman === 'Sonu')).toBe(true);
    await expect(q('by=salesman&itemId=abc')).rejects.toThrow(/not found/);
  });

  it('lets an operator add a salesman but not alter one', async () => {
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const owner = (await ctx.call('POST', '/api/login', { name: 'Papa', password: 'secret1' })).token;
    const as = (t: string, method: string, url: string, payload?: unknown) => ctx.app.inject({ method: method as never, url, payload: payload as never, headers: { 'x-stockwell-token': t } });
    await as(owner, 'POST', '/api/users', { name: 'Mitu', role: 'operator', password: 'bill1234' });
    const op = JSON.parse((await as(owner, 'POST', '/api/login', { name: 'Mitu', password: 'bill1234' })).body).token;
    expect((await as(op, 'POST', '/api/salesmen', { name: 'Biju' })).statusCode).toBe(200);
    expect((await as(op, 'PUT', `/api/salesmen/${rinku.id}`, { name: 'X' })).statusCode).toBe(403);
    expect((await as(op, 'DELETE', `/api/salesmen/${rinku.id}`)).statusCode).toBe(403);
  });
});

describe('automatic backup to a local and a cloud folder', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-bk-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('copies to both folders, records when, and keeps going when one fails', async () => {
    const local = path.join(dir, 'local');
    const cloud = path.join(dir, 'My Drive', 'Stockwell Backups');
    await ctx.call('PUT', '/api/company', { backup_dir: local, cloud_backup_dir: cloud, backup_every_hours: 2 });
    expect(backupDue(ctx.books)).toBe(true);
    const r = await backupAll(ctx.books, path.join(dir, 'default'));
    expect(r.errors).toEqual([]);
    expect(fs.readdirSync(local).filter((f) => f.endsWith('.db'))).toHaveLength(1);
    expect(fs.readdirSync(cloud).filter((f) => f.endsWith('.db'))).toHaveLength(1);
    const c = ctx.books.company();
    expect(c.last_backup).not.toBe('');
    expect(c.last_cloud_backup).toBe(c.last_backup);
    expect(backupDue(ctx.books)).toBe(false);
    expect(backupDue(ctx.books, new Date(Date.now() + 2 * 3600_000 + 1000))).toBe(true);

    // The cloud folder cannot be made (a file is in the way): the local copy is still made, and the problem is kept.
    fs.mkdirSync(path.join(dir, 'blocked'));
    fs.writeFileSync(path.join(dir, 'blocked', 'x'), '');
    await ctx.call('PUT', '/api/company', { cloud_backup_dir: path.join(dir, 'blocked', 'x', 'y') });
    const r2 = await backupAll(ctx.books, path.join(dir, 'default'));
    expect(r2.local).toBeTruthy();
    expect(r2.cloud).toBeNull();
    expect(ctx.books.company().backup_error).toMatch(/Cloud folder/);
    const alerts = await ctx.call('GET', '/api/reports/alerts');
    expect(alerts.backup.error).toMatch(/Cloud folder/);
  });

  it('checks the settings and never lets the backup times be typed in', async () => {
    await expect(ctx.call('PUT', '/api/company', { backup_every_hours: 3 })).rejects.toThrow(/1, 2, 4, 8 or 12/);
    await ctx.call('PUT', '/api/company', { last_backup: '2030-01-01T00:00:00Z', backup_every_hours: 0 });
    expect(ctx.books.company().last_backup).toBe('');
    expect(ctx.books.company().backup_every_hours).toBe(0);
    const post = await ctx.app.inject({ method: 'POST', url: '/api/backup' });
    expect(post.statusCode).toBe(400); // no folder at all in a test server
  });

  it('finds a Google Drive folder on the PC', () => {
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'My Drive'), { recursive: true });
    const found = cloudFolders({ HOME: home, USERPROFILE: home });
    expect(found).toEqual([{ name: 'Google Drive', path: path.join(home, 'My Drive', 'Stockwell Backups') }]);
  });
});

describe('four PCs at once', () => {
  it('saves bills from four PCs at the same moment with no repeated or missing numbers, and counts the PCs', async () => {
    const today = todayISO();
    await post({ type: 'purchase', date: today, partyId: m.supplier.id, refNo: 'P4', lines: [{ itemId: m.ghee.id, qty: 100, rate: 50000 }] });
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const pcs = ['127.0.0.1', '192.168.1.21', '192.168.1.22', '192.168.1.23'];
    const login = async (ip: string, name: string, pass: string) =>
      JSON.parse((await ctx.app.inject({ method: 'POST', url: '/api/login', payload: { name, password: pass }, remoteAddress: ip })).body).token as string;
    const owner = await login(pcs[0], 'Papa', 'secret1');
    for (const n of ['Rinku', 'Sonu', 'Mitu']) {
      await ctx.app.inject({ method: 'POST', url: '/api/users', payload: { name: n, role: 'operator', password: 'bill1234' }, headers: { 'x-stockwell-token': owner } });
    }
    const tokens = [owner, await login(pcs[1], 'Rinku', 'bill1234'), await login(pcs[2], 'Sonu', 'bill1234'), await login(pcs[3], 'Mitu', 'bill1234')];
    const parties = [m.ramesh.id, m.kalpana.id, m.kolkata.id, m.ramesh.id];
    // 4 PCs × 30 bills of 1 = 120, but only 100 in stock: exactly 100 are saved and 20 refused.
    const results = await Promise.all(pcs.flatMap((ip, k) => Array.from({ length: 30 }, () => ctx.app.inject({
      method: 'POST', url: '/api/vouchers', remoteAddress: ip, headers: { 'x-stockwell-token': tokens[k] },
      payload: { type: 'sales', date: today, partyId: parties[k], lines: [{ itemId: m.ghee.id, qty: 1, rate: 60000, freeQty: 0 }] },
    }))));
    const ok = results.filter((r) => r.statusCode === 200).map((r) => JSON.parse(r.body));
    const refused = results.filter((r) => r.statusCode !== 200);
    expect(ok).toHaveLength(100);
    expect(refused.every((r) => /Not enough stock/.test(JSON.parse(r.body).error))).toBe(true);
    const seqs = ok.map((v) => v.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(new Set(ok.map((v) => v.number)).size).toBe(100);
    expect(ctx.books.stockOf(m.ghee.id, today)).toBe(0);
    const sum = (ctx.books.db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM entries`).get() as { s: number }).s;
    expect(sum).toBe(0);

    for (const [k, ip] of pcs.entries()) await ctx.app.inject({ method: 'GET', url: '/api/changes', remoteAddress: ip, headers: { 'x-stockwell-token': tokens[k] } });
    const ch = JSON.parse((await ctx.app.inject({ method: 'GET', url: '/api/changes', headers: { 'x-stockwell-token': owner } })).body);
    expect(ch.pcs).toBe(4);
  });
});

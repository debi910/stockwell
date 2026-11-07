// The accounts staff's first requests, on the real screens: salesman master, ledger date and salesman,
// a bill that takes the party's salesman, salesman-wise analysis, opening stock date, backup settings.
// Needs the built screens: `npm run build:ui` (npm run test:e2e does it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { buildApp } from '../../src/server/app';
import { todayISO } from '../../src/core/dates';

let browser: Browser;
let page: Page;
let base: string;
let close: () => Promise<void>;
const m: Record<string, number> = {};

const field = (name: string) => page.locator(`[aria-label="${name}"]`).filter({ visible: true }).first();
const gateway = () => page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
async function pick(name: string, text: string) {
  await field(name).fill(text);
  await page.locator('.picker .opt.sel').filter({ hasText: new RegExp(text, 'i') }).first().waitFor();
  await page.keyboard.press('Enter');
}
const call = (url: string, body?: unknown, method = 'POST') =>
  fetch(base + url, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const today = todayISO();

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-staff-'));
  const { app } = await buildApp({ dbPath: path.join(dir, 'staff.db'), uiDir: path.resolve('dist/ui'), defaultBackupDir: path.join(dir, 'Backups') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  await call('/api/company', { name: 'Samal Distributors' }, 'PUT');
  const groups = await call('/api/groups');
  const gid = (n: string) => groups.find((g: any) => g.name === n).id;
  const units = await call('/api/units');
  m.supplier = (await call('/api/ledgers', { name: 'Odisha Agencies', group_id: gid('Sundry Creditors') })).id;
  m.atta = (await call('/api/items', { name: 'Chakki Atta 5kg', unit_id: units.find((u: any) => u.symbol === 'Pcs').id, hsn: '1101', gst_rate: 5, sale_rate: 30000, purchase_rate: 25000 })).id;
  await call('/api/vouchers', { type: 'purchase', date: today, partyId: m.supplier, refNo: 'OA/1', lines: [{ itemId: m.atta, qty: 50, rate: 25000 }] });
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(4000);
  page.on('pageerror', (e) => { throw e; });
  await page.goto(base);
  await gateway();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await close?.();
});

describe('what the accounts staff asked for', () => {
  it('creates a salesman from Create → Salesman', async () => {
    await page.keyboard.press('c');
    await page.getByRole('menu', { name: 'Create' }).waitFor();
    await page.keyboard.press('m');
    await field('Name').fill('Rinku Das');
    await field('Mobile').fill('9437022222');
    await page.keyboard.press('Control+a');
    await page.getByText('Salesman "Rinku Das" saved').waitFor();
    await page.keyboard.press('Escape');
    await gateway();
    expect((await call('/api/salesmen')).map((s: any) => s.name)).toEqual(['Rinku Das']);
  });

  it('gives a new party a date, an area and a salesman', async () => {
    await page.keyboard.press('c');
    await page.keyboard.press('l');
    await field('Name').fill('Behera Stores');
    await field('Name').press('Enter');
    await pick('Under', 'Sundry Debtors');
    expect(await field('Ledger date').inputValue()).toMatch(/-\d\d$/);
    await field('Ledger date').fill('1-6-26');
    await field('Area').fill('Saheed Nagar');
    await page.keyboard.press('Alt+c');
    await pick('Salesman', 'Rinku');
    await page.keyboard.press('Control+a');
    await page.getByText('Ledger "Behera Stores" saved').waitFor();
    const l = (await call('/api/ledgers')).find((x: any) => x.name === 'Behera Stores');
    expect(l).toMatchObject({ created_on: '2026-06-01', beat: 'Saheed Nagar', salesman: 'Rinku Das' });
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('fills the party\'s salesman on a sales bill', async () => {
    await page.keyboard.press('F8');
    await pick('Party', 'Behera');
    await expect.poll(() => field('Salesman').inputValue()).toBe('Rinku Das');
    await pick('Item 1', 'Atta');
    await field('Quantity 1').fill('4');
    await page.keyboard.press('Control+a');
    await page.getByText(/Sales S\/.* saved/).first().waitFor();
    await page.keyboard.press('Escape');
    await gateway();
    const day = await call(`/api/reports/day-book?from=${today}&to=${today}&salesman=Rinku%20Das`);
    expect(day.map((v: any) => v.type)).toEqual(['sales']);
  });

  it('shows salesman-wise sales and opens his parties with Enter', async () => {
    await page.keyboard.press('Alt+g');
    await field('Go To').fill('Salesman-wise');
    await page.keyboard.press('Enter');
    await page.getByRole('cell', { name: 'Rinku Das' }).waitFor();
    await page.getByRole('cell', { name: 'Rinku Das' }).click();
    await page.keyboard.press('Enter');
    await page.getByRole('cell', { name: 'Behera Stores' }).waitFor();
    expect(await page.locator('.titlebar').innerText()).toMatch(/Party · Salesman Rinku Das/);
    await page.keyboard.press('Escape'); // back to salesmen
    await page.getByRole('cell', { name: 'Rinku Das' }).waitFor();
    await page.keyboard.press('Alt+6'); // by month
    await page.getByRole('tab', { name: 'Month', selected: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('keeps an opening stock date on the item', async () => {
    await page.keyboard.press('Alt+g');
    await field('Go To').fill('Alter Stock Item');
    await page.keyboard.press('Enter');
    await page.getByRole('cell', { name: 'Chakki Atta 5kg' }).click();
    await expect.poll(() => field('Name').inputValue()).toBe('Chakki Atta 5kg');
    await field('Opening stock date').fill('1-10-26');
    await page.keyboard.press('Control+a');
    await page.getByText('Item "Chakki Atta 5kg" saved').waitFor();
    expect((await call(`/api/items/${m.atta}`)).opening_date).toBe('2026-10-01');
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('shows the backup settings and makes a backup', async () => {
    await page.keyboard.press('F3');
    await field('Back up every').waitFor();
    expect(await field('Back up every').inputValue()).toBe('4');
    await field('Back up every').selectOption('2');
    await page.keyboard.press('Control+a');
    await page.getByText('Company details saved').waitFor();
    expect((await call('/api/company')).backup_every_hours).toBe(2);
    await gateway();
    await page.keyboard.press('u');
    await page.getByRole('button', { name: 'Back up now (Ctrl+A)' }).click();
    await page.getByText('Backup done').waitFor();
    await page.keyboard.press('Escape');
    await gateway();
  });
});

// Two PCs on one set of books: the fixes from the four-staff office run, checked in a real browser.
// "Another PC" is a plain API call to the same server while this screen is open.
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
let m: Record<string, any> = {};

const field = (name: string) => page.locator(`[aria-label="${name}"]`).filter({ visible: true }).first();
const gateway = () => page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
const call = (url: string, body?: unknown, method = 'POST') =>
  fetch(base + url, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
const today = todayISO();
const receipt = (rupees: number) => call('/api/vouchers', { type: 'receipt', date: today, accountId: m.cash, entries: [{ ledgerId: m.panda, amount: rupees * 100 }] });

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-office-'));
  const { app } = await buildApp({ dbPath: path.join(dir, 'office.db'), uiDir: path.resolve('dist/ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  await call('/api/company', { name: 'Samal Distributors', backup_dir: path.join(dir, 'backup') }, 'PUT');
  const groups = await call('/api/groups');
  const gid = (n: string) => groups.find((g: any) => g.name === n).id;
  const units = await call('/api/units');
  m.panda = (await call('/api/ledgers', { name: 'Panda Tea Stall', group_id: gid('Sundry Debtors') })).id;
  m.supplier = (await call('/api/ledgers', { name: 'Odisha Agencies', group_id: gid('Sundry Creditors') })).id;
  m.cash = (await call('/api/ledgers')).find((l: any) => l.name === 'Cash').id;
  m.atta = (await call('/api/items', { name: 'Chakki Atta 5kg', unit_id: units.find((u: any) => u.symbol === 'Pcs').id, gst_rate: 5, sale_rate: 30000, purchase_rate: 33333 })).id;
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

describe('two PCs, one set of books', () => {
  it('shows a voucher saved on the other PC in an open Day Book, and Enter opens it', async () => {
    await page.keyboard.press('k');
    await page.getByText('No vouchers on these dates').waitFor();
    await receipt(500);
    await page.getByRole('cell', { name: 'Panda Tea Stall' }).waitFor({ timeout: 8000 });
    await page.keyboard.press('Enter');
    await page.locator('.vtype', { hasText: 'Receipt' }).waitFor();
    // Nothing changed, so Esc leaves without asking.
    await page.keyboard.press('Escape');
    await page.locator('.report table.r').waitFor();
    expect(await page.getByRole('alertdialog').count()).toBe(0);
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('moves the shown voucher number on when the other PC takes it', async () => {
    await page.keyboard.press('F6');
    const no = field('Voucher number');
    await expect.poll(() => no.inputValue()).toMatch(/\/2$/);
    await receipt(100);
    await expect.poll(() => no.inputValue(), { timeout: 8000 }).toMatch(/\/3$/);
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('works the round off out again when a purchase is altered', async () => {
    const p = await call('/api/vouchers', { type: 'purchase', date: today, partyId: m.supplier, refNo: 'OA/77', lines: [{ itemId: m.atta, qty: 3, rate: 33333 }] });
    expect(p.total % 100).toBe(0);
    expect(p.round_off).not.toBe(0);
    await page.keyboard.press('k');
    await page.getByRole('cell', { name: 'Odisha Agencies' }).click();
    await page.keyboard.press('Enter');
    await field('Quantity 1').waitFor();
    await field('Quantity 1').fill('4');
    await page.keyboard.press('Control+a');
    await page.locator('.report table.r').waitFor();
    const after = await call(`/api/vouchers/${p.id}`);
    expect(after.lines[0].qty).toBe(4);
    expect(after.total % 100).toBe(0);
    await page.keyboard.press('Escape');
    await gateway();
  });
});

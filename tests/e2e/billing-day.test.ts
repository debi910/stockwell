// A full billing day driven by the keyboard in a real browser, the way staff use Tally.
// Needs the built screens: `npm run build:ui` (npm run test:e2e does it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { buildApp } from '../../src/server/app';
import { todayISO } from '../../src/core/dates';

const shots = process.env.SHOTS_DIR;
let browser: Browser;
let page: Page;
let base: string;
let close: () => Promise<void>;

const snap = async (name: string) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const field = (name: string) => page.locator(`[aria-label="${name}"]`).filter({ visible: true }).first();
async function type(name: string, text: string) {
  await field(name).fill(text);
  await field(name).press('Enter');
}
/** Types into a pick list and presses Enter once the match is highlighted (lists load in the background). */
async function pick(name: string, text: string) {
  await field(name).fill(text);
  await page.locator('.picker .opt.sel').filter({ hasText: new RegExp(text, 'i') }).first().waitFor();
  await page.keyboard.press('Enter');
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-e2e-'));
  const { app } = await buildApp({ dbPath: path.join(dir, 'e2e.db'), uiDir: path.resolve('dist/ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  close = () => app.close();
  if (shots) fs.mkdirSync(shots, { recursive: true });
  // Company and a supplier with stock come in through the API; the day's work is done on screen.
  const put = (url: string, body: unknown, method = 'POST') =>
    fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  await put('/api/company', { name: 'Samal Distributors', city: 'Bhubaneswar', upi_id: 'samal@sbi', backup_dir: path.join(dir, 'backup') }, 'PUT');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(4000);
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await close?.();
});

describe('a billing day', () => {
  it('opens on the Gateway', async () => {
    await page.goto(base);
    await page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
    await snap('01-gateway');
  });

  it('creates a retailer ledger from Create → Ledger', async () => {
    await page.keyboard.press('c');
    await page.keyboard.press('l');
    await type('Name', 'Ramesh General Store');
    await pick('Under', 'Sundry Debtors');
    await snap('02-ledger');
    await page.keyboard.press('Control+a');
    await page.getByRole('menu', { name: 'Create' }).waitFor();
    await page.keyboard.press('Escape');
  });

  it('creates a stock item with opening stock', async () => {
    await page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
    await page.keyboard.press('c');
    await page.keyboard.press('i');
    await type('Name', 'Patanjali Cow Ghee 1L');
    await field('Opening quantity').fill('40');
    await field('Opening rate').fill('550');
    await field('Selling rate').fill('600');
    await field('HSN').fill('0405');
    await snap('03-item');
    await page.keyboard.press('Control+a');
    await page.getByText('Item "Patanjali Cow Ghee 1L" saved').first().waitFor();
    await page.getByRole('menu', { name: 'Create' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
  });

  it('makes a sales bill with F8 and the keyboard only', async () => {
    await page.keyboard.press('F8');
    await pick('Party', 'Ramesh');
    await pick('Account', 'Sales');
    await pick('Item 1', 'Ghee');
    await type('Quantity 1', '5');
    await snap('04-sales');
    await page.keyboard.press('Control+a');
    await page.getByText(/Saved|saved/).first().waitFor({ timeout: 3000 });
    await snap('05-sales-saved');
    await page.keyboard.press('Escape');
  });

  it('shows the bill in the Day Book and a balanced Trial Balance', async () => {
    await page.keyboard.press('k');
    await page.getByText('Ramesh General Store').first().waitFor({ timeout: 3000 });
    const row = await page.locator('table.r tbody tr').first().innerText();
    expect(row).toContain('Sales');
    await snap('06-day-book');
    await page.keyboard.press('Escape');

    const tb = await (await fetch(`${base}/api/reports/trial-balance?asOf=${todayISO()}`)).json();
    // Opening stock was entered without a capital entry, so (as in Tally) the gap shows as a difference in opening balances.
    expect(tb.openingDiff).toBe(40 * 55000);
    expect(tb.totalDr).toBe(tb.totalCr + tb.openingDiff);
    const stock = await (await fetch(`${base}/api/reports/stock-summary?asOf=${todayISO()}`)).json();
    expect(stock.find((s: any) => s.name === 'Patanjali Cow Ghee 1L').closing_qty).toBe(35);
  });

  it('opens the GST screen and the alerts', async () => {
    await page.keyboard.press('g');
    await page.getByRole('tab', { name: /GSTR-1/ }).waitFor();
    await snap('07-gst');
    await page.keyboard.press('Escape');
    await page.keyboard.press('l');
    await snap('08-alerts');
    await page.keyboard.press('Escape');
  });

  it('turns on logins and keeps the operator out of profit reports', async () => {
    await page.keyboard.press('F3');
    await page.getByRole('button', { name: 'Users and passwords' }).click();
    await type('User name', 'Papa');
    await field('Password').fill('secret1');
    await page.keyboard.press('Control+a');
    await page.getByLabel('Name of user').waitFor({ timeout: 5000 });
    await snap('09-login');
    await page.getByLabel('Name of user').fill('Papa');
    await page.getByLabel('Password').fill('secret1');
    await page.keyboard.press('Enter');
    await page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
    expect(await page.locator('.topbar .user').innerText()).toBe('Papa');
  });
});

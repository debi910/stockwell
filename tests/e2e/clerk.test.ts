// The counter clerk's keyboard flow: the fixes from the dairy/kirana test run, checked in a real browser.
// Needs the built screens: `npm run build:ui` (npm run test:e2e does it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { buildApp } from '../../src/server/app';

let browser: Browser;
let page: Page;
let base: string;
let close: () => Promise<void>;

const field = (name: string) => page.locator(`[aria-label="${name}"]`).filter({ visible: true }).first();
const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName);
const gateway = () => page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
async function pick(name: string, text: string) {
  await field(name).fill(text);
  await page.locator('.picker .opt.sel').filter({ hasText: new RegExp(text, 'i') }).first().waitFor();
  await page.keyboard.press('Enter');
}
const call = (url: string, body?: unknown, method = 'POST') =>
  fetch(base + url, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-clerk-'));
  const { app } = await buildApp({ dbPath: path.join(dir, 'clerk.db'), uiDir: path.resolve('dist/ui') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  await call('/api/company', { name: 'Puri Dairy', backup_dir: path.join(dir, 'backup') }, 'PUT');
  const groups = await call('/api/groups');
  const gid = (n: string) => groups.find((g: any) => g.name === n).id;
  await call('/api/ledgers', { name: 'Freight Paid', group_id: gid('Indirect Expenses') });
  await call('/api/ledgers', { name: 'Panda Tea Stall', group_id: gid('Sundry Debtors') });
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

describe('the clerk at the counter', () => {
  it('balances a journal like Tally: the second line goes Cr with the difference filled in', async () => {
    await page.keyboard.press('F7');
    await pick('Particulars 1', 'Freight');
    await field('Debit 1').fill('100');
    await field('Debit 1').press('Enter');
    expect(await field('Side 2').inputValue()).toBe('Cr');
    await pick('Particulars 2', 'Cash');
    expect(await field('Credit 2').inputValue()).toBe('100');
    await page.keyboard.press('Control+a');
    await page.getByText(/Journal J\/.* saved/).first().waitFor();
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('asks before Ctrl+Q throws away a filled voucher', async () => {
    await page.keyboard.press('F8');
    await pick('Party', 'Panda');
    await page.keyboard.press('Control+q');
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('alertdialog').waitFor(); await page.keyboard.press('y');
    await gateway();
  });

  it('asks before Esc throws away a filled ledger, and Enter on an empty address line moves on', async () => {
    await page.keyboard.press('c');
    await page.keyboard.press('l');
    await field('Name').fill('Sahu Kirana');
    await field('Name').press('Enter');
    await pick('Under', 'Sundry Debtors');
    await expect.poll(focused).toBe('Ledger date'); // Enter on Under moves on by itself; let it land first
    await field('Address').focus();
    await page.keyboard.type('Grand Road');
    await page.keyboard.press('Enter');
    expect(await focused()).toBe('Address');
    await page.keyboard.press('Enter');
    expect(await focused()).not.toBe('Address');
    expect(await field('Address').inputValue()).toBe('Grand Road');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('alertdialog').waitFor(); await page.keyboard.press('y');
    await page.getByRole('menu', { name: 'Create' }).waitFor();
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('asks before F9 switches a filled sales bill to a purchase', async () => {
    await page.keyboard.press('F8');
    await pick('Party', 'Panda');
    await page.keyboard.press('F9');
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('n');
    expect(await field('Party').inputValue()).toBe('Panda Tea Stall');
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor(); await page.keyboard.press('y');
    await gateway();
  });

  it('shows Cash in the Account box when a payment opens', async () => {
    await page.keyboard.press('F5');
    await page.waitForTimeout(300);
    expect(await field('Account').inputValue()).toBe('Cash');
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('puts the cursor back after the calculator closes', async () => {
    await page.keyboard.press('F8');
    await pick('Party', 'Panda');
    await page.waitForTimeout(200);
    const before = await focused();
    await page.keyboard.press('Control+n');
    await field('Calculation').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    expect(await focused()).toBe(before);
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor(); await page.keyboard.press('y');
    await gateway();
  });
});

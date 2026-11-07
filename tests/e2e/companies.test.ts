// Several companies on the real screens: pick one, switch with Alt+F3, bring a company in from Tally XML files,
// spot TallyPrime's own data folder, and export each company to its own folder.
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
let dir: string;
let close: () => Promise<void>;

const field = (name: string) => page.locator(`[aria-label="${name}"]`).filter({ visible: true }).first();
const gateway = () => page.getByRole('menu', { name: 'Gateway of Stockwell' }).waitFor();
const call = (url: string, body?: unknown, method = 'POST', company = '100000') =>
  fetch(base + url, { method: body === undefined ? 'GET' : method, headers: { 'Content-Type': 'application/json', 'x-stockwell-company': company }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());

const MASTERS = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA>
<TALLYMESSAGE><LEDGER NAME="Bhoi Telecom"><PARENT>Sundry Debtors</PARENT><OPENINGBALANCE>-5000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
<TALLYMESSAGE><LEDGER NAME="Capital A/c"><PARENT>Capital Account</PARENT><OPENINGBALANCE>5000.00</OPENINGBALANCE></LEDGER></TALLYMESSAGE>
</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
const DAYBOOK = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
<VOUCHER VCHTYPE="Receipt" ACTION="Create"><DATE>20260415</DATE><GUID>e2e-1</GUID><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>1</VOUCHERNUMBER>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bhoi Telecom</LEDGERNAME><AMOUNT>2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
 <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-2000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockwell-cos-'));
  const { app } = await buildApp({ dataDir: path.join(dir, 'data'), uiDir: path.resolve('dist/ui'), defaultBackupDir: path.join(dir, 'Backups'), exportDir: path.join(dir, 'Exports') });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  close = () => app.close();
  await call('/api/company', { name: 'Knopff Solutions', books_from: '2026-04-01' }, 'PUT');
  await call('/api/companies', { name: 'Cemech Paints', books_from: '2026-04-01' });
  fs.writeFileSync(path.join(dir, 'Master.xml'), MASTERS);
  // TallyPrime's "Unicode" export: UTF-16 with a byte order mark.
  fs.writeFileSync(path.join(dir, 'DayBook.xml'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DAYBOOK, 'utf16le')]));
  fs.mkdirSync(path.join(dir, 'tally-data'));
  for (const f of ['Company.1800', 'TranMgr.1800', 'TSTATE.TSF']) fs.writeFileSync(path.join(dir, 'tally-data', f), 'binary');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.setDefaultTimeout(4000);
  page.on('pageerror', (e) => { throw e; });
  await page.goto(base);
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('several companies on the screens', () => {
  it('asks which company to open, and opens it with Enter', async () => {
    await page.getByRole('heading', { name: 'Select company' }).waitFor();
    await page.getByRole('option', { name: /Knopff Solutions/ }).waitFor();
    await page.getByRole('listbox', { name: 'Companies' }).focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await gateway();
    expect(await page.locator('.topbar .company').innerText()).toBe('Cemech Paints');
  });

  it('remembers the company on this PC and switches with Alt+F3', async () => {
    await page.reload();
    await gateway();
    expect(await page.locator('.topbar .company').innerText()).toBe('Cemech Paints');
    await page.keyboard.press('Alt+F3');
    await page.getByRole('listbox', { name: 'Companies' }).waitFor();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await gateway();
    expect(await page.locator('.topbar .company').innerText()).toBe('Knopff Solutions');
  });

  it('makes a new company with Alt+C', async () => {
    await page.keyboard.press('Alt+F3');
    await page.getByRole('listbox', { name: 'Companies' }).waitFor();
    await page.keyboard.press('Alt+c');
    await field('Company name').fill('Uniq Oils');
    await page.keyboard.press('Control+a');
    await page.getByRole('option', { name: /Uniq Oils/ }).waitFor();
    expect(fs.existsSync(path.join(dir, 'data', 'Companies', '100002', 'stockwell.db'))).toBe(true);
    await page.keyboard.press('Escape');
    await gateway();
  });

  it('tells TallyPrime\'s own data folder apart from export files', async () => {
    await page.keyboard.press('i');
    await page.getByRole('heading', { name: 'Bring books across from TallyPrime' }).waitFor();
    await page.locator('[aria-label="Tally XML files"]').setInputFiles(fs.readdirSync(path.join(dir, 'tally-data')).map((f) => path.join(dir, 'tally-data', f)));
    await page.getByRole('alert').filter({ hasText: "This is TallyPrime's own data folder" }).waitFor();
  });

  it('brings a company in from Tally XML files', async () => {
    await page.locator('[aria-label="Tally XML files"]').setInputFiles([path.join(dir, 'Master.xml'), path.join(dir, 'DayBook.xml')]);
    await field('Company name 1').fill('Bhoi Telecom Books');
    await page.getByRole('button', { name: 'Import these files' }).click();
    await page.getByRole('button', { name: 'Open', exact: true }).waitFor({ timeout: 10000 });
    expect(await page.getByText(/Vouchers: 1 brought in/).count()).toBe(1);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await gateway();
    expect(await page.locator('.topbar .company').innerText()).toBe('Bhoi Telecom Books');
    const id = (await call('/api/companies/list')).companies.find((c: any) => c.name === 'Bhoi Telecom Books').id;
    const ledgers = await call('/api/ledgers', undefined, 'GET', id);
    expect(ledgers.find((l: any) => l.name === 'Cash').balance).toBe(200000);
  });

  it('exports every company into its own folder', async () => {
    await page.keyboard.press('x');
    await page.getByRole('heading', { name: 'Export to Tally XML' }).waitFor();
    await page.getByLabel('All companies').check();
    await page.keyboard.press('Control+a');
    await page.getByText('Export finished').waitFor({ timeout: 10000 });
    expect(fs.readdirSync(path.join(dir, 'Exports')).sort()).toEqual(['Bhoi Telecom Books (100003)', 'Cemech Paints (100001)', 'Knopff Solutions (100000)', 'Uniq Oils (100002)']);
    expect(fs.readdirSync(path.join(dir, 'Exports', 'Knopff Solutions (100000)')).sort()).toEqual(['DayBook.xml', 'Masters.xml']);
    await page.keyboard.press('Escape');
    await gateway();
  });
});

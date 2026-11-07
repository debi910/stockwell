// Bringing a whole company across from TallyPrime: masters, opening balances and every voucher.
// Either straight from TallyPrime running on this PC or another office PC (its XML server, port 9000),
// or from XML files exported from Tally. Importing again later brings in only what is new.
import type { Books } from './books';
import { BooksError } from './books';
import type { CompanyStore, Company } from './companies';
import { addDays, financialYear, todayISO } from '../core/dates';
import { fetchTallyCompanies, fetchTallyMasters, fetchTallyVouchers, importTallyMasters, parseTallyMasters, type TallyMasters } from './tally';
import { importTallyVouchers, parseTallyVouchers, type VoucherImportResult } from './tallyVouchers';

const getMeta = (books: Books, key: string) => (books.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as { value: string } | undefined)?.value;
const setMeta = (books: Books, key: string, value: string) => books.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);

/** Voucher types and GST ledgers from the Tally masters, kept so vouchers imported later (from another file) are read right. */
function rememberTallyMasters(books: Books, m: TallyMasters) {
  const types = JSON.parse(getMeta(books, 'tally_voucher_types') ?? '[]') as { name: string; parent: string }[];
  for (const t of m.voucherTypes ?? []) if (!types.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) types.push(t);
  setMeta(books, 'tally_voucher_types', JSON.stringify(types));
  const heads = JSON.parse(getMeta(books, 'tally_gst_heads') ?? '{}') as Record<string, string>;
  for (const l of m.ledgers) if (l.gstHead) heads[l.name.toLowerCase()] = l.gstHead;
  setMeta(books, 'tally_gst_heads', JSON.stringify(heads));
}

function voucherOptions(books: Books) {
  return {
    voucherTypes: JSON.parse(getMeta(books, 'tally_voucher_types') ?? '[]') as { name: string; parent: string }[],
    gstHeads: new Map(Object.entries(JSON.parse(getMeta(books, 'tally_gst_heads') ?? '{}') as Record<string, string>)),
  };
}

const hasMasters = (xml: string) => /<(LEDGER|STOCKITEM|GROUP|VOUCHERTYPE)\b/.test(xml);
const hasVouchers = (xml: string) => /<VOUCHER\b/.test(xml);

/** Before the first voucher, the books start date follows the Tally data (1 April of the earliest year seen). */
function fitBooksStart(books: Books, earliest: string | null, exact?: string | null) {
  const n = (books.db.prepare(`SELECT COUNT(*) n FROM vouchers`).get() as { n: number }).n;
  if (n) return;
  const want = exact || (earliest ? financialYear(earliest).start : null);
  if (want && want !== books.company().books_from) books.updateCompany({ books_from: want } as never);
}

const mergeResults = (a: VoucherImportResult, b: VoucherImportResult): VoucherImportResult => ({
  vouchers: a.vouchers + b.vouchers, already: a.already + b.already, skipped: [...a.skipped, ...b.skipped].slice(0, 500),
  byType: Object.fromEntries([...new Set([...Object.keys(a.byType), ...Object.keys(b.byType)])].map((k) => [k, (a.byType[k] ?? 0) + (b.byType[k] ?? 0)])),
  from: [a.from, b.from].filter(Boolean).sort()[0] ?? null, to: [a.to, b.to].filter(Boolean).sort().reverse()[0] ?? null,
});
const emptyResult = (): VoucherImportResult => ({ vouchers: 0, already: 0, skipped: [], byType: {}, from: null, to: null });

/** One XML file (or text) exported from Tally: masters, vouchers or both. Masters always go in first. */
export function importTallyXml(books: Books, xml: string) {
  if (typeof xml !== 'string' || !xml.trim()) throw new BooksError('The Tally file is empty.');
  if (!/<\s*(ENVELOPE|TALLYMESSAGE)\b/i.test(xml)) throw new BooksError('This is not a Tally export. In TallyPrime, use Alt+E > Masters, or Alt+E > Transactions > Day Book, and choose XML.');
  let masters: ReturnType<typeof importTallyMasters> | null = null;
  let vouchers: VoucherImportResult | null = null;
  if (hasMasters(xml)) {
    const m = parseTallyMasters(xml);
    rememberTallyMasters(books, m);
    masters = importTallyMasters(books, m);
  }
  if (hasVouchers(xml)) {
    const list = parseTallyVouchers(xml);
    const dates = list.map((v) => v.date).filter((d): d is string => !!d).sort();
    fitBooksStart(books, dates[0] ?? null);
    vouchers = importTallyVouchers(books, list, voucherOptions(books));
  }
  if (!masters && !vouchers) throw new BooksError('This file has no Tally masters or vouchers. In TallyPrime, use Alt+E > Masters, or Alt+E > Transactions > Day Book, and choose XML.');
  const none = { groups: 0, ledgers: 0, units: 0, stockGroups: 0, items: 0, bills: 0, batches: 0, godowns: 0, skipped: [] as string[] };
  return { ...(masters ?? none), vouchers };
}

// ----- importing straight from TallyPrime, as a job the screen can follow -----
export interface ImportJob {
  id: number; state: 'running' | 'done' | 'failed'; step: string; done: number; total: number;
  companies: { tally: string; id: string; name: string; masters?: ReturnType<typeof importTallyMasters>; vouchers?: VoucherImportResult; error?: string }[];
  error?: string; started: string; finished?: string;
}
const jobs = new Map<number, ImportJob>();
let nextJob = 1;
export const importJob = (id: number) => jobs.get(id) ?? null;

/** Months from start to end, as [first day, last day] pairs (Tally answers faster in small pieces). */
export function months(from: string, to: string): [string, string][] {
  const out: [string, string][] = [];
  let d = from;
  while (d <= to) {
    const [y, m] = d.split('-').map(Number);
    const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
    const end = addDays(next, -1);
    out.push([d, end < to ? end : to]);
    d = next;
  }
  return out;
}

/**
 * Starts bringing companies across from TallyPrime.
 * into: 'new' makes a Stockwell company (in its own folder) for each Tally company;
 *       'current' adds what is new into the company given (used to catch up while both are in use).
 */
export function startTallyImport(store: CompanyStore, opts: { url: string; companies: string[]; into: 'new' | 'current'; current?: Company; to?: string }): ImportJob {
  if (!Array.isArray(opts.companies) || !opts.companies.length || opts.companies.some((c) => typeof c !== 'string' || !c.trim())) throw new BooksError('Choose the Tally companies to bring in.');
  if (opts.into === 'current' && opts.companies.length !== 1) throw new BooksError('Choose one Tally company to bring into this company.');
  if (opts.into === 'new' && !store.multi) throw new BooksError('New companies can be made only in the desktop app on the main PC.');
  if ([...jobs.values()].some((j) => j.state === 'running')) throw new BooksError('An import from Tally is already running. Wait for it to finish.');
  const job: ImportJob = { id: nextJob++, state: 'running', step: 'Asking Tally for its companies…', done: 0, total: 0, companies: [], started: new Date().toISOString() };
  jobs.set(job.id, job);
  (async () => {
    const tallyList = await fetchTallyCompanies(opts.url);
    const to = opts.to || todayISO();
    const plan = opts.companies.map((name) => {
      const t = tallyList.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
      if (!t) throw new BooksError(`"${name}" is not open in TallyPrime. Open it there (Alt+F3 > Select Company) and try again.`);
      const from = t.booksFrom || t.startingFrom || financialYear(to).start;
      return { t, from, months: months(from, to) };
    });
    job.total = plan.reduce((a, p) => a + 1 + p.months.length, 0);
    for (const p of plan) {
      const entry: ImportJob['companies'][number] = { tally: p.t.name, id: '', name: p.t.name };
      job.companies.push(entry);
      try {
        let c: Company;
        if (opts.into === 'new') {
          const taken = store.list().some((x) => x.name.toLowerCase() === p.t.name.toLowerCase());
          c = store.create({ name: taken ? `${p.t.name} (from Tally ${todayISO()})` : p.t.name, books_from: p.from }, opts.current?.books);
        } else {
          c = opts.current!;
          fitBooksStart(c.books, null, p.from);
        }
        entry.id = c.id;
        entry.name = c.books.company().name;
        job.step = `${p.t.name}: masters and opening balances`;
        const m = parseTallyMasters(await fetchTallyMasters(opts.url, p.t.name));
        rememberTallyMasters(c.books, m);
        entry.masters = importTallyMasters(c.books, m);
        job.done++;
        let res = emptyResult();
        for (const [a, b] of p.months) {
          job.step = `${p.t.name}: vouchers of ${a.slice(0, 7)}`;
          const xml = await fetchTallyVouchers(opts.url, p.t.name, a, b);
          if (hasVouchers(xml)) res = mergeResults(res, importTallyVouchers(c.books, parseTallyVouchers(xml), voucherOptions(c.books)));
          entry.vouchers = res;
          job.done++;
        }
      } catch (e) {
        entry.error = (e as Error).message;
        job.done = Math.min(job.total, job.done + 1);
      }
    }
    job.state = job.companies.every((c) => c.error) ? 'failed' : 'done';
    if (job.state === 'failed') job.error = job.companies.map((c) => `${c.tally}: ${c.error}`).join(' ');
    job.step = 'Finished';
  })().catch((e) => {
    job.state = 'failed';
    job.error = (e as Error).message;
    job.step = 'Stopped';
  }).finally(() => { job.finished = new Date().toISOString(); });
  return job;
}

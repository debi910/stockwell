// Several companies on one main PC, like TallyPrime: each company is its own folder holding its own books file.
//   <data folder>/Companies/100000/stockwell.db
//   <data folder>/Companies/100001/stockwell.db
// Each PC chooses which company it works in; every request names it (header x-stockwell-company).
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { openDb, type DB } from './db';
import { Books, BooksError } from './books';
import { Users } from './users';
import { financialYear, todayISO } from '../core/dates';

export interface Company {
  id: string;
  books: Books;
  users: Users;
  dbPath: string;
  folder: string;
}

export interface CompanyInfo {
  id: string; name: string; books_from: string; gstin: string; city: string; folder: string;
  vouchers: number; last_entry: string | null; error?: string;
}

const ID_RE = /^\d{6}$/;
const FIRST_ID = 100000;

/** The company the current request works in. */
export const companyContext = new AsyncLocalStorage<Company>();

/** A Books (or Users) that always means "the company this request is for", so every route works for any company. */
export function perCompany<T extends object>(pick: () => T): T {
  return new Proxy({} as T, {
    get(_t, k) {
      const target = pick() as Record<string | symbol, unknown>;
      const v = target[k];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
    set(_t, k, v) { (pick() as Record<string | symbol, unknown>)[k] = v; return true; },
    has(_t, k) { return k in pick(); },
  });
}

export class CompanyStore {
  private open = new Map<string, Company>();
  private broken = new Map<string, string>();
  readonly root: string | null;
  private single: string | null;

  /** dataDir: the folder holding Companies\. dbPath: one books file only (tests, or an old single-company setup). */
  constructor(opts: { dataDir?: string; dbPath?: string }) {
    if (opts.dataDir) {
      this.root = path.join(opts.dataDir, 'Companies');
      this.single = null;
      fs.mkdirSync(this.root, { recursive: true });
      this.moveOldBooks(opts.dataDir);
      for (const id of this.folderIds()) this.tryOpen(id);
      if (!this.folderIds().length) this.create({});
    } else if (opts.dbPath) {
      this.root = null;
      this.single = String(FIRST_ID);
      this.open.set(this.single, this.make(this.single, opts.dbPath, path.dirname(opts.dbPath)));
    } else throw new Error('A data folder or a books file is needed.');
  }

  get multi() { return this.root !== null; }

  /** Books from before companies had folders (one stockwell.db next to the settings) become company 100000. */
  private moveOldBooks(dataDir: string) {
    const old = path.join(dataDir, 'stockwell.db');
    if (!fs.existsSync(old) || this.folderIds().length) return;
    const dir = path.join(this.root!, String(FIRST_ID));
    fs.mkdirSync(dir, { recursive: true });
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(old + ext)) fs.renameSync(old + ext, path.join(dir, `stockwell.db${ext}`));
  }

  private folderIds(): string[] {
    if (!this.root) return this.single ? [this.single] : [];
    return fs.readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && ID_RE.test(d.name) && fs.existsSync(path.join(this.root!, d.name, 'stockwell.db')))
      .map((d) => d.name).sort();
  }

  private make(id: string, dbPath: string, folder: string, db: DB = openDb(dbPath)): Company {
    const books = new Books(db);
    return { id, books, users: new Users(books), dbPath, folder };
  }

  private tryOpen(id: string): Company | null {
    const have = this.open.get(id);
    if (have) return have;
    const folder = path.join(this.root!, id);
    try {
      const c = this.make(id, path.join(folder, 'stockwell.db'), folder);
      this.open.set(id, c);
      this.broken.delete(id);
      return c;
    } catch (e) {
      this.broken.set(id, (e as Error).message);
      return null;
    }
  }

  /** The company to use when a request does not name one: the only one, or the first that opens. */
  defaultId(): string {
    if (this.single) return this.single;
    const ids = this.folderIds();
    return ids.find((id) => this.open.has(id)) ?? ids[0] ?? String(FIRST_ID);
  }

  has(id: string): boolean {
    return ID_RE.test(id) && (this.open.has(id) || (!!this.root && fs.existsSync(path.join(this.root, id, 'stockwell.db'))));
  }

  get(id: string): Company {
    if (!ID_RE.test(String(id))) throw Object.assign(new BooksError('That company was not found on the main PC.'), { code: 'no-company' });
    const c = this.open.get(id) ?? (this.root && fs.existsSync(path.join(this.root, id, 'stockwell.db')) ? this.tryOpen(id) : null);
    if (c) return c;
    const why = this.broken.get(id);
    throw Object.assign(new BooksError(why ? `Company ${id} could not be opened: ${why}` : 'That company was not found on the main PC.'), { code: 'no-company' });
  }

  all(): Company[] {
    return this.folderIds().map((id) => this.open.get(id) ?? (this.root ? this.tryOpen(id) : null)).filter((c): c is Company => !!c);
  }

  list(): CompanyInfo[] {
    return this.folderIds().map((id) => {
      const c = this.open.get(id) ?? (this.root ? this.tryOpen(id) : null);
      if (!c) return { id, name: `Company ${id}`, books_from: '', gstin: '', city: '', folder: this.root ? path.join(this.root, id) : '', vouchers: 0, last_entry: null, error: this.broken.get(id) };
      const co = c.books.company();
      const v = c.books.db.prepare(`SELECT COUNT(*) n, MAX(date) d FROM vouchers`).get() as { n: number; d: string | null };
      return { id, name: co.name, books_from: co.books_from, gstin: co.gstin, city: co.city, folder: c.folder, vouchers: v.n, last_entry: v.d };
    });
  }

  /** A new company in the next free folder (100000, 100001, …), as TallyPrime numbers its company folders. */
  /** usersFrom: the company it is made from; its logins (same names, passwords and roles) come along,
   *  so the other office PCs can open the new company straight away. */
  create(input: { name?: unknown; books_from?: unknown }, usersFrom?: Books): Company {
    if (!this.root) throw new BooksError('More companies can be made only in the desktop app on the main PC.');
    const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
    if (name.length > 100) throw new BooksError('The company name is too long.');
    if (name && this.list().some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new BooksError(`There is already a company called "${name}".`);
    const ids = this.folderIds().map(Number);
    let n = ids.length ? Math.max(...ids) + 1 : FIRST_ID;
    while (fs.existsSync(path.join(this.root, String(n)))) n++;
    if (n > 999999) throw new BooksError('No more company folders are free.');
    const id = String(n);
    const folder = path.join(this.root, id);
    fs.mkdirSync(folder, { recursive: true });
    let c: Company | undefined;
    try {
      c = this.make(id, path.join(folder, 'stockwell.db'), folder);
      const from = input.books_from === undefined || input.books_from === '' ? financialYear(todayISO()).start : input.books_from;
      c.books.updateCompany({ ...(name ? { name } : {}), books_from: from } as never);
      const users = usersFrom ? usersFrom.db.prepare(`SELECT name, role, salt, hash, active FROM users`).all() as Record<string, unknown>[] : [];
      const ins = c.books.db.prepare(`INSERT INTO users (name, role, salt, hash, active) VALUES (@name, @role, @salt, @hash, @active)`);
      for (const u of users) ins.run(u);
    } catch (e) {
      // A refused name or date must not leave a half-made company behind.
      try { c?.books.db.close(); } catch { /* ignore */ }
      this.open.delete(id);
      fs.rmSync(folder, { recursive: true, force: true });
      throw e;
    }
    this.open.set(id, c);
    return c;
  }

  /** Puts another books file (a backup) in place of a company's books. The company is closed while it is swapped. */
  async replace(id: string, file: string, safetyDir: string): Promise<string> {
    const c = this.get(id);
    fs.mkdirSync(safetyDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const safety = path.join(safetyDir, `stockwell-${id}-before-restore-${stamp}.db`);
    await c.books.db.backup(safety);
    c.books.db.close();
    this.open.delete(id);
    try {
      for (const ext of ['-wal', '-shm']) fs.rmSync(c.dbPath + ext, { force: true });
      fs.copyFileSync(file, `${c.dbPath}.restoring`);
      fs.renameSync(`${c.dbPath}.restoring`, c.dbPath);
    } catch (e) {
      try { fs.copyFileSync(safety, c.dbPath); } catch { /* the safety copy is still there */ }
      throw e;
    } finally {
      if (this.root) this.tryOpen(id);
      else this.open.set(id, this.make(id, c.dbPath, c.folder));
    }
    return safety;
  }

  closeAll() {
    for (const c of this.open.values()) { try { c.books.db.close(); } catch { /* already closed */ } }
    this.open.clear();
  }
}

import crypto from 'node:crypto';
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Books, BooksError, currentUser } from './books';
import { todayISO } from '../core/dates';

export type Role = 'owner' | 'operator';
export interface User { id: number; name: string; role: Role; active: number }

const hashOf = (password: string, salt: string) => crypto.scryptSync(password, salt, 32).toString('hex');
const hashAsync = (password: string, salt: string) =>
  new Promise<string>((resolve, reject) => crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
const fail = (msg: string): never => { throw new BooksError(msg); };

const MIN_PASSWORD = 6;
const IDLE_MS = 12 * 60 * 60 * 1000; // a login lasts 12 hours without use
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

/**
 * User logins, like TallyPrime's "Users and Passwords".
 * Until the first user is made, Stockwell opens without a login, but only on the main PC itself.
 * After that, every request needs a login token.
 */
export class Users {
  private sessions = new Map<string, { uid: number; lastSeen: number }>();
  private tickets = new Map<string, { uid: number; expires: number }>();
  private failures = new Map<string, { count: number; until: number }>();
  constructor(private books: Books) {}

  private get db() { return this.books.db; }

  enabled(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM users WHERE active=1 LIMIT 1`).get();
  }

  list(): User[] {
    return this.db.prepare(`SELECT id, name, role, active FROM users ORDER BY role, name`).all() as User[];
  }

  get(id: number): User {
    return (this.db.prepare(`SELECT id, name, role, active FROM users WHERE id=?`).get(id) as User) ?? fail('User not found.');
  }

  private checkPassword(p: unknown) {
    if (typeof p !== 'string' || p.length < MIN_PASSWORD) fail(`Password must be at least ${MIN_PASSWORD} characters.`);
    if ((p as string).length > 200) fail('Password is too long.');
  }

  create(u: { name: string; role: Role; password: string }): User {
    if (!u || typeof u !== 'object') fail('User details are missing.');
    const name = (typeof u.name === 'string' ? u.name.trim() : '') || fail('User name is required.');
    if (name.length > 60) fail('User name is too long.');
    if (!['owner', 'operator'].includes(u.role)) fail('Role must be Owner or Billing operator.');
    if (!this.enabled() && u.role !== 'owner') fail('The first user must be an Owner, so someone can always manage the others.');
    this.checkPassword(u.password);
    const salt = crypto.randomBytes(16).toString('hex');
    return this.db.transaction(() => {
      const r = this.db.prepare(`INSERT INTO users (name, role, salt, hash) VALUES (?, ?, ?, ?)`).run(name, u.role, salt, hashOf(u.password, salt));
      const user = this.get(Number(r.lastInsertRowid));
      this.books.audit('user', user.id, 'create', { name: user.name, role: user.role });
      return user;
    })();
  }

  update(id: number, patch: { role?: Role; active?: boolean; password?: string }): User {
    if (!patch || typeof patch !== 'object') fail('Nothing to change.');
    const before = this.get(id);
    const role = patch.role ?? before.role;
    if (!['owner', 'operator'].includes(role)) fail('Role must be Owner or Billing operator.');
    const active = patch.active === undefined ? before.active : patch.active ? 1 : 0;
    if (patch.password !== undefined) this.checkPassword(patch.password);
    if (before.role === 'owner' && before.active && (role !== 'owner' || !active)) {
      const owners = this.db.prepare(`SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1`).get() as { n: number };
      if (owners.n <= 1) fail('Keep at least one active Owner.');
    }
    this.db.transaction(() => {
      this.db.prepare(`UPDATE users SET role=?, active=? WHERE id=?`).run(role, active, id);
      if (patch.password !== undefined) {
        const salt = crypto.randomBytes(16).toString('hex');
        this.db.prepare(`UPDATE users SET salt=?, hash=? WHERE id=?`).run(salt, hashOf(patch.password, salt), id);
      }
      this.books.audit('user', id, 'update', { role, active, passwordChanged: patch.password !== undefined });
    })();
    // A new password, a new role or a disabled login ends that user's open sessions.
    if (!active || patch.password !== undefined || role !== before.role) this.endSessions(id);
    return this.get(id);
  }

  private endSessions(uid: number) {
    for (const [t, s] of this.sessions) if (s.uid === uid) this.sessions.delete(t);
  }

  async login(name: unknown, password: unknown, from: string): Promise<{ token: string; user: User }> {
    const n = typeof name === 'string' ? name.trim() : '';
    const p = typeof password === 'string' ? password : '';
    const key = `${n.toLowerCase()}|${from}`;
    const f = this.failures.get(key);
    if (f && f.until > Date.now()) fail(`Too many wrong tries. Wait ${Math.ceil((f.until - Date.now()) / 1000)} seconds and try again.`);
    const row = this.db.prepare(`SELECT * FROM users WHERE name=? AND active=1`).get(n) as (User & { salt: string; hash: string }) | undefined;
    // Hash even for an unknown name, so the reply time does not reveal which names exist.
    const hash = await hashAsync(p, row?.salt ?? DUMMY_SALT);
    const ok = !!row && crypto.timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(hash, 'hex'));
    if (!ok) {
      const count = (f?.count ?? 0) + 1;
      // After 5 wrong tries, wait 1 minute; it doubles after each further miss (at most 30 minutes).
      const until = count >= 5 ? Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** (count - 5)) : 0;
      this.failures.set(key, { count, until });
      this.books.audit('login', row?.id ?? null, 'failed', { name: n.slice(0, 60), from });
      fail('Wrong user name or password.');
    }
    this.failures.delete(key);
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, { uid: row!.id, lastSeen: Date.now() });
    this.books.audit('login', row!.id, 'login', { name: row!.name, from });
    return { token, user: this.get(row!.id) };
  }

  logout(token: string) {
    this.sessions.delete(token);
  }

  fromToken(token: string | undefined): User | null {
    const s = token ? this.sessions.get(token) : undefined;
    if (!s) return null;
    if (Date.now() - s.lastSeen > IDLE_MS) { this.sessions.delete(token!); return null; }
    s.lastSeen = Date.now();
    const u = this.db.prepare(`SELECT id, name, role, active FROM users WHERE id=?`).get(s.uid) as User | undefined;
    return u && u.active ? u : null;
  }

  /** A one-use pass for opening a printed bill in a new window, so the login token never sits in a URL. */
  ticket(uid: number): string {
    const t = crypto.randomBytes(18).toString('hex');
    this.tickets.set(t, { uid, expires: Date.now() + 60_000 });
    return t;
  }

  useTicket(t: string | undefined): User | null {
    if (!t) return null;
    const x = this.tickets.get(t);
    this.tickets.delete(t);
    if (!x || x.expires < Date.now()) return null;
    const u = this.db.prepare(`SELECT id, name, role, active FROM users WHERE id=?`).get(x.uid) as User | undefined;
    return u && u.active ? u : null;
  }
}

/** Requests anyone may make without logging in. */
const OPEN = ['/api/meta', '/api/session', '/api/login'];

/** What a Billing operator may not do. Checked on the server, so a changed screen cannot get around it.
 *  Matches the router's own route pattern (already decoded), never the raw URL, so %-encoding cannot slip past. */
function operatorBlocked(req: FastifyRequest, route: string, books: Books): string | null {
  const m = req.method;
  const id = Number((req.params as Record<string, string>)?.id);
  if (m === 'DELETE') return 'Only an Owner can delete.';
  if (route.startsWith('/api/users')) return 'Only an Owner can manage users.';
  if (m === 'PUT' && route === '/api/company') return 'Only an Owner can change company settings.';
  if (m === 'PUT' && (route === '/api/ledgers/:id' || route === '/api/items/:id')) return 'Only an Owner can alter masters. You can still create new ones.';
  if (route === '/api/vouchers/:id/cancel') return 'Only an Owner can cancel a voucher.';
  if (m === 'PUT' && (route === '/api/vouchers/:id' || route === '/api/vouchers/:id/ewb')) {
    const v = books.db.prepare(`SELECT date FROM vouchers WHERE id=?`).get(id) as { date: string } | undefined;
    if (v && v.date !== todayISO()) return "A Billing operator can only change today's vouchers.";
  }
  if (['/api/reports/profit-loss', '/api/reports/balance-sheet', '/api/reports/trial-balance'].includes(route)) return 'Only an Owner can see this report.';
  if (route === '/api/audit') return 'Only an Owner can see the edit log.';
  if (route === '/api/import/tally') return 'Only an Owner can import data.';
  if (route === '/api/backup') return 'Only an Owner can make a backup.';
  if (route === '/api/items/gst-rate' || route === '/api/items/:id/prices' || (m !== 'GET' && route.startsWith('/api/godowns/'))) return 'Only an Owner can change rates and godowns.';
  if (route === '/api/vouchers/:id/bounce' || route === '/api/vouchers/:id/bank-date') return 'Only an Owner can mark cheques and bank dates.';
  if (['/api/reports/tds', '/api/reports/brs/:ledgerId', '/api/gst/gstr2b'].includes(route)) return 'Only an Owner can see this report.';
  return null;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (ip: string | undefined) => !!ip && LOOPBACK.has(ip);

/** A web page on another site could try to reach Stockwell through a made-up name pointing at this PC
 *  (DNS rebinding). Only accept names that are plainly this PC: an IP address, localhost, or the PC's own name. */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return true; // old HTTP/1.0 clients; the token still protects everything
  const name = host.replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/:\d+$/, '').toLowerCase();
  if (name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) return true;
  const me = os.hostname().toLowerCase();
  return name === me || name === `${me}.local` || name === `${me}.lan`;
}

export function installAuth(app: FastifyInstance, books: Books): Users {
  const users = new Users(books);
  const tokenOf = (req: FastifyRequest) => {
    const t = req.headers['x-stockwell-token'];
    return typeof t === 'string' && t ? t : undefined;
  };

  app.addHook('onRequest', (req, reply, done) => {
    if (!hostAllowed(req.headers.host)) { reply.status(421).send({ error: 'Open Stockwell using the main PC\'s address.' }); return; }
    const route = req.routeOptions?.url; // the matched pattern, e.g. /api/vouchers/:id; undefined for a 404
    if (!route || !route.startsWith('/api/') || OPEN.includes(route)) return currentUser.run(null, done);
    if (!users.enabled()) {
      // Before the Owner's login exists, the books open only on the main PC itself, never over the network.
      if (!isLoopback(req.ip)) { reply.status(403).send({ error: "Set up the Owner's login on the main PC first (Settings > Users). Until then the books open only on the main PC." }); return; }
      return currentUser.run(null, done);
    }
    let user = users.fromToken(tokenOf(req));
    // A printed bill opens in its own window, so it carries a one-use pass instead of the login token.
    if (!user && req.method === 'GET' && route === '/api/vouchers/:id/print') user = users.useTicket((req.query as Record<string, string>)?.ticket);
    if (!user) { reply.status(401).send({ error: 'Please log in.' }); return; }
    if (user.role === 'operator') {
      const why = operatorBlocked(req, route, books);
      if (why) { reply.status(403).send({ error: why }); return; }
    }
    currentUser.run({ id: user.id, name: user.name, role: user.role }, done);
  });

  // Checks that need the parsed body run after parsing.
  app.addHook('preHandler', (req, reply, done) => {
    const u = currentUser.getStore();
    const route = req.routeOptions?.url;
    if (u?.role === 'operator' && req.method === 'PUT' && route === '/api/vouchers/:id') {
      const d = (req.body as { date?: string } | null)?.date;
      if (d !== todayISO()) { reply.status(403).send({ error: "A Billing operator can only keep a voucher on today's date." }); return; }
    }
    done();
  });

  app.get('/api/session', async (req) => ({
    usersEnabled: users.enabled(),
    user: users.fromToken(tokenOf(req)),
    // Tells a second PC why it cannot open the books yet.
    needsOwnerSetup: !users.enabled() && !isLoopback(req.ip),
  }));
  app.post('/api/login', async (req) => {
    const b = (req.body ?? {}) as { name?: unknown; password?: unknown };
    return users.login(b.name, b.password, req.ip);
  });
  app.post('/api/logout', async (req) => { const t = tokenOf(req); if (t) users.logout(t); return { ok: true }; });
  app.post('/api/print-ticket', async () => {
    const u = currentUser.getStore();
    return { ticket: u ? users.ticket(u.id) : null };
  });
  app.get('/api/users', async () => users.list());
  app.post('/api/users', async (req) => users.create(req.body as never));
  app.put('/api/users/:id', async (req) => users.update(Number((req.params as Record<string, string>).id), req.body as never));
  return users;
}

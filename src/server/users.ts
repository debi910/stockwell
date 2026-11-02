import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Books, BooksError, currentUser } from './books';
import { todayISO } from '../core/dates';

export type Role = 'owner' | 'operator';
export interface User { id: number; name: string; role: Role; active: number }

const hashOf = (password: string, salt: string) => crypto.scryptSync(password, salt, 32).toString('hex');
const fail = (msg: string): never => { throw new BooksError(msg); };

/**
 * User logins, like TallyPrime's "Users and Passwords".
 * Until the first user is made, Stockwell opens without a login (handy while setting up).
 * After that, every request needs a login token.
 */
export class Users {
  private sessions = new Map<string, number>();
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

  create(u: { name: string; role: Role; password: string }): User {
    const name = u.name?.trim() || fail('User name is required.');
    if (!['owner', 'operator'].includes(u.role)) fail('Role must be Owner or Billing operator.');
    if (!this.enabled() && u.role !== 'owner') fail('The first user must be an Owner, so someone can always manage the others.');
    if (!u.password || u.password.length < 4) fail('Password must be at least 4 characters.');
    const salt = crypto.randomBytes(16).toString('hex');
    const r = this.db.prepare(`INSERT INTO users (name, role, salt, hash) VALUES (?, ?, ?, ?)`).run(name, u.role, salt, hashOf(u.password, salt));
    const user = this.get(Number(r.lastInsertRowid));
    this.books.audit('user', user.id, 'create', { name: user.name, role: user.role });
    return user;
  }

  update(id: number, patch: { role?: Role; active?: boolean; password?: string }): User {
    const before = this.get(id);
    const role = patch.role ?? before.role;
    const active = patch.active === undefined ? before.active : patch.active ? 1 : 0;
    if (before.role === 'owner' && before.active && (role !== 'owner' || !active)) {
      const owners = this.db.prepare(`SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1`).get() as { n: number };
      if (owners.n <= 1) fail('Keep at least one active Owner.');
    }
    this.db.prepare(`UPDATE users SET role=?, active=? WHERE id=?`).run(role, active, id);
    if (patch.password !== undefined) {
      if (patch.password.length < 4) fail('Password must be at least 4 characters.');
      const salt = crypto.randomBytes(16).toString('hex');
      this.db.prepare(`UPDATE users SET salt=?, hash=? WHERE id=?`).run(salt, hashOf(patch.password, salt), id);
    }
    if (!active) for (const [t, uid] of this.sessions) if (uid === id) this.sessions.delete(t);
    this.books.audit('user', id, 'update', { role, active, passwordChanged: patch.password !== undefined });
    return this.get(id);
  }

  login(name: string, password: string): { token: string; user: User } {
    const row = this.db.prepare(`SELECT * FROM users WHERE name=? AND active=1`).get(name ?? '') as (User & { salt: string; hash: string }) | undefined;
    const ok = row && crypto.timingSafeEqual(Buffer.from(row.hash, 'hex'), Buffer.from(hashOf(password ?? '', row.salt), 'hex'));
    if (!row || !ok) fail('Wrong user name or password.');
    const token = crypto.randomBytes(24).toString('hex');
    this.sessions.set(token, row!.id);
    return { token, user: this.get(row!.id) };
  }

  logout(token: string) {
    this.sessions.delete(token);
  }

  fromToken(token: string | undefined): User | null {
    const id = token ? this.sessions.get(token) : undefined;
    if (!id) return null;
    const u = this.get(id);
    return u.active ? u : null;
  }
}

/** Requests anyone may make without logging in. */
const OPEN = ['/api/meta', '/api/session', '/api/login'];

/** What a Billing operator may not do. Checked on the server, so a changed screen cannot get around it. */
function operatorBlocked(req: FastifyRequest, books: Books): string | null {
  const url = req.url.split('?')[0];
  const m = req.method;
  if (m === 'DELETE') return 'Only an Owner can delete.';
  if (url.startsWith('/api/users')) return 'Only an Owner can manage users.';
  if (m === 'PUT' && url === '/api/company') return 'Only an Owner can change company settings.';
  if (m === 'PUT' && /^\/api\/(ledgers|items)\/\d+$/.test(url)) return 'Only an Owner can alter masters. You can still create new ones.';
  if (/^\/api\/vouchers\/\d+\/cancel$/.test(url)) return 'Only an Owner can cancel a voucher.';
  if (m === 'PUT' && /^\/api\/vouchers\/\d+$/.test(url)) {
    const id = Number(url.split('/')[3]);
    const v = books.db.prepare(`SELECT date FROM vouchers WHERE id=?`).get(id) as { date: string } | undefined;
    if (v && v.date !== todayISO()) return "A Billing operator can only change today's vouchers.";
  }
  if (/^\/api\/reports\/(profit-loss|balance-sheet|trial-balance)/.test(url)) return 'Only an Owner can see this report.';
  if (url === '/api/audit') return 'Only an Owner can see the edit log.';
  if (url === '/api/import/tally') return 'Only an Owner can import data.';
  return null;
}

export function installAuth(app: FastifyInstance, books: Books): Users {
  const users = new Users(books);
  const tokenOf = (req: FastifyRequest) =>
    (req.headers['x-stockwell-token'] as string | undefined) ?? ((req.query as Record<string, string>)?.t || undefined);

  app.addHook('onRequest', (req, reply, done) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/') || OPEN.includes(url)) return currentUser.run(null, done);
    if (!users.enabled()) return currentUser.run(null, done); // no logins set up yet
    const user = users.fromToken(tokenOf(req));
    if (!user) { reply.status(401).send({ error: 'Please log in.' }); return; }
    if (user.role === 'operator') {
      const why = operatorBlocked(req, books);
      if (why) { reply.status(403).send({ error: why }); return; }
    }
    currentUser.run({ id: user.id, name: user.name, role: user.role }, done);
  });

  app.get('/api/session', async (req) => ({ usersEnabled: users.enabled(), user: users.fromToken(tokenOf(req)) }));
  app.post('/api/login', async (req) => {
    const b = req.body as { name: string; password: string };
    return users.login(b.name, b.password);
  });
  app.post('/api/logout', async (req) => { const t = tokenOf(req); if (t) users.logout(t); return { ok: true }; });
  app.get('/api/users', async () => users.list());
  app.post('/api/users', async (req) => users.create(req.body as never));
  app.put('/api/users/:id', async (req) => users.update(Number((req.params as Record<string, string>).id), req.body as never));
  return users;
}

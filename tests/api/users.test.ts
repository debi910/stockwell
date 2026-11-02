import { beforeEach, describe, expect, it } from 'vitest';
import { seedDistributor, setup } from './helpers';
import { todayISO } from '../../src/core/dates';

let ctx: Awaited<ReturnType<typeof setup>>;
let m: Awaited<ReturnType<typeof seedDistributor>>;

beforeEach(async () => {
  ctx = await setup();
  m = await seedDistributor(ctx.call);
});

/** Calls the API as a logged-in user. */
async function as(token: string, method: string, url: string, payload?: unknown) {
  const res = await ctx.app.inject({ method: method as never, url, payload: payload as never, headers: { 'x-stockwell-token': token } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function login(name: string, password: string): Promise<string> {
  return (await ctx.call('POST', '/api/login', { name, password })).token;
}

describe('users and passwords', () => {
  it('opens without a login until the first user is made', async () => {
    expect(await ctx.call('GET', '/api/session')).toEqual({ usersEnabled: false, user: null, needsOwnerSetup: false });
    await expect(ctx.call('POST', '/api/users', { name: 'Ramesh', role: 'operator', password: 'abcd' })).rejects.toThrow(/first user must be an Owner/);
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    await expect(ctx.call('GET', '/api/ledgers')).rejects.toThrow(/401/);
    await expect(ctx.call('POST', '/api/login', { name: 'Papa', password: 'wrong' })).rejects.toThrow(/Wrong user name or password/);
    const t = await login('papa', 'secret1');
    const s = await as(t, 'GET', '/api/session');
    expect(s.body.user.name).toBe('Papa');
    expect((await as(t, 'GET', '/api/ledgers')).status).toBe(200);
  });

  it('lets a Billing operator make bills but not delete, alter old entries or see profit', async () => {
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const owner = await login('Papa', 'secret1');
    expect((await as(owner, 'POST', '/api/users', { name: 'Ramesh', role: 'operator', password: 'bill123' })).status).toBe(200);
    const op = await login('Ramesh', 'bill123');

    const today = todayISO();
    const sale = await as(op, 'POST', '/api/vouchers', { type: 'receipt', date: today, accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 10000 }] });
    expect(sale.status).toBe(200);
    const old = await as(owner, 'POST', '/api/vouchers', { type: 'receipt', date: '2026-10-01', accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 5000 }] });
    expect(old.status).toBe(200);

    expect((await as(op, 'POST', `/api/vouchers/${sale.body.id}/cancel`)).status).toBe(403);
    expect((await as(op, 'PUT', `/api/vouchers/${old.body.id}`, { type: 'receipt', date: '2026-10-01', lines: [] })).body.error).toMatch(/today/);
    expect((await as(op, 'GET', '/api/reports/profit-loss')).status).toBe(403);
    expect((await as(op, 'GET', '/api/reports/balance-sheet')).status).toBe(403);
    expect((await as(op, 'DELETE', `/api/ledgers/${m.ramesh.id}`)).status).toBe(403);
    expect((await as(op, 'PUT', '/api/company', { name: 'X' })).status).toBe(403);
    expect((await as(op, 'GET', '/api/users')).status).toBe(403);
    expect((await as(op, 'GET', '/api/reports/day-book')).status).toBe(200);
    expect((await as(owner, 'GET', '/api/reports/profit-loss')).status).toBe(200);

    const log = (await as(owner, 'GET', '/api/audit')).body as any[];
    expect(log.find((r) => r.entity === 'voucher' && r.entity_id === sale.body.id)?.user_name).toBe('Ramesh');
  });

  it('keeps the books closed to other PCs until the Owner login exists', async () => {
    const remote = { remoteAddress: '192.168.1.20' };
    const r = await ctx.app.inject({ method: 'GET', url: '/api/ledgers', ...remote });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).error).toMatch(/Owner's login on the main PC/);
    const s = await ctx.app.inject({ method: 'GET', url: '/api/session', ...remote });
    expect(JSON.parse(s.body).needsOwnerSetup).toBe(true);
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const l = await ctx.app.inject({ method: 'POST', url: '/api/login', payload: { name: 'Papa', password: 'secret1' }, ...remote });
    const t = JSON.parse(l.body).token;
    expect((await ctx.app.inject({ method: 'GET', url: '/api/ledgers', headers: { 'x-stockwell-token': t }, ...remote })).statusCode).toBe(200);
  });

  it('refuses requests that arrive under a strange host name', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/api/meta', headers: { host: 'evil.example.com' } });
    expect(r.statusCode).toBe(421);
    expect((await ctx.app.inject({ method: 'GET', url: '/api/meta', headers: { host: '192.168.1.5:7400' } })).statusCode).toBe(200);
  });

  it('rejects short passwords and locks a name after five wrong tries', async () => {
    await expect(ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'abc' })).rejects.toThrow(/at least 6/);
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    for (let i = 0; i < 5; i++) await expect(login('Papa', 'nope')).rejects.toThrow(/Wrong/);
    await expect(login('Papa', 'secret1')).rejects.toThrow(/Too many wrong tries/);
  });

  it('ends open logins when a password changes', async () => {
    const papa = await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const t = await login('Papa', 'secret1');
    await as(t, 'PUT', `/api/users/${papa.id}`, { password: 'secret2' });
    expect((await as(t, 'GET', '/api/ledgers')).status).toBe(401);
  });

  it('prints with a one-use pass, never the login token in the link', async () => {
    await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const t = await login('Papa', 'secret1');
    const sale = await as(t, 'POST', '/api/vouchers', { type: 'receipt', date: todayISO(), accountId: m.bank.id, entries: [{ ledgerId: m.ramesh.id, amount: 10000 }] });
    const url = `/api/vouchers/${sale.body.id}/print`;
    expect((await ctx.app.inject({ method: 'GET', url: `${url}?t=${t}` })).statusCode).toBe(401);
    const { ticket } = (await as(t, 'POST', '/api/print-ticket')).body;
    expect((await ctx.app.inject({ method: 'GET', url: `${url}?ticket=${ticket}` })).statusCode).not.toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: `${url}?ticket=${ticket}` })).statusCode).toBe(401);
  });

  it('always keeps one active Owner', async () => {
    const papa = await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const t = await login('Papa', 'secret1');
    const r = await as(t, 'PUT', `/api/users/${papa.id}`, { role: 'operator' });
    expect(r.body.error).toMatch(/at least one active Owner/);
  });
});

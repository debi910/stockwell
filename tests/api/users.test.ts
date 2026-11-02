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
    expect(await ctx.call('GET', '/api/session')).toEqual({ usersEnabled: false, user: null });
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
    expect((await as(owner, 'POST', '/api/users', { name: 'Ramesh', role: 'operator', password: 'bill' })).status).toBe(200);
    const op = await login('Ramesh', 'bill');

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

  it('always keeps one active Owner', async () => {
    const papa = await ctx.call('POST', '/api/users', { name: 'Papa', role: 'owner', password: 'secret1' });
    const t = await login('Papa', 'secret1');
    const r = await as(t, 'PUT', `/api/users/${papa.id}`, { role: 'operator' });
    expect(r.body.error).toMatch(/at least one active Owner/);
  });
});

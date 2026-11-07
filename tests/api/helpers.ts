import { buildApp } from '../../src/server/app';
import { toPaise } from '../../src/core/money';

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Makes a GSTIN with a correct check digit for tests. */
export function gstin(state: string, pan: string, entity = '1'): string {
  const body = `${state}${pan}${entity}Z`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = CH.indexOf(body[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return body + CH[(36 - (sum % 36)) % 36];
}

export async function setup() {
  const { app, books } = await buildApp({ dbPath: ':memory:' });
  const call = async <T = any>(method: string, url: string, payload?: unknown): Promise<T> => {
    const res = await app.inject({ method: method as never, url, payload: payload as never });
    const body = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode}: ${body?.error}`);
    return body as T;
  };
  return { app, books, call, p: toPaise };
}

/** A distributor in Bhubaneswar with three retailers, one supplier and two items. */
export async function seedDistributor(call: Awaited<ReturnType<typeof setup>>['call']) {
  await call('PUT', '/api/company', {
    name: 'Samal Distributors', address: 'Plot 12, Saheed Nagar', city: 'Bhubaneswar', pincode: '751007',
    gstin: gstin('21', 'ABCDE1234F'), phone: '9437000000', upi_id: 'samal@upi', books_from: '2026-04-01', msme_interest_rate: 19.5,
  });
  const groups = await call<any[]>('GET', '/api/groups');
  const g = (n: string) => groups.find((x) => x.name === n).id;
  const units = await call<any[]>('GET', '/api/units');
  const pcs = units.find((u) => u.symbol === 'Pcs').id;
  const patanjali = await call('POST', '/api/stock-groups', { name: 'Patanjali' });
  const parag = await call('POST', '/api/stock-groups', { name: 'Parag Milk Foods' });
  const ramesh = await call('POST', '/api/ledgers', { name: 'Ramesh Stores', group_id: g('Sundry Debtors'), gstin: gstin('21', 'RAMES1234K'), phone: '98610 12345', credit_days: 15, beat: 'Saheed Nagar', msme_buyer: 1 });
  const kalpana = await call('POST', '/api/ledgers', { name: 'Kalpana Kirana', group_id: g('Sundry Debtors'), phone: '9861099999', credit_days: 7, beat: 'Old Town' });
  const kolkata = await call('POST', '/api/ledgers', { name: 'Kolkata Traders', group_id: g('Sundry Debtors'), gstin: gstin('19', 'KOLKA1234T'), credit_days: 30 });
  const supplier = await call('POST', '/api/ledgers', { name: 'Parag Milk Foods Ltd', group_id: g('Sundry Creditors'), gstin: gstin('27', 'PARAG1234M'), credit_days: 30, msme_supplier: 1 });
  const bank = await call('POST', '/api/ledgers', { name: 'SBI Current A/c', group_id: g('Bank Accounts'), opening: 50000000 });
  const capital = await call('POST', '/api/ledgers', { name: 'Capital', group_id: g('Capital Account'), opening: -50000000 });
  const ghee = await call('POST', '/api/items', { name: 'Patanjali Cow Ghee 1L', unit_id: pcs, stock_group_id: patanjali.id, hsn: '0405', gst_rate: 12, sale_rate: 60000, purchase_rate: 55000, scheme_buy: 10, scheme_free: 1, reorder_level: 5 });
  const curd = await call('POST', '/api/items', { name: 'Gowardhan Dahi 400g', unit_id: pcs, stock_group_id: parag.id, hsn: '0403', gst_rate: 5, sale_rate: 4500, purchase_rate: 4000, track_batch: 1 });
  return { g, pcs, ramesh, kalpana, kolkata, supplier, bank, capital, ghee, curd };
}

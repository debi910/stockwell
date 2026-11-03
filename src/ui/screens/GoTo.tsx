// F10 (list of voucher types) and Alt+G (Go To), as in TallyPrime.
import { useMemo, useState } from 'react';
import { Menu } from '../components/Menu';
import { isOwner, useNav, useScreenKeys, type Nav } from '../nav';

/** Voucher types grouped the way TallyPrime's F10 list groups them, with their keys. */
const GROUPS: { section: string; types: [string, string, string][] }[] = [
  { section: 'Accounting Vouchers', types: [
    ['contra', 'Contra', 'F4'], ['payment', 'Payment', 'F5'], ['receipt', 'Receipt', 'F6'], ['journal', 'Journal', 'F7'],
    ['sales', 'Sales', 'F8'], ['purchase', 'Purchase', 'F9'], ['credit_note', 'Credit Note', 'Alt+F6'], ['debit_note', 'Debit Note', 'Alt+F5'],
  ] },
  { section: 'Inventory Vouchers', types: [
    ['stock_journal', 'Stock Journal', 'Alt+F7'], ['physical_stock', 'Physical Stock', 'Ctrl+F7'],
    ['delivery_note', 'Delivery Note', 'Alt+F8'], ['receipt_note', 'Receipt Note', 'Alt+F9'],
    ['rejection_in', 'Rejection In', 'Ctrl+F6'], ['rejection_out', 'Rejection Out', 'Ctrl+F5'],
  ] },
  { section: 'Order Vouchers', types: [['sales_order', 'Sales Order', 'Ctrl+F8'], ['purchase_order', 'Purchase Order', 'Ctrl+F9']] },
  { section: 'Other Vouchers', types: [['memorandum', 'Memorandum', ''], ['reversing_journal', 'Reversing Journal', '']] },
];

export function VoucherTypesMenu() {
  const nav = useNav();
  const open = (type: string) => () => nav.replace({ name: 'voucher', props: { type } });
  return (
    <div style={{ padding: 24 }}>
      <Menu title="Change Voucher Type" entries={GROUPS.flatMap((g) => [
        { section: g.section },
        ...g.types.map(([t, label, key]) => ({ label: key ? `${label}   ${key}` : label, run: open(t) })),
      ])} />
    </div>
  );
}

type Dest = { label: string; group: string; open: (nav: Nav) => void; owner?: boolean };
const screen = (name: string, props?: any) => (nav: Nav) => nav.replace({ name, props });

const DESTS: Dest[] = [
  ...GROUPS.flatMap((g) => g.types.map(([t, label]) => ({ label, group: 'Voucher', open: screen('voucher', { type: t }) }))),
  { label: 'Ledger', group: 'Create Master', open: screen('ledger-form') },
  { label: 'Group', group: 'Create Master', open: screen('group-form') },
  { label: 'Stock Item', group: 'Create Master', open: screen('item-form') },
  { label: 'Stock Group', group: 'Create Master', open: screen('stock-group-form') },
  { label: 'Unit', group: 'Create Master', open: screen('unit-form') },
  { label: 'Ledger', group: 'Alter Master', open: screen('master-list', { kind: 'ledger', mode: 'alter' }), owner: true },
  { label: 'Stock Item', group: 'Alter Master', open: screen('master-list', { kind: 'item', mode: 'alter' }), owner: true },
  { label: 'Chart of Accounts', group: 'Report', open: screen('master-list', { kind: 'ledger', mode: 'view' }) },
  { label: 'Day Book', group: 'Report', open: screen('day-book') },
  { label: 'Ledger Vouchers', group: 'Report', open: screen('master-list', { kind: 'ledger', mode: 'report' }) },
  { label: 'Balance Sheet', group: 'Report', open: screen('balance-sheet'), owner: true },
  { label: 'Profit & Loss A/c', group: 'Report', open: screen('profit-loss'), owner: true },
  { label: 'Trial Balance', group: 'Report', open: screen('trial-balance'), owner: true },
  { label: 'Stock Summary', group: 'Report', open: screen('stock-summary') },
  { label: 'Bills Receivable (Outstandings)', group: 'Report', open: screen('outstanding', { kind: 'receivable' }) },
  { label: 'Bills Payable (Outstandings)', group: 'Report', open: screen('outstanding', { kind: 'payable' }) },
  { label: 'Alerts & Reminders (overdue, MSME, expiry)', group: 'Report', open: screen('alerts') },
  { label: 'GST Returns (GSTR-1, GSTR-3B) & e-Way Bills', group: 'Report', open: screen('gst') },
  { label: 'Edit Log (Audit trail)', group: 'Report', open: screen('audit'), owner: true },
  { label: 'Sales Register', group: 'Report', open: screen('register', { type: 'sales' }) },
  { label: 'Purchase Register', group: 'Report', open: screen('register', { type: 'purchase' }) },
  { label: 'Credit Note Register', group: 'Report', open: screen('register', { type: 'credit_note' }) },
  { label: 'Debit Note Register', group: 'Report', open: screen('register', { type: 'debit_note' }) },
  { label: 'Receipt Register', group: 'Report', open: screen('register', { type: 'receipt' }) },
  { label: 'Payment Register', group: 'Report', open: screen('register', { type: 'payment' }) },
  { label: 'Sales by Beat / Salesman / Party / Item', group: 'Report', open: screen('sales-analysis') },
  { label: 'Godown Summary', group: 'Report', open: screen('godown-stock') },
  { label: 'Scheme Claims (free goods)', group: 'Report', open: screen('scheme-claims') },
  { label: 'Bank Reconciliation', group: 'Report', open: screen('bank-reco'), owner: true },
  { label: 'Post-dated Cheques', group: 'Report', open: screen('pdc') },
  { label: 'Sales Orders / Delivery Notes Pending', group: 'Report', open: screen('pending-orders', { kind: 'sales' }) },
  { label: 'Purchase Orders / Receipt Notes Pending', group: 'Report', open: screen('pending-orders', { kind: 'purchase' }) },
  { label: 'TDS Register', group: 'Report', open: screen('tds'), owner: true },
  { label: 'GSTR-2B Reconciliation', group: 'Report', open: screen('gstr2b'), owner: true },
  { label: 'Godowns', group: 'Create Master', open: screen('godowns'), owner: true },
  { label: 'Change GST Rate (many items)', group: 'Alter Master', open: screen('gst-rate'), owner: true },
  { label: 'Company Features (F11)', group: 'Company', open: screen('features'), owner: true },
  { label: 'Company Settings', group: 'Company', open: screen('company'), owner: true },
  { label: 'Users and Passwords', group: 'Company', open: screen('users'), owner: true },
  { label: 'Backup / Restore', group: 'Data', open: screen('backup'), owner: true },
  { label: 'Import from Tally', group: 'Data', open: screen('import-tally'), owner: true },
];

export function GoTo() {
  const nav = useNav();
  const owner = isOwner(nav);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return DESTS.filter((d) => (owner || !d.owner) && words.every((w) => `${d.group} ${d.label}`.toLowerCase().includes(w)));
  }, [q, owner]);
  useScreenKeys((e) => {
    if (e.key === 'ArrowDown') { setSel((s) => Math.min(s + 1, list.length - 1)); return true; }
    if (e.key === 'ArrowUp') { setSel((s) => Math.max(s - 1, 0)); return true; }
    if (e.key === 'Enter') { list[sel]?.open(nav); return true; }
    return false;
  });
  return (
    <div style={{ padding: 24, maxWidth: 620 }}>
      <div className="panel" style={{ padding: 12 }}>
        <input className="f" autoFocus aria-label="Go To" placeholder="Type a report, voucher or master…" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }} style={{ width: '100%' }} />
        <div role="listbox" aria-label="Go To list" style={{ marginTop: 8, maxHeight: 460, overflowY: 'auto' }}>
          {list.map((d, i) => (
            <div key={d.group + d.label} role="option" aria-selected={i === sel} className={`menu-row ${i === sel ? 'sel' : ''}`}
              style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 8px', cursor: 'pointer', background: i === sel ? 'var(--sel, #f4c35a)' : undefined }}
              onMouseEnter={() => setSel(i)} onClick={() => d.open(nav)}>
              <span>{d.label}</span><span className="subtle">{d.group}</span>
            </div>
          ))}
          {!list.length && <div className="subtle" style={{ padding: 8 }}>Nothing matches.</div>}
        </div>
      </div>
    </div>
  );
}

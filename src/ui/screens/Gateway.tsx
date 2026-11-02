import { useEffect, useState } from 'react';
import { api } from '../api';
import { Menu } from '../components/Menu';
import { isOwner, useNav } from '../nav';
import { formatINR, shortDate } from '../format';

export function Gateway({ active }: { active: boolean }) {
  const nav = useNav();
  const [alerts, setAlerts] = useState<any>(null);
  useEffect(() => {
    if (active) api.get(`/api/reports/alerts?asOf=${nav.workDate}`).then(setAlerts).catch(() => setAlerts(null));
  }, [active, nav.workDate]);
  const go = (name: string, props?: any) => () => nav.push({ name, props });
  const c = nav.company;
  const owner = isOwner(nav);

  return (
    <div className="gateway">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="panel">
          <h3>Company</h3>
          <div className="info-grid">
            <span className="l">Name</span><b>{c.name}</b>
            <span className="l">GSTIN</span><span>{c.gstin || <span className="tag warn">Not set (F3)</span>}</span>
            <span className="l">Current period</span><span>{shortDate(c.fy.start)} to {shortDate(c.fy.end)}</span>
            <span className="l">Current date</span><span>{shortDate(nav.workDate)}</span>
            <span className="l">Books from</span><span>{shortDate(c.books_from)}</span>
          </div>
        </div>
        {alerts && (
          <div className="panel" aria-label="Today's alerts">
            <h3>Needs attention</h3>
            <div className="cards" style={{ padding: 12, marginBottom: 0 }}>
              <button className={`card ${alerts.overdue.length ? 'bad' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={go('alerts')}>
                <div className="subtle">Overdue from retailers</div>
                <div className="v">₹{formatINR(alerts.overdueTotal)}</div>
                <div className="subtle">{alerts.overdue.length} bills</div>
              </button>
              <button className={`card ${alerts.msmePayables.length ? 'warn' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={go('alerts')}>
                <div className="subtle">MSME suppliers to pay soon</div>
                <div className="v">{alerts.msmePayables.length}</div>
                <div className="subtle">Section 43B(h)</div>
              </button>
              <button className={`card ${alerts.expiringBatches.length ? 'warn' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={go('alerts')}>
                <div className="subtle">Batches near expiry</div>
                <div className="v">{alerts.expiringBatches.length}</div>
                <div className="subtle">within {c.expiry_alert_days} days</div>
              </button>
              <button className={`card ${alerts.lowStock.length ? 'warn' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={go('stock-summary')}>
                <div className="subtle">Items at reorder level</div>
                <div className="v">{alerts.lowStock.length}</div>
              </button>
            </div>
          </div>
        )}
      </div>
      <Menu
        title="Gateway of Stockwell"
        entries={[
          { section: 'Masters' },
          { label: 'Create', run: go('create-menu') },
          ...(owner ? [{ label: 'Alter', hot: 'A', run: go('alter-menu') }] : []),
          { label: 'Chart of Accounts', hot: 'H', run: go('master-list', { kind: 'ledger', mode: 'view' }) },
          { section: 'Transactions' },
          { label: 'Vouchers', hot: 'V', run: go('voucher', { type: 'sales' }) },
          { label: 'Day Book', hot: 'K', run: go('day-book') },
          { section: 'Utilities' },
          ...(owner ? [{ label: 'Import from Tally', hot: 'I', run: go('import-tally') }] : []),
          { label: 'Backup', hot: 'U', run: go('backup') },
          { section: 'Reports' },
          ...(owner ? [{ label: 'Balance Sheet', hot: 'B', run: go('balance-sheet') }, { label: 'Profit & Loss A/c', hot: 'P', run: go('profit-loss') }] : []),
          { label: 'Stock Summary', hot: 'S', run: go('stock-summary') },
          { label: 'Outstandings', hot: 'O', run: go('outstanding', { kind: 'receivable' }) },
          { label: 'Alerts & Reminders', hot: 'L', run: go('alerts') },
          { label: 'GST Returns & e-Way Bills', hot: 'G', run: go('gst') },
          { label: 'Display More Reports', hot: 'D', run: go('reports-menu') },
          ...(owner ? [{ gap: true as const }, { label: 'Company Settings', hot: 'Y', run: go('company') }] : []),
        ]}
      />
    </div>
  );
}

export function CreateMenu() {
  const nav = useNav();
  const go = (name: string, props?: any) => () => nav.push({ name, props });
  return (
    <div style={{ padding: 24 }}>
      <Menu title="Create" entries={[
        { section: 'Accounting masters' },
        { label: 'Ledger', run: go('ledger-form') },
        { label: 'Group', run: go('group-form') },
        { section: 'Inventory masters' },
        { label: 'Stock Item', hot: 'I', run: go('item-form') },
        { label: 'Stock Group (Company / Brand)', hot: 'S', run: go('stock-group-form') },
        { label: 'Unit', run: go('unit-form') },
      ]} />
    </div>
  );
}

export function AlterMenu() {
  const nav = useNav();
  const go = (kind: string) => () => nav.push({ name: 'master-list', props: { kind, mode: 'alter' } });
  return (
    <div style={{ padding: 24 }}>
      <Menu title="Alter" entries={[
        { section: 'Accounting masters' },
        { label: 'Ledger', run: go('ledger') },
        { section: 'Inventory masters' },
        { label: 'Stock Item', hot: 'I', run: go('item') },
      ]} />
    </div>
  );
}

export function ReportsMenu() {
  const nav = useNav();
  const owner = isOwner(nav);
  const go = (name: string, props?: any) => () => nav.push({ name, props });
  return (
    <div style={{ padding: 24 }}>
      <Menu title="Display More Reports" entries={[
        { section: 'Accounts' },
        ...(owner ? [{ label: 'Trial Balance', run: go('trial-balance') }] : []),
        { label: 'Day Book', hot: 'D', run: go('day-book') },
        { label: 'Ledger', hot: 'L', run: go('master-list', { kind: 'ledger', mode: 'report' }) },
        { label: 'Receivables (Outstandings)', hot: 'R', run: go('outstanding', { kind: 'receivable' }) },
        { label: 'Payables (Outstandings)', hot: 'P', run: go('outstanding', { kind: 'payable' }) },
        { section: 'Inventory' },
        { label: 'Stock Summary', hot: 'S', run: go('stock-summary') },
        { label: 'Expiry & Alerts', hot: 'E', run: go('alerts') },
        { section: 'Statutory' },
        { label: 'GST Returns & e-Way Bills', hot: 'G', run: go('gst') },
        ...(owner ? [{ label: 'Edit Log (Audit trail)', hot: 'A', run: go('audit') }] : []),
      ]} />
    </div>
  );
}

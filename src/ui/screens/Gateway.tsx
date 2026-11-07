import { useEffect, useState } from 'react';
import { api } from '../api';
import { Menu, MenuEntry } from '../components/Menu';
import { isOwner, useBooksVersion, useNav } from '../nav';
import { formatINR, shortDate } from '../format';

/** Owner-only menu entries: shown to an Owner; for a Billing operator they are hidden, but their key says why. */
function useOwnerOnly() {
  const nav = useNav();
  const owner = isOwner(nav);
  return (entries: MenuEntry[]): MenuEntry[] => owner ? entries
    : entries.flatMap((e) => ('label' in e && e.hot ? [{ ...e, hidden: true, run: () => nav.toast(`${e.label} is for the Owner only.`, true) }] : []));
}

export function Gateway({ active }: { active: boolean }) {
  const nav = useNav();
  const [alerts, setAlerts] = useState<any>(null);
  useEffect(() => {
    if (active) api.get(`/api/reports/alerts?asOf=${nav.workDate}`).then(setAlerts).catch(() => setAlerts(null));
  }, [active, nav.workDate, useBooksVersion()]);
  const go = (name: string, props?: any) => () => nav.push({ name, props });
  const c = nav.company;
  const ownerOnly = useOwnerOnly();

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
            {alerts?.backup && isOwner(nav) && (
              <>
                <span className="l">Last backup</span>
                <span>
                  {alerts.backup.last ? new Date(alerts.backup.last).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Never'}
                  {alerts.backup.cloudSet ? (alerts.backup.lastCloud ? ' · cloud copy too' : ' · no cloud copy yet') : ''}
                  {(alerts.backup.stale || alerts.backup.error) && <> <button className="tag bad linkish" onClick={go('backup')} title={alerts.backup.error || ''}>Check backup</button></>}
                </span>
              </>
            )}
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
          ...ownerOnly([{ label: 'Alter', hot: 'A', run: go('alter-menu') }]),
          { label: 'Chart of Accounts', hot: 'H', run: go('master-list', { kind: 'ledger', mode: 'view' }) },
          { section: 'Transactions' },
          { label: 'Vouchers', hot: 'V', run: go('voucher', { type: 'sales' }) },
          { label: 'Day Book', hot: 'K', run: go('day-book') },
          { section: 'Utilities' },
          { label: 'Select Company', hot: 'T', run: go('companies') },
          ...ownerOnly([{ label: 'Import from Tally', hot: 'I', run: go('import-tally') }, { label: 'Export to Tally (XML)', hot: 'X', run: go('export-companies') }]),
          ...ownerOnly([{ label: 'Backup', hot: 'U', run: go('backup') }]),
          { section: 'Reports' },
          ...ownerOnly([{ label: 'Balance Sheet', hot: 'B', run: go('balance-sheet') }, { label: 'Profit & Loss A/c', hot: 'P', run: go('profit-loss') }]),
          { label: 'Stock Summary', hot: 'S', run: go('stock-summary') },
          { label: 'Outstandings', hot: 'O', run: go('outstanding', { kind: 'receivable' }) },
          { label: 'Alerts & Reminders', hot: 'L', run: go('alerts') },
          { label: 'GST Returns & e-Way Bills', hot: 'G', run: go('gst') },
          { label: 'Display More Reports', hot: 'D', run: go('reports-menu') },
          ...ownerOnly([{ gap: true as const }, { label: 'Company Settings', hot: 'Y', run: go('company') }]),
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
        { label: 'Godown', hot: 'D', run: go('godowns') },
        { section: 'Sales team' },
        { label: 'Salesman', hot: 'M', run: go('salesman-form') },
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
        { label: 'GST rate of many items', hot: 'G', run: () => nav.push({ name: 'gst-rate' }) },
        { label: 'Godowns', hot: 'D', run: () => nav.push({ name: 'godowns' }) },
        { section: 'Sales team' },
        { label: 'Salesmen', hot: 'M', run: () => nav.push({ name: 'salesmen' }) },
      ]} />
    </div>
  );
}

export function ReportsMenu() {
  const nav = useNav();
  const ownerOnly = useOwnerOnly();
  const go = (name: string, props?: any) => () => nav.push({ name, props });
  return (
    <div style={{ padding: 24 }}>
      <Menu title="Display More Reports" entries={[
        { section: 'Accounts' },
        ...ownerOnly([{ label: 'Trial Balance', run: go('trial-balance') }]),
        { label: 'Day Book', hot: 'D', run: go('day-book') },
        { label: 'Ledger', hot: 'L', run: go('master-list', { kind: 'ledger', mode: 'report' }) },
        { label: 'Receivables (Outstandings)', hot: 'R', run: go('outstanding', { kind: 'receivable' }) },
        { label: 'Payables (Outstandings)', hot: 'P', run: go('outstanding', { kind: 'payable' }) },
        { label: 'Sales Register', hot: 'I', run: go('register', { type: 'sales' }) },
        { label: 'Purchase Register', hot: 'U', run: go('register', { type: 'purchase' }) },
        { label: 'Sales Analysis (Salesman / Area / Item / Month)', hot: 'B', run: go('sales-analysis') },
        { label: 'Post-dated Cheques', hot: 'Q', run: go('pdc') },
        ...ownerOnly([{ label: 'Bank Reconciliation', hot: 'K', run: go('bank-reco') }]),
        { section: 'Inventory' },
        { label: 'Stock Summary', hot: 'S', run: go('stock-summary') },
        { label: 'Godown Summary', hot: 'W', run: go('godown-stock') },
        { label: 'Expiry & Alerts', hot: 'E', run: go('alerts') },
        { label: 'Scheme Claims (free goods)', hot: 'C', run: go('scheme-claims') },
        { label: 'Orders and Notes Pending', hot: 'O', run: go('pending-orders', { kind: 'sales' }) },
        { section: 'Statutory' },
        { label: 'GST Returns & e-Way Bills', hot: 'G', run: go('gst') },
        ...ownerOnly([{ label: 'GSTR-2B Reconciliation', hot: '2', run: go('gstr2b') }, { label: 'TDS Register', hot: 'T', run: go('tds') }]),
        ...ownerOnly([{ label: 'Edit Log (Audit trail)', hot: 'A', run: go('audit') }]),
      ]} />
    </div>
  );
}

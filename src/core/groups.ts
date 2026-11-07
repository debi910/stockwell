// Standard Indian chart of account groups. Nature decides where a group shows in the statements.

export type Nature = 'asset' | 'liability' | 'income' | 'expense';

export interface GroupSeed {
  name: string;
  parent: string | null;
  nature: Nature;
  /** Income/expense groups that sit above Gross Profit in the P&L (trading section). */
  direct?: boolean;
}

export const DEFAULT_GROUPS: GroupSeed[] = [
  { name: 'Capital Account', parent: null, nature: 'liability' },
  { name: 'Current Assets', parent: null, nature: 'asset' },
  { name: 'Current Liabilities', parent: null, nature: 'liability' },
  { name: 'Direct Expenses', parent: null, nature: 'expense', direct: true },
  { name: 'Direct Incomes', parent: null, nature: 'income', direct: true },
  { name: 'Fixed Assets', parent: null, nature: 'asset' },
  { name: 'Indirect Expenses', parent: null, nature: 'expense' },
  { name: 'Indirect Incomes', parent: null, nature: 'income' },
  { name: 'Investments', parent: null, nature: 'asset' },
  { name: 'Loans (Liability)', parent: null, nature: 'liability' },
  { name: 'Misc. Expenses (ASSET)', parent: null, nature: 'asset' },
  { name: 'Purchase Accounts', parent: null, nature: 'expense', direct: true },
  { name: 'Sales Accounts', parent: null, nature: 'income', direct: true },
  { name: 'Suspense A/c', parent: null, nature: 'liability' },
  { name: 'Branch/Divisions', parent: null, nature: 'liability' },
  { name: 'Reserves & Surplus', parent: 'Capital Account', nature: 'liability' },
  { name: 'Bank Accounts', parent: 'Current Assets', nature: 'asset' },
  { name: 'Cash-in-Hand', parent: 'Current Assets', nature: 'asset' },
  { name: 'Deposits (Asset)', parent: 'Current Assets', nature: 'asset' },
  { name: 'Loans & Advances (Asset)', parent: 'Current Assets', nature: 'asset' },
  { name: 'Stock-in-Hand', parent: 'Current Assets', nature: 'asset' },
  { name: 'Sundry Debtors', parent: 'Current Assets', nature: 'asset' },
  { name: 'Duties & Taxes', parent: 'Current Liabilities', nature: 'liability' },
  { name: 'Provisions', parent: 'Current Liabilities', nature: 'liability' },
  { name: 'Sundry Creditors', parent: 'Current Liabilities', nature: 'liability' },
  { name: 'Bank OD A/c', parent: 'Loans (Liability)', nature: 'liability' },
  { name: 'Secured Loans', parent: 'Loans (Liability)', nature: 'liability' },
  { name: 'Unsecured Loans', parent: 'Loans (Liability)', nature: 'liability' },
];

export interface LedgerSeed {
  name: string;
  group: string;
  taxKind?: 'cgst' | 'sgst' | 'igst' | 'roundoff';
}

export const DEFAULT_LEDGERS: LedgerSeed[] = [
  { name: 'Cash', group: 'Cash-in-Hand' },
  { name: 'Sales', group: 'Sales Accounts' },
  { name: 'Purchase', group: 'Purchase Accounts' },
  { name: 'CGST', group: 'Duties & Taxes', taxKind: 'cgst' },
  { name: 'SGST', group: 'Duties & Taxes', taxKind: 'sgst' },
  { name: 'IGST', group: 'Duties & Taxes', taxKind: 'igst' },
  { name: 'Round Off', group: 'Indirect Expenses', taxKind: 'roundoff' },
];

export const DEFAULT_UNITS = [
  { symbol: 'Pcs', name: 'Pieces', uqc: 'PCS' },
  { symbol: 'Box', name: 'Box', uqc: 'BOX' },
  { symbol: 'Case', name: 'Case', uqc: 'CTN' },
  { symbol: 'Kg', name: 'Kilograms', uqc: 'KGS' },
  { symbol: 'Ltr', name: 'Litres', uqc: 'LTR' },
  { symbol: 'Pkt', name: 'Packets', uqc: 'PAC' },
];

import type { ComponentType } from 'react';
import type { Screen } from '../nav';
import { AlterMenu, CreateMenu, Gateway, ReportsMenu } from './Gateway';
import { GroupForm, ItemForm, LedgerForm, MasterList, StockGroupForm, UnitForm } from './Masters';
import { STOCK_TYPES, VoucherForm } from './Voucher';
import { StockVoucherForm } from './StockVoucher';
import { GoTo, VoucherTypesMenu } from './GoTo';
import { createElement } from 'react';

/** Stock Journal and Physical Stock have their own layout; every other type uses the invoice or accounting layout. */
const VoucherScreen = (p: any) => createElement(STOCK_TYPES.includes(p.type) ? StockVoucherForm : VoucherForm, p);
import { Alerts, AuditLog, BalanceSheet, DayBook, GroupSummary, LedgerReport, Outstanding, ProfitLoss, StockSummary, TrialBalance } from './Reports';
import { BackupScreen, CompanySettings, GstScreen, ImportTally, UsersScreen } from './Settings';
import { VOUCHER_LABEL } from '../format';

export const SCREENS: Record<string, ComponentType<any>> = {
  gateway: Gateway,
  'create-menu': CreateMenu,
  'alter-menu': AlterMenu,
  'reports-menu': ReportsMenu,
  'ledger-form': LedgerForm,
  'item-form': ItemForm,
  'group-form': GroupForm,
  'stock-group-form': StockGroupForm,
  'unit-form': UnitForm,
  'master-list': MasterList,
  voucher: VoucherScreen,
  'voucher-types': VoucherTypesMenu,
  goto: GoTo,
  'day-book': DayBook,
  'trial-balance': TrialBalance,
  'group-summary': GroupSummary,
  'profit-loss': ProfitLoss,
  'balance-sheet': BalanceSheet,
  'ledger-report': LedgerReport,
  'stock-summary': StockSummary,
  outstanding: Outstanding,
  alerts: Alerts,
  audit: AuditLog,
  gst: GstScreen,
  company: CompanySettings,
  users: UsersScreen,
  'import-tally': ImportTally,
  backup: BackupScreen,
};

const TITLES: Record<string, string> = {
  gateway: 'Gateway of Stockwell', 'create-menu': 'Create', 'alter-menu': 'Alter', 'reports-menu': 'Display More Reports',
  'ledger-form': 'Ledger', 'item-form': 'Stock Item', 'group-form': 'Group', 'stock-group-form': 'Stock Group', 'unit-form': 'Unit',
  'master-list': 'List of Masters', 'day-book': 'Day Book', 'trial-balance': 'Trial Balance', 'group-summary': 'Group Summary',
  'profit-loss': 'Profit & Loss A/c', 'balance-sheet': 'Balance Sheet', 'ledger-report': 'Ledger Vouchers', 'stock-summary': 'Stock Summary',
  outstanding: 'Outstandings', alerts: 'Alerts & Reminders', audit: 'Edit Log', gst: 'GST Returns', company: 'Company',
  users: 'Users and Passwords', 'import-tally': 'Import from Tally', backup: 'Backup',
  'voucher-types': 'Change Voucher Type', goto: 'Go To',
};

export function screenTitle(s: Screen): string {
  if (s.name === 'voucher') return `${VOUCHER_LABEL[s.props?.type] ?? 'Voucher'} Voucher`;
  return TITLES[s.name] ?? s.name;
}

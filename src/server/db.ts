import Database from 'better-sqlite3';
import { parseDate } from '../core/dates';

/** dd-mm-yy or dd-mm-yyyy as typed into an early build; a two-digit year is 20yy. */
function parseExpiry(t: string): string | null {
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t.trim());
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return parseDate(`${m[1]}-${m[2]}-${y}`);
}
import { DEFAULT_GROUPS, DEFAULT_LEDGERS, DEFAULT_UNITS } from '../core/groups';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL DEFAULT 'My Company',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  pincode TEXT DEFAULT '',
  state_code TEXT NOT NULL DEFAULT '21',
  gstin TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  upi_id TEXT DEFAULT '',
  bank_details TEXT DEFAULT '',
  books_from TEXT NOT NULL DEFAULT '2026-04-01',
  ewb_threshold INTEGER NOT NULL DEFAULT 5000000,
  udyam_no TEXT DEFAULT '',
  msme_interest_rate REAL DEFAULT 0,
  expiry_alert_days INTEGER NOT NULL DEFAULT 30,
  invoice_terms TEXT DEFAULT 'Goods once sold will not be taken back. Subject to local jurisdiction.',
  backup_dir TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parent_id INTEGER REFERENCES groups(id),
  nature TEXT NOT NULL CHECK (nature IN ('asset','liability','income','expense')),
  direct INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledgers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  opening INTEGER NOT NULL DEFAULT 0,
  gstin TEXT DEFAULT '',
  state_code TEXT DEFAULT '',
  address TEXT DEFAULT '',
  city TEXT DEFAULT '',
  pincode TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  credit_days INTEGER DEFAULT 0,
  beat TEXT DEFAULT '',
  salesman TEXT DEFAULT '',
  msme_supplier INTEGER NOT NULL DEFAULT 0,
  msme_buyer INTEGER NOT NULL DEFAULT 0,
  udyam_no TEXT DEFAULT '',
  tax_kind TEXT DEFAULT NULL,
  builtin INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  uqc TEXT NOT NULL DEFAULT 'OTH'
);

CREATE TABLE IF NOT EXISTS stock_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  stock_group_id INTEGER REFERENCES stock_groups(id),
  unit_id INTEGER NOT NULL REFERENCES units(id),
  hsn TEXT DEFAULT '',
  gst_rate REAL NOT NULL DEFAULT 0,
  mrp INTEGER DEFAULT 0,
  sale_rate INTEGER DEFAULT 0,
  purchase_rate INTEGER DEFAULT 0,
  track_batch INTEGER NOT NULL DEFAULT 0,
  reorder_level REAL DEFAULT 0,
  scheme_buy REAL DEFAULT 0,
  scheme_free REAL DEFAULT 0,
  opening_qty REAL NOT NULL DEFAULT 0,
  opening_value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_no TEXT NOT NULL,
  mfg_date TEXT DEFAULT NULL,
  expiry_date TEXT DEFAULT NULL,
  mrp INTEGER DEFAULT 0,
  opening_qty REAL NOT NULL DEFAULT 0,
  UNIQUE (item_id, batch_no)
);

CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  seq INTEGER NOT NULL,
  date TEXT NOT NULL,
  party_id INTEGER REFERENCES ledgers(id),
  account_id INTEGER REFERENCES ledgers(id),
  narration TEXT DEFAULT '',
  place_of_supply TEXT DEFAULT NULL,
  intra INTEGER NOT NULL DEFAULT 1,
  taxable INTEGER NOT NULL DEFAULT 0,
  cgst INTEGER NOT NULL DEFAULT 0,
  sgst INTEGER NOT NULL DEFAULT 0,
  igst INTEGER NOT NULL DEFAULT 0,
  round_off INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  ref_no TEXT DEFAULT '',
  ref_date TEXT DEFAULT NULL,
  vehicle_no TEXT DEFAULT '',
  distance_km INTEGER DEFAULT 0,
  transporter_name TEXT DEFAULT '',
  transporter_id TEXT DEFAULT '',
  ewb_no TEXT DEFAULT '',
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS vouchers_date ON vouchers(date);
CREATE UNIQUE INDEX IF NOT EXISTS vouchers_number ON vouchers(type, number);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
  amount INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_ledger ON entries(ledger_id);
CREATE INDEX IF NOT EXISTS entries_voucher ON entries(voucher_id);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  item_id INTEGER NOT NULL REFERENCES items(id),
  batch_id INTEGER REFERENCES batches(id),
  qty REAL NOT NULL,
  free_qty REAL NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL,
  discount_pct REAL NOT NULL DEFAULT 0,
  gst_rate REAL NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL,
  cgst INTEGER NOT NULL DEFAULT 0,
  sgst INTEGER NOT NULL DEFAULT 0,
  igst INTEGER NOT NULL DEFAULT 0,
  direction INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inventory_item ON inventory(item_id);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY,
  voucher_id INTEGER REFERENCES vouchers(id) ON DELETE CASCADE,
  ledger_id INTEGER NOT NULL REFERENCES ledgers(id),
  ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('new','agst','onacc')),
  amount INTEGER NOT NULL,
  date TEXT NOT NULL,
  due_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bills_ledger ON bills(ledger_id, ref);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  data TEXT,
  user_name TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner','operator')),
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // Refuse to open a damaged file rather than build new entries on top of it.
  const check = db.pragma('quick_check', { simple: true });
  if (check !== 'ok') {
    db.close();
    throw new Error(`The books file looks damaged (${check}). Restore the latest backup before using Stockwell.`);
  }
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

/** Small upgrades for databases made by older versions. */
function migrate(db: DB) {
  const add = (table: string, column: string, def: string) => {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  };
  add('audit', 'user_name', 'TEXT');
  // taxable | nil | exempt | nongst: how a 0% line is reported in GSTR-1 Table 8 and GSTR-3B 3.1(c)/(e).
  add('items', 'taxability', "TEXT NOT NULL DEFAULT 'taxable'");
  // The party's GSTIN and state as they were on the bill, so old returns never change when a master is edited.
  add('vouchers', 'party_gstin', "TEXT NOT NULL DEFAULT ''");
  add('vouchers', 'party_state', "TEXT NOT NULL DEFAULT ''");
  add('company', 'allow_negative_stock', 'INTEGER NOT NULL DEFAULT 0');
  add('company', 'last_backup', "TEXT NOT NULL DEFAULT ''");
  add('vouchers', 'client_key', 'TEXT');
  // Early builds stored an opening batch expiry exactly as typed (e.g. 15-12-26); turn those into real dates.
  for (const b of db.prepare(`SELECT id, expiry_date FROM batches WHERE expiry_date IS NOT NULL AND expiry_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`).all() as { id: number; expiry_date: string }[]) {
    db.prepare(`UPDATE batches SET expiry_date=? WHERE id=?`).run(parseExpiry(b.expiry_date), b.id);
  }
  // Group names exactly as TallyPrime spells them, so Tally imports and staff habits line up.
  db.prepare(`UPDATE groups SET name='Branch/Divisions' WHERE name='Branch / Divisions'`).run();
  db.prepare(`UPDATE groups SET name='Misc. Expenses (ASSET)' WHERE name='Misc. Expenses (Asset)'`).run();
  // ---- v0.2: the rest of TallyPrime's features ----
  add('vouchers', 'mode', "TEXT NOT NULL DEFAULT 'item'"); // item | accounting (Ctrl+H "as voucher")
  add('vouchers', 'optional', 'INTEGER NOT NULL DEFAULT 0'); // Ctrl+L: kept out of the books until made regular
  add('vouchers', 'pdc', 'INTEGER NOT NULL DEFAULT 0'); // Ctrl+T post-dated
  add('vouchers', 'cheque_no', "TEXT NOT NULL DEFAULT ''");
  add('vouchers', 'cheque_date', 'TEXT DEFAULT NULL');
  add('vouchers', 'bank_name', "TEXT NOT NULL DEFAULT ''");
  add('vouchers', 'bank_date', 'TEXT DEFAULT NULL'); // bank reconciliation
  add('vouchers', 'against_id', 'INTEGER DEFAULT NULL'); // order or delivery/receipt note this voucher follows
  add('vouchers', 'bounce_of', 'INTEGER DEFAULT NULL'); // a cheque-bounce journal points at its receipt
  add('vouchers', 'bounced_by', 'INTEGER DEFAULT NULL');
  add('vouchers', 'charges', 'INTEGER NOT NULL DEFAULT 0'); // freight, discount and other bill lines, net
  add('inventory', 'godown_id', 'INTEGER DEFAULT NULL'); // NULL = Main Location
  add('inventory', 'alt_qty', 'REAL DEFAULT NULL'); // quantity as typed in the alternate unit
  add('inventory', 'base_taxable', 'INTEGER DEFAULT NULL'); // before freight/discount spread over the lines
  add('items', 'alt_unit_id', 'INTEGER DEFAULT NULL');
  add('items', 'alt_conv', 'REAL NOT NULL DEFAULT 0'); // base units in one alternate unit, e.g. 24 Pcs in a Case
  add('ledgers', 'credit_limit', 'INTEGER NOT NULL DEFAULT 0');
  add('ledgers', 'block_overdue', 'INTEGER NOT NULL DEFAULT 0');
  add('ledgers', 'price_level', "TEXT NOT NULL DEFAULT ''");
  add('ledgers', 'assessable', 'INTEGER NOT NULL DEFAULT 0'); // freight etc.: include in the GST taxable value
  add('ledgers', 'tds_section', "TEXT NOT NULL DEFAULT ''");
  add('ledgers', 'tds_rate', 'REAL NOT NULL DEFAULT 0');
  add('company', 'gst_filing', "TEXT NOT NULL DEFAULT 'monthly'"); // monthly | quarterly (QRMP)
  add('company', 'price_levels', "TEXT NOT NULL DEFAULT ''"); // comma separated, e.g. Wholesale, Retail
  db.exec(`
    CREATE TABLE IF NOT EXISTS godowns (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    INSERT OR IGNORE INTO godowns (id, name) VALUES (1, 'Main Location');
    CREATE TABLE IF NOT EXISTS tax_lines (
      id INTEGER PRIMARY KEY, voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE, line_no INTEGER NOT NULL,
      ledger_id INTEGER NOT NULL REFERENCES ledgers(id), hsn TEXT NOT NULL DEFAULT '', gst_rate REAL NOT NULL DEFAULT 0,
      taxable INTEGER NOT NULL, cgst INTEGER NOT NULL DEFAULT 0, sgst INTEGER NOT NULL DEFAULT 0, igst INTEGER NOT NULL DEFAULT 0,
      taxability TEXT NOT NULL DEFAULT 'taxable');
    CREATE INDEX IF NOT EXISTS tax_lines_voucher ON tax_lines(voucher_id);
    CREATE TABLE IF NOT EXISTS voucher_charges (
      id INTEGER PRIMARY KEY, voucher_id INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE, line_no INTEGER NOT NULL,
      ledger_id INTEGER NOT NULL REFERENCES ledgers(id), amount INTEGER NOT NULL, assessable INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS voucher_charges_voucher ON voucher_charges(voucher_id);
    CREATE TABLE IF NOT EXISTS item_gst_rates (
      id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, from_date TEXT NOT NULL, gst_rate REAL NOT NULL,
      UNIQUE (item_id, from_date));
    CREATE TABLE IF NOT EXISTS price_list (
      item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE, level TEXT NOT NULL COLLATE NOCASE, rate INTEGER NOT NULL,
      PRIMARY KEY (item_id, level));
    CREATE INDEX IF NOT EXISTS vouchers_against ON vouchers(against_id);
    DROP VIEW IF EXISTS gst_lines;
    CREATE VIEW gst_lines AS
      SELECT iv.voucher_id, iv.line_no, iv.item_id, i.hsn, i.name AS item_name, u.uqc, iv.qty, iv.free_qty, iv.gst_rate,
        iv.taxable, iv.cgst, iv.sgst, iv.igst, i.taxability
      FROM inventory iv JOIN items i ON i.id=iv.item_id JOIN units u ON u.id=i.unit_id
      UNION ALL
      SELECT t.voucher_id, 1000 + t.line_no, NULL, t.hsn, l.name, 'NA', 0, 0, t.gst_rate, t.taxable, t.cgst, t.sgst, t.igst, t.taxability
      FROM tax_lines t JOIN ledgers l ON l.id=t.ledger_id WHERE t.taxability<>'outside';
  `);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS vouchers_client_key ON vouchers(client_key) WHERE client_key IS NOT NULL`);
  db.exec(`UPDATE vouchers SET party_gstin=COALESCE((SELECT gstin FROM ledgers WHERE id=vouchers.party_id),''),
    party_state=COALESCE(place_of_supply,'') WHERE party_gstin='' AND party_state='' AND party_id IS NOT NULL`);
}

function seed(db: DB) {
  const done = db.prepare(`SELECT value FROM meta WHERE key='seeded'`).get();
  if (done) return;
  const tx = db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO company (id) VALUES (1)`).run();
    const insGroup = db.prepare(`INSERT INTO groups (name, parent_id, nature, direct, builtin) VALUES (?, ?, ?, ?, 1)`);
    const idOf = (name: string) => (db.prepare(`SELECT id FROM groups WHERE name=?`).get(name) as { id: number }).id;
    for (const g of DEFAULT_GROUPS) {
      insGroup.run(g.name, g.parent ? idOf(g.parent) : null, g.nature, g.direct ? 1 : 0);
    }
    const insLedger = db.prepare(`INSERT INTO ledgers (name, group_id, tax_kind, builtin) VALUES (?, ?, ?, 1)`);
    for (const l of DEFAULT_LEDGERS) insLedger.run(l.name, idOf(l.group), l.taxKind ?? null);
    const insUnit = db.prepare(`INSERT INTO units (symbol, name, uqc) VALUES (?, ?, ?)`);
    for (const u of DEFAULT_UNITS) insUnit.run(u.symbol, u.name, u.uqc);
    db.prepare(`INSERT INTO meta (key, value) VALUES ('seeded', '1'), ('schema_version', '1')`).run();
  });
  tx();
}

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = join(ROOT, "data");
const DB_PATH = join(DATA_DIR, "ledger.db");

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS items (
    item_id           TEXT PRIMARY KEY,
    access_token      TEXT NOT NULL,
    institution_id    TEXT,
    institution_name  TEXT,
    cursor            TEXT,
    last_synced_at    TEXT,
    last_error        TEXT,
    created_at        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS accounts (
    account_id     TEXT PRIMARY KEY,
    item_id        TEXT NOT NULL,
    name           TEXT,
    official_name  TEXT,
    mask           TEXT,
    type           TEXT,
    subtype        TEXT,
    enabled        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS transactions (
    transaction_id  TEXT PRIMARY KEY,
    account_id      TEXT,
    item_id         TEXT,
    date            TEXT NOT NULL,
    month           TEXT NOT NULL,
    name            TEXT NOT NULL,
    merchant        TEXT NOT NULL,
    amount          REAL NOT NULL,          -- positive = money out of the account
    currency        TEXT,
    kind            TEXT NOT NULL,          -- spend | transfer | income
    pfc_primary     TEXT,
    pfc_detailed    TEXT,
    category        TEXT NOT NULL,
    category_source TEXT NOT NULL DEFAULT 'auto',  -- auto | user
    pending         INTEGER NOT NULL DEFAULT 0,
    channel         TEXT,
    source          TEXT NOT NULL DEFAULT 'plaid',  -- plaid | manual | csv
    hidden          INTEGER NOT NULL DEFAULT 0,
    fixed           INTEGER NOT NULL DEFAULT 0,     -- rent/loans/insurance
    logo_url        TEXT,                           -- merchant logo, from Plaid
    website         TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_txn_month ON transactions(month);
  CREATE INDEX IF NOT EXISTS idx_txn_date  ON transactions(date);

  CREATE TABLE IF NOT EXISTS rules (
    merchant_key TEXT PRIMARY KEY,
    category     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Our own tally of Plaid API calls, so a 200-call Limited Production budget
  -- can't be burned through unnoticed. Counts ATTEMPTS, which errs high.
  CREATE TABLE IF NOT EXISTS api_usage (
    endpoint TEXT PRIMARY KEY,
    product  TEXT NOT NULL,
    calls    INTEGER NOT NULL DEFAULT 0,
    last_at  TEXT
  );
`);

// The access tokens in here are bearer credentials for bank data. Keep the file
// readable only by this user.
try { chmodSync(DB_PATH, 0o600); } catch { /* best effort */ }

/*
 * Migrations. Sync is incremental, so a database filled before a rule changed
 * would otherwise keep the old answer forever — Plaid returns no changes
 * against a stored cursor. Backfill in place instead of forcing a re-pull.
 */
{
  const cols = db.prepare(`PRAGMA table_info(transactions)`).all().map((c) => c.name);

  if (!cols.includes("logo_url")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN logo_url TEXT`);
    db.exec(`ALTER TABLE transactions ADD COLUMN website TEXT`);
    console.log("[migrate] added logo_url/website (re-sync to populate)");
  }

  if (!cols.includes("fixed")) {
    db.exec(`ALTER TABLE transactions ADD COLUMN fixed INTEGER NOT NULL DEFAULT 0`);
    const n = db.prepare(`
      UPDATE transactions SET fixed = 1
      WHERE pfc_detailed IN ('RENT_AND_UTILITIES_RENT', 'GENERAL_SERVICES_INSURANCE')
         OR pfc_primary = 'LOAN_PAYMENTS'
    `).run();
    if (n.changes) console.log(`[migrate] flagged ${n.changes} fixed obligations`);
  }

  // Insurance was landing in "other" via the GENERAL_SERVICES catch-all.
  // Only move rows the user hasn't categorized by hand.
  const fix = db.prepare(`
    UPDATE transactions SET category = 'bills'
    WHERE pfc_detailed = 'GENERAL_SERVICES_INSURANCE'
      AND category <> 'bills' AND category_source = 'auto'
  `).run();
  if (fix.changes) console.log(`[migrate] moved ${fix.changes} insurance rows to Bills`);
}

const s = (v) => (v === undefined || v === null ? null : String(v));
const b = (v) => (v ? 1 : 0);

/* ---------------- items ---------------- */

export const items = {
  upsert({ item_id, access_token, institution_id, institution_name }) {
    db.prepare(`
      INSERT INTO items (item_id, access_token, institution_id, institution_name, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        access_token = excluded.access_token,
        institution_id = excluded.institution_id,
        institution_name = excluded.institution_name
    `).run(item_id, access_token, s(institution_id), s(institution_name), new Date().toISOString());
  },
  all() {
    return db.prepare(`SELECT * FROM items ORDER BY created_at`).all();
  },
  get(item_id) {
    return db.prepare(`SELECT * FROM items WHERE item_id = ?`).get(item_id) ?? null;
  },
  setCursor(item_id, cursor) {
    db.prepare(`UPDATE items SET cursor = ?, last_synced_at = ?, last_error = NULL WHERE item_id = ?`)
      .run(s(cursor), new Date().toISOString(), item_id);
  },
  setError(item_id, message) {
    db.prepare(`UPDATE items SET last_error = ? WHERE item_id = ?`).run(s(message), item_id);
  },
  remove(item_id) {
    db.prepare(`DELETE FROM transactions WHERE item_id = ?`).run(item_id);
    db.prepare(`DELETE FROM accounts WHERE item_id = ?`).run(item_id);
    db.prepare(`DELETE FROM items WHERE item_id = ?`).run(item_id);
  },
};

/* ---------------- accounts ---------------- */

export const accounts = {
  upsert(item_id, a) {
    db.prepare(`
      INSERT INTO accounts (account_id, item_id, name, official_name, mask, type, subtype)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        name = excluded.name,
        official_name = excluded.official_name,
        mask = excluded.mask,
        type = excluded.type,
        subtype = excluded.subtype
    `).run(a.account_id, item_id, s(a.name), s(a.official_name), s(a.mask), s(a.type), s(a.subtype));
  },
  all() {
    return db.prepare(`
      SELECT a.*, i.institution_name
      FROM accounts a LEFT JOIN items i ON i.item_id = a.item_id
      ORDER BY i.institution_name, a.name
    `).all();
  },
  setEnabled(account_id, enabled) {
    db.prepare(`UPDATE accounts SET enabled = ? WHERE account_id = ?`).run(b(enabled), account_id);
  },
};

/* ---------------- transactions ---------------- */

const UPSERT_TXN = `
  INSERT INTO transactions (
    transaction_id, account_id, item_id, date, month, name, merchant, amount, currency,
    kind, pfc_primary, pfc_detailed, category, category_source, pending, channel, source, hidden, fixed,
    logo_url, website
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(transaction_id) DO UPDATE SET
    date         = excluded.date,
    month        = excluded.month,
    name         = excluded.name,
    merchant     = excluded.merchant,
    amount       = excluded.amount,
    kind         = excluded.kind,
    pfc_primary  = excluded.pfc_primary,
    pfc_detailed = excluded.pfc_detailed,
    pending      = excluded.pending,
    channel      = excluded.channel,
    fixed        = excluded.fixed,
    logo_url     = COALESCE(excluded.logo_url, transactions.logo_url),
    website      = COALESCE(excluded.website,  transactions.website),
    -- a category the user set by hand always wins over a re-sync
    category        = CASE WHEN transactions.category_source = 'user'
                           THEN transactions.category ELSE excluded.category END,
    category_source = transactions.category_source
`;

export const transactions = {
  upsert(t) {
    db.prepare(UPSERT_TXN).run(
      t.transaction_id, s(t.account_id), s(t.item_id), t.date, t.date.slice(0, 7),
      t.name, t.merchant, t.amount, s(t.currency), t.kind,
      s(t.pfc_primary), s(t.pfc_detailed), t.category, t.category_source ?? "auto",
      b(t.pending), s(t.channel), t.source ?? "plaid", b(t.hidden), b(t.fixed),
      s(t.logo_url), s(t.website),
    );
  },
  remove(transaction_id) {
    db.prepare(`DELETE FROM transactions WHERE transaction_id = ?`).run(transaction_id);
  },
  exists(transaction_id) {
    return !!db.prepare(`SELECT 1 FROM transactions WHERE transaction_id = ?`).get(transaction_id);
  },
  /** Manual/CSV dedupe: same day, same merchant, same amount. */
  findDuplicate(date, merchant, amount) {
    return db.prepare(`
      SELECT transaction_id FROM transactions
      WHERE date = ? AND lower(merchant) = lower(?) AND abs(amount - ?) < 0.005
      LIMIT 1
    `).get(date, merchant, amount) ?? null;
  },
  byMonth(month) {
    return db.prepare(`
      SELECT t.*, a.name AS account_name, a.mask AS account_mask
      FROM transactions t
      LEFT JOIN accounts a ON a.account_id = t.account_id
      WHERE t.month = ? AND t.hidden = 0
        AND (t.account_id IS NULL OR a.enabled = 1)
      ORDER BY t.date DESC, t.amount DESC
    `).all(month);
  },
  /** Month totals for the nav + previous-month comparison. */
  monthTotals() {
    return db.prepare(`
      SELECT t.month, SUM(t.amount) AS total, COUNT(*) AS n
      FROM transactions t
      LEFT JOIN accounts a ON a.account_id = t.account_id
      WHERE t.hidden = 0 AND t.kind = 'spend'
        AND (t.account_id IS NULL OR a.enabled = 1)
      GROUP BY t.month ORDER BY t.month
    `).all();
  },
  setCategory(transaction_id, category) {
    db.prepare(`UPDATE transactions SET category = ?, category_source = 'user' WHERE transaction_id = ?`)
      .run(category, transaction_id);
  },
  /** Retro-apply a learned rule to everything from the same merchant. */
  applyRule(merchant_key, category) {
    db.prepare(`
      UPDATE transactions SET category = ?
      WHERE category_source = 'auto' AND lower(merchant) LIKE ?
    `).run(category, merchant_key.toLowerCase() + "%");
  },
  hide(transaction_id) {
    db.prepare(`UPDATE transactions SET hidden = 1 WHERE transaction_id = ?`).run(transaction_id);
  },
  get(transaction_id) {
    return db.prepare(`SELECT * FROM transactions WHERE transaction_id = ?`).get(transaction_id) ?? null;
  },
};

/* ---------------- rules & settings ---------------- */

export const rules = {
  all() {
    const out = {};
    for (const r of db.prepare(`SELECT * FROM rules`).all()) out[r.merchant_key] = r.category;
    return out;
  },
  set(merchant_key, category) {
    db.prepare(`
      INSERT INTO rules (merchant_key, category) VALUES (?, ?)
      ON CONFLICT(merchant_key) DO UPDATE SET category = excluded.category
    `).run(merchant_key, category);
  },
};

export const usage = {
  bump(endpoint, product) {
    db.prepare(`
      INSERT INTO api_usage (endpoint, product, calls, last_at) VALUES (?, ?, 1, ?)
      ON CONFLICT(endpoint) DO UPDATE SET
        calls = api_usage.calls + 1,
        last_at = excluded.last_at
    `).run(endpoint, product, new Date().toISOString());
  },
  /** Calls charged against one product so far. */
  forProduct(product) {
    const r = db.prepare(`SELECT COALESCE(SUM(calls),0) AS n FROM api_usage WHERE product = ?`).get(product);
    return Number(r?.n ?? 0);
  },
  breakdown() {
    return db.prepare(`SELECT endpoint, product, calls, last_at FROM api_usage ORDER BY calls DESC`).all();
  },
};

export const settings = {
  all() {
    const out = { budget: 0, includeTransfers: false, discretionaryOnly: true };
    for (const r of db.prepare(`SELECT * FROM settings`).all()) {
      try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
    }
    return out;
  },
  set(key, value) {
    db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, JSON.stringify(value));
  },
};

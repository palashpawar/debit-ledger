import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import { extract } from "./csv.js";

import { items, accounts, transactions, rules, settings } from "./db.js";
import { requireAuth, mountAuth, authConfigured } from "./auth.js";
import { CATS, CAT_IDS, categorize, merchantKey, cleanMerchant } from "./categorize.js";
import {
  plaidConfigured, plaidEnv, plaidError, usageReport, CALL_BUDGET,
  createLinkToken, exchangePublicToken, syncAll, removeItem,
} from "./plaid.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 4310;

const app = express();
app.use(express.json({ limit: "8mb" }));

// Order matters: this gate runs before express.static, otherwise index.html
// would be served to an unauthenticated visitor before any route is reached.
mountAuth(app);
app.use(requireAuth);
app.use(express.static(join(ROOT, "public")));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const thisMonth = () => new Date().toISOString().slice(0, 7);

/* ---------------------------- state ---------------------------- */

/** The month before `month`, as YYYY-MM. */
function prevMonth(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

app.get("/api/state", (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month ?? "") ? req.query.month : thisMonth();
  res.json({
    env: plaidEnv,
    configured: plaidConfigured,
    month,
    cats: CATS,
    items: items.all().map(({ access_token, ...rest }) => rest), // never leave the process
    accounts: accounts.all(),
    transactions: transactions.byMonth(month),
    prevTransactions: transactions.byMonth(prevMonth(month)),
    monthTotals: transactions.monthTotals(),
    usage: usageReport(),
    settings: settings.all(),
  });
});

/* ---------------------------- Plaid Link ---------------------------- */

app.post("/api/link/token", wrap(async (_req, res) => {
  if (!plaidConfigured) {
    return res.status(400).json({
      error: "Plaid keys are missing. Copy .env.example to .env and fill in PLAID_CLIENT_ID and PLAID_SECRET.",
    });
  }
  const u = usageReport();
  if (u.itemsFull) {
    return res.status(400).json({
      code: "ITEM_LIMIT_REACHED",
      error: `All ${u.itemLimit} Plaid Item slots are used. Disconnecting a bank does not give a slot back — ` +
             `you'd need a paid Production plan to connect more. CSV import still works.`,
      usage: u,
    });
  }
  try {
    res.json({ link_token: await createLinkToken() });
  } catch (err) {
    const e = plaidError(err);
    res.status(400).json({ error: e.message, code: e.code });
  }
}));

// Each sync spends at least one call from a budget that cannot be topped up,
// so a rapid second press is refused rather than silently charged.
const SYNC_MIN_INTERVAL_MS = 60_000;
let lastSyncAt = 0;

app.post("/api/link/exchange", wrap(async (req, res) => {
  const { public_token } = req.body ?? {};
  if (!public_token) return res.status(400).json({ error: "public_token is required" });
  try {
    const info = await exchangePublicToken(public_token);
    lastSyncAt = Date.now();
    const results = await syncAll();
    res.json({ ...info, sync: results, usage: usageReport() });
  } catch (err) {
    const e = plaidError(err);
    res.status(400).json({ error: e.message, code: e.code });
  }
}));

/** Plaid Link runs in its own iframe; this is how its events reach the log. */
app.post("/api/link/trace", (req, res) => {
  const { trace, outcome } = req.body ?? {};
  if (Array.isArray(trace)) {
    console.log(`\n[link trace] outcome=${outcome}`);
    for (const line of trace.slice(0, 60)) console.log("  " + String(line).slice(0, 300));
    console.log("");
  }
  res.json({ ok: true });
});

app.post("/api/sync", wrap(async (_req, res) => {
  if (!items.all().length) return res.json({ results: [], note: "No banks connected yet." });

  const u = usageReport();
  if (u.callsExhausted) {
    return res.status(429).json({
      code: "BUDGET_EXHAUSTED",
      error: `All ${CALL_BUDGET} Plaid Transactions calls are spent. Your data is still here — ` +
             `keep going with CSV import, or move to a paid Plaid plan.`,
      usage: u,
    });
  }

  // Plaid rate-limits /transactions/sync per Item, so a rapid second press
  // gains nothing even on a plan with unlimited calls.
  const since = Date.now() - lastSyncAt;
  if (since < SYNC_MIN_INTERVAL_MS) {
    const wait = Math.ceil((SYNC_MIN_INTERVAL_MS - since) / 1000);
    return res.status(429).json({
      code: "THROTTLED",
      error: `Synced moments ago — nothing will have changed yet. Try again in ${wait}s.`,
      usage: u,
    });
  }

  lastSyncAt = Date.now();
  res.json({ results: await syncAll(), usage: usageReport() });
}));

app.delete("/api/items/:id", wrap(async (req, res) => {
  const ok = await removeItem(req.params.id);
  res.status(ok ? 200 : 404).json({ ok });
}));

app.patch("/api/accounts/:id", (req, res) => {
  accounts.setEnabled(req.params.id, Boolean(req.body?.enabled));
  res.json({ ok: true });
});

/* ---------------------------- transactions ---------------------------- */

app.patch("/api/transactions/:id", (req, res) => {
  const { category } = req.body ?? {};
  if (!CAT_IDS.has(category)) return res.status(400).json({ error: "Unknown category" });

  const txn = transactions.get(req.params.id);
  if (!txn) return res.status(404).json({ error: "No such transaction" });

  transactions.setCategory(req.params.id, category);

  // Teach the rule, and retro-apply it to anything still auto-categorized.
  const key = merchantKey(txn.merchant);
  if (key) {
    rules.set(key, category);
    transactions.applyRule(key, category);
  }
  res.json({ ok: true, learned: key || null });
});

app.delete("/api/transactions/:id", (req, res) => {
  transactions.hide(req.params.id);
  res.json({ ok: true });
});

app.post("/api/transactions", (req, res) => {
  const { date, merchant, amount, category } = req.body ?? {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0)) return res.status(400).json({ error: "amount must be greater than zero" });
  const name = String(merchant ?? "").trim();
  if (!name) return res.status(400).json({ error: "merchant is required" });

  const chosen = CAT_IDS.has(category)
    ? category
    : categorize({ merchant: name, amount: amt }, rules.all()).category;

  const id = "manual_" + randomUUID();
  transactions.upsert({
    transaction_id: id, account_id: null, item_id: null, date, name, merchant: name,
    amount: amt, currency: "USD", kind: "spend", pfc_primary: null, pfc_detailed: null,
    category: chosen, category_source: CAT_IDS.has(category) ? "user" : "auto",
    pending: false, channel: "manual", source: "manual", hidden: false,
  });

  if (CAT_IDS.has(category)) {
    const key = merchantKey(name);
    if (key) rules.set(key, category);
  }
  res.json({ ok: true, transaction_id: id, category: chosen });
});

/** Shared by the paste/drop dialog and the inbox watcher. */
function importRows(rows) {
  const map = rules.all();
  let imported = 0, skipped = 0;

  for (const r of rows) {
    const date = String(r.date ?? "");
    const amt = Math.round(Number(r.amount) * 100) / 100;
    const merchant = cleanMerchant(r.merchant);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(amt > 0) || !merchant) { skipped++; continue; }
    if (transactions.findDuplicate(date, merchant, amt)) { skipped++; continue; }

    const { category, kind } = categorize({ merchant, amount: amt }, map);
    transactions.upsert({
      transaction_id: "csv_" + randomUUID(), account_id: null, item_id: null,
      date, name: merchant, merchant, amount: amt, currency: "USD", kind,
      pfc_primary: null, pfc_detailed: null, category, category_source: "auto",
      pending: false, channel: "csv", source: "csv", hidden: false,
    });
    imported++;
  }
  return { imported, skipped };
}

app.post("/api/import", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  res.json(importRows(rows));
});

/* ---------------------------- CSV inbox ---------------------------- */
/*
 * Drop a bank export in data/inbox/ and it is imported on the next scan.
 * A dedicated folder rather than ~/Downloads: dropping a file here is an
 * explicit instruction, where watching Downloads would try to eat every CSV
 * that ever lands there.
 */
const INBOX = join(ROOT, "data", "inbox");
const INBOX_DONE = join(INBOX, "imported");
const INBOX_REVIEW = join(INBOX, "needs-review");
for (const d of [INBOX, INBOX_DONE, INBOX_REVIEW]) mkdirSync(d, { recursive: true });

const ACCEPTS = /\.(csv|tsv|txt)$/i;
const inboxLog = [];
let scanning = false;

function logInbox(entry) {
  inboxLog.unshift({ at: new Date().toISOString(), ...entry });
  if (inboxLog.length > 20) inboxLog.length = 20;
}

function scanInbox() {
  if (scanning) return;
  scanning = true;
  try {
    for (const name of readdirSync(INBOX)) {
      const full = join(INBOX, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (!st.isFile() || !ACCEPTS.test(name)) continue;
      // Still being written (a download in flight) — catch it next pass.
      if (Date.now() - st.mtimeMs < 1500) continue;

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      let text;
      try { text = readFileSync(full, "utf8"); }
      catch { continue; }

      const res = extract(text);
      if (!res.ok) {
        renameSync(full, join(INBOX_REVIEW, `${stamp}__${name}`));
        logInbox({ file: name, ok: false, reason: res.reason });
        console.log(`[inbox] ${name}: ${res.reason} → needs-review/`);
        continue;
      }

      const { imported, skipped } = importRows(res.rows);
      renameSync(full, join(INBOX_DONE, `${stamp}__${name}`));
      logInbox({ file: name, ok: true, imported, skipped, credits: res.credits });
      console.log(`[inbox] ${name}: ${imported} imported, ${skipped} duplicate → imported/`);
    }
  } catch (err) {
    console.error("[inbox]", err.message);
  } finally {
    scanning = false;
  }
}

setInterval(scanInbox, 5000).unref();

app.get("/api/inbox", (_req, res) => res.json({ log: inboxLog, dir: INBOX }));

/* ---------------------------- settings ---------------------------- */

app.put("/api/settings", (req, res) => {
  const { budget, includeTransfers, discretionaryOnly } = req.body ?? {};
  if (budget !== undefined) settings.set("budget", Math.max(0, Number(budget) || 0));
  if (includeTransfers !== undefined) settings.set("includeTransfers", Boolean(includeTransfers));
  if (discretionaryOnly !== undefined) settings.set("discretionaryOnly", Boolean(discretionaryOnly));
  res.json({ ok: true, settings: settings.all() });
});

/* ---------------------------- errors ---------------------------- */

app.use((err, _req, res, _next) => {
  const e = plaidError(err);
  console.error("[error]", e.code, e.message);
  res.status(500).json({ error: e.message, code: e.code });
});

// Localhost only. This server has no auth because nothing off this machine
// can reach it — do not change the bind address without adding some.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Debit Ledger  ->  http://127.0.0.1:${PORT}`);
  console.log(`  Plaid env: ${plaidEnv}${plaidConfigured ? "" : "   (no API keys yet — see .env.example)"}`);
  const u = usageReport();
  console.log(`  Bank slots: ${u.items}${u.itemLimit ? "/" + u.itemLimit : " (no cap)"}` +
              `   ·   Plaid calls: ${u.calls}${u.callBudget ? "/" + u.callBudget : " (uncapped)"}`);
  console.log(`  Remote access: ${authConfigured ? "password set" : "DISABLED (no APP_PASSWORD)"}`);
  console.log(`  Data:  ${join(ROOT, "data", "ledger.db")}`);
  console.log(`  Inbox: ${INBOX}  (drop bank CSVs here)\n`);
  scanInbox();
});

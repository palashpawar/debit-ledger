import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { items, accounts, transactions, rules, usage } from "./db.js";
import { categorize, cleanMerchant, isFixed } from "./categorize.js";

const ENV = process.env.PLAID_ENV || "sandbox";
if (!PlaidEnvironments[ENV]) {
  throw new Error(`PLAID_ENV must be "sandbox" or "production" (got "${ENV}")`);
}

export const plaidConfigured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

export const plaid = new PlaidApi(new Configuration({
  basePath: PlaidEnvironments[ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID ?? "",
      "PLAID-SECRET": process.env.PLAID_SECRET ?? "",
      "Plaid-Version": "2020-09-14",
    },
  },
}));

export const plaidEnv = ENV;

/** Unwrap a Plaid SDK error into something worth showing a human. */
export function plaidError(err) {
  const d = err?.response?.data;
  if (d?.error_code) {
    return {
      code: d.error_code,
      type: d.error_type,
      message: d.display_message || d.error_message || d.error_code,
    };
  }
  if (err?.code) return { code: err.code, type: "LOCAL", message: err.message };
  return { code: "UNKNOWN", type: "LOCAL", message: err?.message ?? String(err) };
}

/* ------------------------- call budget ------------------------- */

/**
 * Which Plaid product each endpoint is charged against. Limited Production
 * grants 200 live calls per product; for this app the binding one is
 * `transactions` — everything else is incidental to linking a bank.
 */
const PRODUCT = {
  linkTokenCreate: "link",
  itemPublicTokenExchange: "item",
  itemRemove: "item",
  accountsGet: "accounts",
  institutionsGetById: "institutions",
  transactionsSync: "transactions",
};

export const CALL_BUDGET = Number(process.env.PLAID_CALL_BUDGET) || 0;

/**
 * On Plaid's Trial plan the scarce resource is connected Items, not calls:
 * 10 Items, unlimited API calls against them. Crucially, `/item/remove` does
 * NOT return a slot — disconnecting a bank spends it permanently. 0 = no cap
 * (a paid Production plan).
 */
export const ITEM_LIMIT = process.env.PLAID_ITEM_LIMIT === undefined
  ? 10
  : Number(process.env.PLAID_ITEM_LIMIT) || 0;

export function usageReport() {
  const calls = usage.forProduct("transactions");
  const itemsUsed = items.all().length;
  return {
    // Item slots — the Trial plan's real ceiling.
    items: itemsUsed,
    itemLimit: ITEM_LIMIT,
    itemsFull: ITEM_LIMIT > 0 && itemsUsed >= ITEM_LIMIT,
    // Calls are tracked either way; only capped on plans that meter them.
    calls,
    callBudget: CALL_BUDGET,
    callsExhausted: CALL_BUDGET > 0 && calls >= CALL_BUDGET,
    breakdown: usage.breakdown(),
  };
}

/**
 * Every Plaid request goes through here so it gets counted. The attempt is
 * recorded before it leaves, which overcounts when a call fails — the safe
 * direction for a budget you cannot top up.
 */
async function call(name, args) {
  const product = PRODUCT[name] ?? "other";
  if (CALL_BUDGET > 0 && product === "transactions" && usage.forProduct("transactions") >= CALL_BUDGET) {
    const err = new Error(
      `Plaid Transactions budget spent (${CALL_BUDGET} calls). Your data is still here — ` +
      `keep going with CSV import, or move to a paid Plaid plan.`,
    );
    err.code = "BUDGET_EXHAUSTED";
    throw err;
  }
  usage.bump(name, product);
  return plaid[name](args);
}

/* ------------------------------------------------------------------ */

export async function createLinkToken() {
  const res = await call("linkTokenCreate", {
    client_name: process.env.PLAID_CLIENT_NAME || "Debit Ledger",
    language: "en",
    country_codes: [CountryCode.Us],
    // A stable local id. Plaid only uses it to correlate Link sessions.
    user: { client_user_id: "local-user" },
    products: [Products.Transactions],
    // Checking only. A debit card draws on checking; savings activity is
    // almost entirely transfers, which would be filtered out of spending
    // anyway and only clutter the ledger. Widening this later means
    // reconnecting the bank, which spends another Item slot — so it is
    // deliberately narrow.
    account_filters: {
      depository: { account_subtypes: ["checking"] },
    },
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken) {
  const ex = await call("itemPublicTokenExchange", { public_token: publicToken });
  const access_token = ex.data.access_token;
  const item_id = ex.data.item_id;

  // Pull accounts (and the institution name, which is nice to show).
  const acc = await call("accountsGet", { access_token });
  const institution_id = acc.data.item?.institution_id ?? null;

  let institution_name = null;
  if (institution_id) {
    try {
      const inst = await call("institutionsGetById", {
        institution_id,
        country_codes: [CountryCode.Us],
      });
      institution_name = inst.data.institution.name;
    } catch { /* cosmetic only */ }
  }

  items.upsert({ item_id, access_token, institution_id, institution_name });
  for (const a of acc.data.accounts) accounts.upsert(item_id, a);

  return { item_id, institution_name, accounts: acc.data.accounts.length };
}

/* ------------------------------------------------------------------ */

function toRow(t, item_id) {
  const merchant = cleanMerchant(t.merchant_name || t.name);
  const pfcPrimary = t.personal_finance_category?.primary ?? null;
  const pfcDetailed = t.personal_finance_category?.detailed ?? null;
  const { category, kind } = categorize(
    { merchant, pfcPrimary, pfcDetailed, amount: t.amount },
    rules.all(),
  );
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    item_id,
    date: t.date,
    name: t.name,
    merchant,
    // Plaid: positive amount = money leaving a depository account. That is
    // already our convention, so it passes through unchanged.
    amount: t.amount,
    currency: t.iso_currency_code ?? t.unofficial_currency_code ?? "USD",
    kind,
    pfc_primary: pfcPrimary,
    pfc_detailed: pfcDetailed,
    category,
    pending: t.pending,
    channel: t.payment_channel ?? null,
    source: "plaid",
    fixed: isFixed(pfcPrimary, pfcDetailed),
    // Plaid resolves a brand for most card purchases; counterparties is the
    // fallback for rows where the top-level merchant wasn't identified.
    logo_url: t.logo_url ?? t.counterparties?.find((c) => c.logo_url)?.logo_url ?? null,
    website: t.website ?? t.counterparties?.find((c) => c.website)?.website ?? null,
  };
}

/**
 * Incremental pull for one Item. Plaid's /transactions/sync hands back only
 * what changed since our stored cursor, so this is cheap to call often.
 */
export async function syncItem(item) {
  let cursor = item.cursor || undefined;
  let added = 0, modified = 0, removed = 0;
  let hasMore = true;
  let guard = 0;

  while (hasMore) {
    if (++guard > 50) break; // pathological pagination stop

    let res;
    try {
      res = await call("transactionsSync", {
        access_token: item.access_token,
        cursor,
        count: 500,
      });
    } catch (err) {
      const e = plaidError(err);
      // A freshly linked Item may still be pulling history. Not an error.
      if (e.code === "PRODUCT_NOT_READY") {
        items.setError(item.item_id, "Still preparing transactions — sync again in a moment.");
        return { added, modified, removed, pending: true };
      }
      // A stale cursor: start the Item over from scratch.
      if (e.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
        cursor = undefined;
        continue;
      }
      items.setError(item.item_id, e.message);
      throw err;
    }

    const d = res.data;
    for (const a of d.accounts ?? []) accounts.upsert(item.item_id, a);

    for (const t of d.added)    { transactions.upsert(toRow(t, item.item_id)); added++; }
    for (const t of d.modified) { transactions.upsert(toRow(t, item.item_id)); modified++; }
    for (const r of d.removed)  { transactions.remove(r.transaction_id); removed++; }

    cursor = d.next_cursor;
    hasMore = d.has_more;
  }

  items.setCursor(item.item_id, cursor ?? null);
  return { added, modified, removed, pending: false };
}

export async function syncAll() {
  const results = [];
  for (const item of items.all()) {
    try {
      const r = await syncItem(item);
      results.push({ item_id: item.item_id, institution: item.institution_name, ...r });
    } catch (err) {
      results.push({
        item_id: item.item_id,
        institution: item.institution_name,
        error: plaidError(err),
      });
    }
  }
  return results;
}

export async function removeItem(item_id) {
  const item = items.get(item_id);
  if (!item) return false;
  try {
    await call("itemRemove", { access_token: item.access_token });
  } catch { /* revoke locally even if Plaid already dropped it */ }
  items.remove(item_id);
  return true;
}

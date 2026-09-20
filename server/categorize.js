/**
 * Three-tier categorization, most trusted first:
 *   1. a rule the user taught us for this merchant
 *   2. Plaid's personal_finance_category (its own ML taxonomy)
 *   3. keyword matching on the merchant string (CSV/manual rows, and any
 *      Plaid row that arrives without a PFC)
 */

export const CATS = [
  { id: "groceries", name: "Groceries", v: "--s1" },
  { id: "dining",    name: "Dining",    v: "--s2" },
  { id: "transport", name: "Transport", v: "--s3" },
  { id: "shopping",  name: "Shopping",  v: "--s4" },
  { id: "bills",     name: "Bills",     v: "--s5" },
  { id: "health",    name: "Health",    v: "--s6" },
  { id: "fun",       name: "Fun",       v: "--s7" },
  { id: "other",     name: "Other",     v: "--s8" },
];
export const CAT_IDS = new Set(CATS.map((c) => c.id));

/** Plaid PFC primary -> our eight. FOOD_AND_DRINK splits on the detailed value. */
const PFC_PRIMARY = {
  ENTERTAINMENT: "fun",
  GENERAL_MERCHANDISE: "shopping",
  HOME_IMPROVEMENT: "shopping",
  MEDICAL: "health",
  PERSONAL_CARE: "health",
  TRANSPORTATION: "transport",
  TRAVEL: "transport",
  RENT_AND_UTILITIES: "bills",
  LOAN_PAYMENTS: "bills",
  BANK_FEES: "bills",
  GENERAL_SERVICES: "other",
  GOVERNMENT_AND_NON_PROFIT: "other",
};

/** Not purchases — money moving between accounts, or arriving. */
const NOT_SPEND = { TRANSFER_IN: "income", INCOME: "income", TRANSFER_OUT: "transfer" };

/** Labels that mean money genuinely arrived, rather than a purchase reversing. */
const INFLOW = new Set(["TRANSFER_IN", "INCOME", "TRANSFER_OUT"]);

/** More specific than the primary label, so checked first. */
const PFC_DETAILED = {
  FOOD_AND_DRINK_GROCERIES: "groceries",
  // Plaid files insurance under GENERAL_SERVICES, which is otherwise a
  // catch-all mapped to "other". It is a bill.
  GENERAL_SERVICES_INSURANCE: "bills",
};

/**
 * Obligations you can't change month to month. Kept deliberately narrow:
 * utilities and subscriptions are recurring but you can still act on them,
 * so they stay discretionary. Rent, loan repayments and insurance do not.
 */
const FIXED_DETAILED = new Set(["RENT_AND_UTILITIES_RENT", "GENERAL_SERVICES_INSURANCE"]);
const FIXED_PRIMARY = new Set(["LOAN_PAYMENTS"]);

export function isFixed(pfcPrimary, pfcDetailed) {
  return FIXED_DETAILED.has(pfcDetailed) || FIXED_PRIMARY.has(pfcPrimary);
}

const RAW_KEYWORDS = {
  groceries: ["h-e-b", "heb", "trader joe", "whole foods", "kroger", "safeway", "aldi", "costco",
    "grocery", "randalls", "wheatsville", "central market", "sprouts", "publix"],
  dining: ["uber eats", "doordash", "grubhub", "starbucks", "chipotle", "mcdonald", "torchy",
    "coffee", "cafe", "pizza", "taco", "restaurant", "grill", "sushi", "panera", "subway",
    "deli", "bakery", "juice", "kitchen", "bbq", "thai", "ramen", "donut"],
  transport: ["uber", "lyft", "shell", "exxon", "chevron", "valero", "gas", "capital metro",
    "parking", "transit", "bird", "lime", "toll", "car wash", "76"],
  shopping: ["amazon", "target", "walmart", "best buy", "apple store", "nike", "zara", "uniqlo",
    "ikea", "etsy", "home depot", "lowes", "sephora", "ulta"],
  bills: ["at&t", "verizon", "t-mobile", "spectrum", "google fi", "austin energy", "water util",
    "insurance", "rent", "internet", "wireless", "utility", "icloud"],
  health: ["cvs", "walgreens", "pharmacy", "clinic", "dental", "doctor", "gym", "fitness",
    "optical", "urgent care", "planet fit"],
  fun: ["netflix", "spotify", "hulu", "steam", "cinema", "amc", "alamo draft", "theater",
    "concert", "ticketmaster", "playstation", "xbox", "patreon", "disney"],
};

export const norm = (s) =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();

// Keywords must go through the SAME normalization as the merchant string, or a
// keyword carrying punctuation ("h-e-b", "t-mobile") can never match — norm()
// has already turned those hyphens into spaces on the other side.
const KEYWORDS = Object.fromEntries(
  Object.entries(RAW_KEYWORDS).map(([cat, words]) => [
    cat,
    [...new Set(words.map(norm).filter(Boolean))],
  ]),
);

/** Stable key for the learned-rules table: first 3 meaningful words. */
export const merchantKey = (m) =>
  norm(m).split(" ").filter((w) => w.length > 1).slice(0, 3).join(" ");

export function guessFromKeywords(merchant) {
  // Leading space on both sides anchors the match to a word start, so "rent"
  // no longer fires on "PARENT" and "gas" no longer fires on "LAS VEGAS",
  // while prefixes like "planet fit" still reach "Planet Fitness".
  const n = " " + norm(merchant) + " ";
  let best = null, bestLen = 0;
  for (const [cat, words] of Object.entries(KEYWORDS)) {
    for (const w of words) {
      if (w.length > bestLen && n.includes(" " + w)) { best = cat; bestLen = w.length; }
    }
  }
  return best ?? "other";
}

/**
 * A negative amount means money came back. That is only "income" when the
 * label says so — a negative TRAVEL row is a refunded flight, not a paycheck,
 * and it belongs against Transport so it cancels the purchase it reverses.
 *
 * @returns {{category: string, kind: "spend"|"transfer"|"income"|"refund"}}
 */
export function categorize({ merchant, pfcPrimary, pfcDetailed, amount }, rulesMap = {}) {
  const incoming = typeof amount === "number" && amount < 0;

  // Money arriving under an income or transfer label is not spending at all,
  // and has no meaningful spending category.
  if (incoming && INFLOW.has(pfcPrimary)) return { category: "other", kind: "income" };

  const kind = incoming ? "refund" : NOT_SPEND[pfcPrimary] ?? "spend";

  const key = merchantKey(merchant);
  if (key && rulesMap[key]) return { category: rulesMap[key], kind };

  if (pfcDetailed && PFC_DETAILED[pfcDetailed]) {
    return { category: PFC_DETAILED[pfcDetailed], kind };
  }
  if (pfcPrimary === "FOOD_AND_DRINK") return { category: "dining", kind };
  if (pfcPrimary && PFC_PRIMARY[pfcPrimary]) {
    return { category: PFC_PRIMARY[pfcPrimary], kind };
  }
  if (kind === "transfer" || kind === "income") return { category: "other", kind };

  return { category: guessFromKeywords(merchant), kind };
}

/** Strip the bank's processing noise out of a raw descriptor. */
export function cleanMerchant(s) {
  const out = String(s ?? "")
    .replace(/\b(POS|DEBIT|PURCHASE|CARD|PMNT|RECUR|XXXX\d+|#\d{4,})\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out || String(s ?? "").trim() || "Unknown";
}

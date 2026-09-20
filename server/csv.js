/**
 * Headless CSV handling for the inbox watcher.
 *
 * The browser has its own copy of this logic because it drives the column
 * mapping and preview UI. This one only answers: can these columns be
 * identified confidently enough to import without a human looking? If not,
 * the file is set aside rather than guessed at.
 */

const pad = (n) => String(n).padStart(2, "0");

export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const t = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === "," || c === "\t") { row.push(field); field = ""; }
    else if (c === "\n") {
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export function parseAmount(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.includes("-");
  const n = Number(s.replace(/[()\-]/g, "").replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || n === 0) return null;
  return neg ? -n : n;
}

export function parseDate(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = "20" + y;
    return `${y}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
  }
  const d = new Date(s);
  return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function looksLikeHeader(row) {
  return row.some((c) => /date|desc|merchant|payee|amount|debit|credit|transaction|category|name/i.test(c)) &&
        !row.some((c) => parseAmount(c) !== null && /^\s*[-$(]?\d/.test(c) && parseDate(c) === null);
}

/**
 * @returns {{ok: true, rows: Array, credits: number, unreadable: number}
 *         | {ok: false, reason: string}}
 */
export function extract(text) {
  const rows = parseCSV(text);
  if (!rows.length) return { ok: false, reason: "file is empty" };

  const hasHeader = looksLikeHeader(rows[0]);
  const header = hasHeader ? rows[0].map((h) => h.trim()) : rows[0].map((_, i) => `Column ${i + 1}`);
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) return { ok: false, reason: "no data rows" };

  const find = (re) => header.findIndex((h) => re.test(h));
  let d = find(/date|posted/i), m = find(/desc|merchant|payee|name|memo/i), a = find(/amount|debit|value/i);
  const sample = body.slice(0, 12);
  if (d < 0) d = header.findIndex((_, i) => sample.filter((r) => parseDate(r[i])).length > sample.length * 0.6);
  if (a < 0) a = header.findIndex((_, i) => i !== d && sample.filter((r) => parseAmount(r[i]) !== null).length > sample.length * 0.6);
  if (m < 0) m = header.findIndex((_, i) => i !== d && i !== a && sample.filter((r) => String(r[i] ?? "").trim().length > 3).length > sample.length * 0.5);

  const missing = [];
  if (d < 0) missing.push("date");
  if (m < 0) missing.push("merchant");
  if (a < 0) missing.push("amount");
  if (missing.length) return { ok: false, reason: `couldn't identify the ${missing.join(", ")} column` };

  // Which sign means "money out" in this file.
  const amts = body.map((r) => parseAmount(r[a])).filter((v) => v !== null);
  if (!amts.length) return { ok: false, reason: "no readable amounts" };
  const flip = amts.filter((v) => v < 0).length < amts.length / 2;

  const out = [];
  let credits = 0, unreadable = 0;
  for (const r of body) {
    const date = parseDate(r[d]);
    const raw = parseAmount(r[a]);
    const merchant = String(r[m] ?? "").trim().replace(/\s+/g, " ");
    if (date === null || raw === null || !merchant) { unreadable++; continue; }
    const spend = flip ? raw : -raw;
    if (spend <= 0) { credits++; continue; }
    out.push({ date, merchant, amount: Math.round(spend * 100) / 100 });
  }

  if (!out.length) return { ok: false, reason: "no purchases found (only credits or unreadable rows)" };
  return { ok: true, rows: out, credits, unreadable };
}

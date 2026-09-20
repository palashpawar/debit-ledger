/* Debit Ledger — local frontend. Talks to the Express server on this machine. */
(function () {
"use strict";

/* ================= constants ================= */
const MONEY  = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const MONEY0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MON3   = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const $   = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const todayISO    = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth()+1) + "-" + pad(d.getDate()); };
const mKey        = (iso) => iso.slice(0, 7);
const daysIn      = (key) => { const [y,m] = key.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const shiftMonth  = (key, d) => { const [y,m] = key.split("-").map(Number); const x = new Date(y, m-1+d, 1); return x.getFullYear() + "-" + pad(x.getMonth()+1); };
const monthTitle  = (key) => { const [y,m] = key.split("-").map(Number); return MONTHS[m-1] + " " + y; };
// Just "Aug" — the comparison is always the immediately preceding month, so a
// year would be noise, and "Aug 26" next to "at day 19" reads as a date.
const monthAbbr   = (key) => MON3[Number(key.slice(5, 7)) - 1];
const norm        = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();

/* ================= state ================= */
const S = {
  month: mKey(todayISO()),
  cats: [], catMap: {},
  items: [], accounts: [],
  txns: [], prev: [],
  settings: { budget: 0, includeTransfers: false, discretionaryOnly: true },
  usage: { items: 0, itemLimit: 10, itemsFull: false, calls: 0, callBudget: 0, breakdown: [] },
  env: "sandbox", configured: false,
  filter: { q: "", cat: "" },
  syncing: false,
};

/* ================= api ================= */
async function api(method, url, body) {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || res.statusText, code: data.code };
    return data;
  } catch (e) {
    return { error: "Can't reach the server. Is it still running?" };
  }
}

let toastTimer;
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, isErr ? 6000 : 3200);
}

async function load() {
  const data = await api("GET", "/api/state?month=" + encodeURIComponent(S.month));
  if (data.error) { toast(data.error, true); return; }
  S.cats = data.cats;
  S.catMap = Object.fromEntries(data.cats.map((c) => [c.id, c]));
  S.items = data.items;
  S.accounts = data.accounts;
  S.txns = data.transactions;
  S.prev = data.prevTransactions || [];
  S.settings = data.settings;
  S.usage = data.usage ?? S.usage;
  S.env = data.env;
  S.configured = data.configured;
  if (!$("fCat").options.length) fillSelects();
  $("xferToggle").checked = !!S.settings.includeTransfers;
  $("discToggle").checked = !!S.settings.discretionaryOnly;
  render();
}

function fillSelects() {
  const opts = S.cats.map((c) => '<option value="' + c.id + '">' + esc(c.name) + "</option>").join("");
  $("fCat").innerHTML = '<option value="">Auto</option>' + opts;
  $("catFilter").innerHTML = '<option value="">All categories</option>' + opts;
}

/* ================= derive ================= */
// Refunds carry a negative amount, so including them nets them off the month
// total and off the category they reverse — which is what "spent" means.
function spendable(list) {
  return list.filter((t) =>
    t.kind === "spend" || t.kind === "refund" ||
    (S.settings.includeTransfers && t.kind === "transfer"));
}

function summarize(list, key) {
  // Two sets. The ledger shows everything; the headline figures, budget,
  // averages and charts describe only money you actually decide about —
  // extrapolating a once-a-month rent payment as daily habit is nonsense.
  const ledgerRows = spendable(list);
  const excluded = S.settings.discretionaryOnly ? ledgerRows.filter((t) => t.fixed) : [];
  const excludedTotal = excluded.reduce((s, t) => s + t.amount, 0);
  const rows = S.settings.discretionaryOnly ? ledgerRows.filter((t) => !t.fixed) : ledgerRows;

  const total = rows.reduce((s, t) => s + t.amount, 0);
  const dim = daysIn(key);
  const nowKey = mKey(todayISO());
  const elapsed = key < nowKey ? dim : key > nowKey ? 0 : Number(todayISO().slice(8, 10));
  const byDay = new Array(dim).fill(0);
  const byCat = {};
  let max = null;
  for (const t of rows) {
    const d = Number(t.date.slice(8, 10));
    if (d >= 1 && d <= dim) byDay[d - 1] += t.amount;
    byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    // "Largest" means largest purchase — a refund is not one.
    if (t.amount > 0 && (!max || t.amount > max.amount)) max = t;
  }
  const purchases = rows.filter((t) => t.amount > 0);
  const refunds = rows.filter((t) => t.amount < 0);
  const avg = elapsed > 0 ? total / elapsed : 0;
  return { rows, ledgerRows, excluded, excludedTotal, purchases, refunds,
           total, dim, elapsed, byDay, byCat, max, avg,
           projected: elapsed > 0 ? avg * dim : total };
}

/* ================= render ================= */
function render() {
  const key = S.month;
  const s = summarize(S.txns, key);
  const p = summarize(S.prev, shiftMonth(key, -1));

  $("mLabel").textContent = monthTitle(key);
  $("nextM").disabled = key >= mKey(todayISO());
  $("spentLabel").textContent = key === mKey(todayISO()) ? "Spent so far this month" : "Spent in " + monthTitle(key);
  $("heroSpent").textContent = MONEY.format(s.total);

  const dEl = $("heroDelta");
  dEl.innerHTML = "";
  if (p.total > 0 && s.total > 0) {
    const cmp = key === mKey(todayISO())
      ? p.rows.filter((t) => Number(t.date.slice(8,10)) <= s.elapsed).reduce((a,t) => a + t.amount, 0)
      : p.total;
    if (cmp > 0) {
      const pct = Math.round(((s.total - cmp) / cmp) * 100);
      const up = pct >= 0;
      dEl.className = "delta " + (up ? "up" : "down");
      dEl.innerHTML = '<span class="dot"></span>' + (up ? "+" : "") + pct + "% vs " + monthAbbr(shiftMonth(key, -1)) +
        (key === mKey(todayISO()) ? " at the same point" : "");
    }
  }

  renderSetup();
  renderBanks();
  renderFixedNote(s);
  renderBudget(s);
  renderTiles(s);
  renderDaily(s, key);
  renderCats(s);
  renderLedger(s, key);
}

function renderSetup() {
  const el = $("setup");
  if (S.configured) { el.innerHTML = ""; return; }
  el.innerHTML =
    '<div class="setup">' +
      "<h3>Add your Plaid keys to connect a bank</h3>" +
      "<p>The server is running but has no API credentials yet. Everything else below already works — " +
      "you can add purchases by hand or import a CSV in the meantime.</p>" +
      "<ol>" +
        '<li>Create a free account at <code>dashboard.plaid.com</code> and open <b>Developers → Keys</b>.</li>' +
        '<li>In this project, copy <code>.env.example</code> to <code>.env</code>.</li>' +
        '<li>Paste in your <code>client_id</code> and the <b>Sandbox</b> secret.</li>' +
        "<li>Restart the server.</li>" +
      "</ol>" +
    "</div>";
}

/**
 * On Plaid's Trial plan the ceiling is connected Items (10), not API calls,
 * and a disconnect never returns a slot — so that is the number to show.
 */
function usageMeter() {
  const u = S.usage;
  if (!u) return "";

  const calls = (u.breakdown || []).map((b) => b.endpoint + " ×" + b.calls).join("\n");

  if (u.itemLimit > 0) {
    const pct = Math.min(100, (u.items / u.itemLimit) * 100);
    const level = u.itemsFull ? " crit" : pct >= 70 ? " warn" : "";
    return '<span class="meter' + level + '" title="' +
      esc(`${u.items} of ${u.itemLimit} Plaid Item slots used.\n` +
          "Disconnecting a bank does NOT free a slot — Plaid counts it as spent for good.\n" +
          `API calls are unlimited on this plan (${u.calls} made so far).` +
          (calls ? "\n\n" + calls : "")) + '">' +
      '<span class="meter-k">Bank slots</span>' +
      '<span class="meter-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
      '<span class="meter-n">' + u.items + "/" + u.itemLimit + "</span></span>";
  }

  // A metered plan, or none — fall back to the call tally.
  if (!u.callBudget) return "";
  const pct = Math.min(100, (u.calls / u.callBudget) * 100);
  const level = u.callsExhausted || pct >= 95 ? " crit" : pct >= 75 ? " warn" : "";
  return '<span class="meter' + level + '" title="' +
    esc(`Transactions API calls: ${u.calls} of ${u.callBudget}.\n` +
        "Counted locally, including failed attempts — Plaid's dashboard is authoritative." +
        (calls ? "\n\n" + calls : "")) + '">' +
    '<span class="meter-k">Plaid calls</span>' +
    '<span class="meter-bar"><i style="width:' + pct.toFixed(1) + '%"></i></span>' +
    '<span class="meter-n">' + u.calls + "/" + u.callBudget + "</span></span>";
}

function renderBanks() {
  const el = $("banks");
  const tag = '<span class="env-tag' + (S.env === "production" ? " live" : "") + '">' + esc(S.env) + "</span>";
  setControlStates();

  if (!S.items.length) {
    el.innerHTML = '<div class="banks"><span class="none">No bank connected. ' +
      (S.configured ? "Use <b>Connect bank</b> to link your checking account." : "Add API keys first.") +
      "</span><span class=\"spacer\"></span>" + usageMeter() + tag + "</div>";
    return;
  }

  const byItem = {};
  for (const a of S.accounts) (byItem[a.item_id] ??= []).push(a);

  const chips = S.items.map((it) => {
    const accs = byItem[it.item_id] || [];
    const masks = accs.map((a) => "••" + (a.mask || "??")).join(" ");
    return '<span class="bank' + (it.last_error ? " err" : "") + '" title="' +
      esc(it.last_error || "Connected") + '">' +
      '<span class="dot"></span>' +
      '<span class="n">' + esc(it.institution_name || "Bank") + "</span>" +
      '<span class="m">' + esc(masks) + "</span>" +
      '<button class="x" data-unlink="' + esc(it.item_id) + '" title="Disconnect" aria-label="Disconnect ' +
        esc(it.institution_name || "bank") + '">×</button>' +
      "</span>";
  }).join("");

  const last = S.items.map((i) => i.last_synced_at).filter(Boolean).sort().pop();
  const when = last
    ? "synced " + new Date(last).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "not synced yet";

  el.innerHTML = '<div class="banks">' + chips +
    '<span class="spacer"></span><span class="sync">' + esc(when) + "</span>" +
    usageMeter() + tag + "</div>";

  el.querySelectorAll("[data-unlink]").forEach((b) => { b.onclick = () => unlink(b.dataset.unlink); });
}

/** Reflect plan limits on the controls themselves, not just in the meter. */
function setControlStates() {
  const u = S.usage;

  const sync = $("syncBtn");
  sync.disabled = !!u?.callsExhausted;
  sync.title = u?.callsExhausted
    ? "Plaid call budget spent — use Import CSV instead"
    : "Pull transactions that changed since the last sync";

  const connect = $("connectBtn");
  connect.disabled = !!u?.itemsFull;
  connect.title = u?.itemsFull
    ? `All ${u.itemLimit} Plaid bank slots used — disconnecting does not free one`
    : "Link a bank through Plaid";
}

/** Say plainly what the headline figures leave out — never hide it. */
function renderFixedNote(s) {
  const el = $("fixedNote");
  if (!S.settings.discretionaryOnly || !s.excluded.length) { el.hidden = true; return; }
  const n = s.excluded.length;
  el.hidden = false;
  el.innerHTML = "excludes <b>" + MONEY.format(s.excludedTotal) + "</b> in " + n +
    " fixed obligation" + (n === 1 ? "" : "s") + " — rent, loans, insurance. Still listed below.";
}

function renderBudget(s) {
  const budget = S.settings.budget || 0;
  $("budgetSlot").innerHTML = '<button class="budget-edit" id="bEdit">' +
    (budget > 0 ? MONEY0.format(budget) : "Set a budget") + "</button>";
  $("bEdit").onclick = startBudgetEdit;

  const fill = $("fill"), marker = $("marker"), pill = $("pacePill");
  if (budget <= 0) {
    fill.style.width = "0%"; fill.className = "fill"; marker.hidden = true; pill.innerHTML = "";
    $("paceLeft").textContent = MONEY.format(s.total) + " spent";
    $("paceRight").textContent = "no budget set";
    return;
  }
  // Refunds can outweigh purchases, so the net is legitimately negative
  // sometimes. Clamp the bar rather than feeding CSS a negative width.
  const pct = Math.max(0, Math.min(100, (s.total / budget) * 100));
  const pacePct = s.dim ? Math.min(100, (s.elapsed / s.dim) * 100) : 100;
  const expected = budget * (s.elapsed / s.dim);
  const refunded = s.total < 0;
  const over = s.total > budget;
  const behind = s.total > expected;

  fill.style.width = pct + "%";
  fill.className = "fill" + (over ? " crit" : behind ? " warn" : "");
  marker.hidden = s.elapsed === 0 || s.elapsed >= s.dim;
  marker.style.left = pacePct + "%";

  pill.innerHTML = refunded
    ? '<span class="pill good">● Net refund</span>'
    : over ? '<span class="pill crit">● Over budget</span>'
    : behind ? '<span class="pill warn">● Ahead of pace</span>'
             : '<span class="pill good">● On pace</span>';

  $("paceLeft").textContent = refunded
    ? MONEY.format(s.total) + " net"
    : MONEY.format(s.total) + " of " + MONEY0.format(budget);
  $("paceRight").textContent = refunded
    ? "refunds outweigh purchases"
    : over ? MONEY.format(s.total - budget) + " over"
           : MONEY.format(budget - s.total) + " left" + (s.elapsed < s.dim ? " · " + (s.dim - s.elapsed) + "d" : "");
}

function startBudgetEdit() {
  const slot = $("budgetSlot");
  slot.innerHTML = '<input class="budget-input" id="bInput" type="number" min="0" step="10" value="' +
    (S.settings.budget || "") + '" placeholder="2000">';
  const inp = $("bInput");
  inp.focus(); inp.select();
  let done = false;
  const commit = async () => {
    if (done) return; done = true;
    const v = Math.max(0, Number(inp.value) || 0);
    S.settings.budget = v;
    render();
    const r = await api("PUT", "/api/settings", { budget: v });
    if (r.error) toast(r.error, true);
  };
  inp.onblur = commit;
  inp.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); inp.blur(); }
    if (e.key === "Escape") { done = true; render(); }
  };
}

function renderTiles(s) {
  $("tAvg").textContent  = s.elapsed ? MONEY.format(s.avg) : "—";
  $("tAvgS").textContent = s.elapsed ? "over " + s.elapsed + " day" + (s.elapsed === 1 ? "" : "s") : "no activity";

  const budget = S.settings.budget || 0;
  // Projecting forward from a net-negative month says nothing useful.
  const projectable = s.elapsed > 0 && s.total > 0;
  $("tProj").textContent  = projectable ? MONEY0.format(s.projected) : "—";
  $("tProjS").textContent = !s.elapsed ? "—"
    : !s.rows.length ? "nothing recorded yet"
    : !projectable ? "refunds outweigh purchases"
    : budget > 0
      ? (s.projected > budget ? MONEY0.format(s.projected - budget) + " over budget"
                              : MONEY0.format(budget - s.projected) + " under budget")
      : "at this pace, by day " + s.dim;

  $("tMax").textContent  = s.max ? MONEY.format(s.max.amount) : "—";
  $("tMaxS").textContent = s.max ? s.max.merchant : "—";
  $("tCnt").textContent  = s.purchases.length || "—";
  const days = new Set(s.purchases.map((t) => t.date)).size;
  $("tCntS").textContent = !s.purchases.length ? "—"
    : s.refunds.length
      ? s.refunds.length + " refund" + (s.refunds.length === 1 ? "" : "s") + " netted off"
      : "across " + days + " day" + (days === 1 ? "" : "s");
}

/* ---------- daily bar chart ---------- */
function roundedTopBar(x, y, w, h, r) {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return "M" + x + " " + (y + h) + "V" + (y + rr) + "a" + rr + " " + rr + " 0 0 1 " + rr + " " + -rr +
         "h" + (w - 2 * rr) + "a" + rr + " " + rr + " 0 0 1 " + rr + " " + rr + "V" + (y + h) + "Z";
}
function niceCeil(v) {
  if (v <= 0) return 10;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}
let dailyMeta = null;

function renderDaily(s, key) {
  const W = 660, H = 200, padL = 44, padR = 8, padT = 12, padB = 24;
  const iw = W - padL - padR, ih = H - padT - padB;
  const maxV = niceCeil(Math.max(...s.byDay, 1));
  const band = iw / s.dim;
  const bw = Math.max(3, Math.min(band - 3, 16));
  const todayD = key === mKey(todayISO()) ? Number(todayISO().slice(8, 10)) : -1;

  let grid = "", labels = "";
  for (let i = 0; i <= 2; i++) {
    const v = maxV * (i / 2), y = padT + ih - (v / maxV) * ih;
    grid += '<line x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y.toFixed(1) +
            '" stroke="var(--rule)" stroke-width="1"/>';
    labels += '<text x="' + (padL - 8) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end" font-size="10.5" ' +
              'font-family="IBM Plex Mono, monospace" fill="var(--ink-3)">' + MONEY0.format(v) + "</text>";
  }

  let bars = "";
  for (let d = 1; d <= s.dim; d++) {
    const v = s.byDay[d - 1];
    const x = padL + (d - 1) * band + (band - bw) / 2;
    const h = (v / maxV) * ih;
    if (v > 0) {
      bars += '<path d="' + roundedTopBar(x, padT + ih - h, bw, h, 4) + '" fill="' +
              (d === todayD ? "var(--accent)" : "var(--s1)") + '" opacity="' + (d === todayD ? 1 : 0.85) + '"/>';
    } else {
      bars += '<rect x="' + x.toFixed(1) + '" y="' + (padT + ih - 2) + '" width="' + bw.toFixed(1) +
              '" height="2" rx="1" fill="var(--rule-strong)"/>';
    }
  }

  let ticks = "";
  for (let d = 1; d <= s.dim; d += 5) {
    const x = padL + (d - 1) * band + band / 2;
    ticks += '<text x="' + x.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10.5" ' +
             'font-family="IBM Plex Mono, monospace" fill="var(--ink-3)">' + d + "</text>";
  }
  const lastX = padL + (s.dim - 1) * band + band / 2;
  ticks += '<text x="' + lastX.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="10.5" ' +
           'font-family="IBM Plex Mono, monospace" fill="var(--ink-3)">' + s.dim + "</text>";

  const svg = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Daily spending for ' + monthTitle(key) + '">' +
    grid + labels +
    '<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (W - padR) + '" y2="' + (padT + ih) +
      '" stroke="var(--rule-strong)" stroke-width="1"/>' +
    bars + ticks + "</svg>";

  const box = $("dailyBox"), tip = $("tip");
  box.querySelectorAll("svg").forEach((n) => n.remove());
  box.insertAdjacentHTML("afterbegin", svg);
  dailyMeta = { padL, band, dim: s.dim, byDay: s.byDay, key, W };

  $("dailyNote").textContent = s.rows.length ? "peak " + MONEY0.format(Math.max(...s.byDay)) : "";

  const svgEl = box.querySelector("svg");
  svgEl.addEventListener("pointermove", (e) => {
    const r = svgEl.getBoundingClientRect();
    const scale = r.width / dailyMeta.W;
    const d = Math.floor(((e.clientX - r.left) / scale - dailyMeta.padL) / dailyMeta.band) + 1;
    if (d < 1 || d > dailyMeta.dim) { tip.style.opacity = 0; return; }
    const v = dailyMeta.byDay[d - 1];
    $("tipD").textContent = MON3[Number(dailyMeta.key.slice(5, 7)) - 1] + " " + d;
    $("tipV").textContent = v > 0 ? MONEY.format(v) : "no spending";
    tip.style.left = ((dailyMeta.padL + (d - 1) * dailyMeta.band + dailyMeta.band / 2) * scale) + "px";
    tip.style.top = (e.clientY - r.top) + "px";
    tip.style.opacity = 1;
  });
  svgEl.addEventListener("pointerleave", () => { tip.style.opacity = 0; });
}

function renderCats(s) {
  const el = $("catList");
  const rows = S.cats.map((c) => ({ c, v: s.byCat[c.id] || 0 })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
  if (!rows.length) {
    el.innerHTML = '<div style="color:var(--ink-3); font-size:13.5px">Nothing recorded this month yet.</div>';
    return;
  }
  const max = rows[0].v;
  // Share of what was actually spent — not of the net, which a refund can
  // drive negative and would flip every percentage below zero.
  const denom = rows.reduce((a, r) => a + r.v, 0);
  el.innerHTML = rows.map((r) => {
    const pct = denom ? Math.round((r.v / denom) * 100) : 0;
    return '<div class="cat">' +
      '<div class="cat-name"><span class="swatch" style="background:var(' + r.c.v + ')"></span><em>' + esc(r.c.name) + "</em></div>" +
      '<div class="cat-amt">' + MONEY.format(r.v) + '<span class="pct">' + pct + "%</span></div>" +
      '<div class="cat-bar"><i style="width:' + ((r.v / max) * 100).toFixed(1) + "%; background:var(" + r.c.v + ')"></i></div>' +
      "</div>";
  }).join("");
}

/**
 * Plaid resolves a brand logo for most card purchases but not all, so every
 * row falls back to a monogram tinted with its category colour — the column
 * keeps one consistent shape instead of ragged gaps.
 */
function avatar(t) {
  const c = S.catMap[t.category] || S.catMap.other;
  const ch = (String(t.merchant || "?").match(/[a-z0-9]/i) || ["?"])[0].toUpperCase();
  const mono = '<i style="background:color-mix(in srgb, var(' + c.v + ') 16%, transparent);' +
               "color:var(" + c.v + ')"' + (t.logo_url ? " hidden" : "") + ">" + esc(ch) + "</i>";
  const img = t.logo_url
    ? '<img src="' + esc(t.logo_url) + '" alt="" loading="lazy" decoding="async" ' +
      "onerror=\"this.hidden=true;this.nextElementSibling.hidden=false\">"
    : "";
  return '<span class="ava">' + img + mono + "</span>";
}

function renderLedger(s, key) {
  let list = s.ledgerRows.slice();
  const q = S.filter.q.toLowerCase();
  if (q) list = list.filter((t) => t.merchant.toLowerCase().includes(q) || (t.name || "").toLowerCase().includes(q));
  if (S.filter.cat) list = list.filter((t) => t.category === S.filter.cat);
  list.sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date < b.date ? 1 : -1));

  const shown = list.reduce((a, t) => a + t.amount, 0);
  $("ledgerCount").textContent = list.length
    ? list.length + " · " + MONEY.format(shown) + (list.length !== s.ledgerRows.length ? " of " + MONEY.format(s.ledgerRows.reduce((a, t) => a + t.amount, 0)) : "")
    : "";

  const el = $("ledger");
  if (!list.length) {
    el.innerHTML = '<div class="empty">' + (s.ledgerRows.length
      ? "No purchases match that filter."
      : S.items.length
        ? "Nothing in " + monthTitle(key) + ". Try <b>Sync</b>, or pick another month."
        : "Nothing recorded for " + monthTitle(key) + " yet. Connect a bank, add one above, or import a CSV.") +
      "</div>";
    return;
  }

  const opts = (t) => S.cats.map((c) =>
    '<option value="' + c.id + '"' + (c.id === t.category ? " selected" : "") + ">" + esc(c.name) + "</option>").join("");

  let html = '<div class="tablewrap"><table><thead><tr>' +
    "<th>Date</th><th>Merchant</th><th>Category</th><th class=\"num\">Amount</th><th></th>" +
    "</tr></thead><tbody>";

  let curDate = null;
  for (const t of list) {
    if (t.date !== curDate) {
      curDate = t.date;
      const dayTotal = s.ledgerRows.filter((x) => x.date === curDate).reduce((a, x) => a + x.amount, 0);
      const d = new Date(curDate + "T12:00:00");
      html += '<tr class="daygroup"><td colspan="5">' +
        d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) +
        '<span class="r">' + MONEY.format(dayTotal) + "</span></td></tr>";
    }
    const acct = t.account_mask ? '<span class="sub">••' + esc(t.account_mask) + "</span>" : "";
    html += "<tr>" +
      '<td class="date">' + esc(t.date.slice(5).replace("-", "/")) + "</td>" +
      '<td class="merchant"><div class="m-row">' + avatar(t) + '<div class="m-txt">' +
        '<span class="m-name">' + esc(t.merchant) + "</span>" +
        (t.pending ? '<span class="tag">pending</span>' : "") +
        (t.kind === "transfer" ? '<span class="tag xfer">transfer</span>' : "") +
        (t.kind === "refund" ? '<span class="tag refund">refund</span>' : "") +
        (t.fixed && S.settings.discretionaryOnly ? '<span class="tag fixed">fixed</span>' : "") +
        acct + "</div></div></td>" +
      '<td><select class="cat-select" data-recat="' + esc(t.transaction_id) + '" aria-label="Category for ' +
        esc(t.merchant) + '">' + opts(t) + "</select></td>" +
      '<td class="amt' + (t.amount < 0 ? " credit" : "") + '">' + MONEY.format(t.amount) + "</td>" +
      '<td class="act"><button class="del" data-del="' + esc(t.transaction_id) +
        '" title="Hide" aria-label="Hide ' + esc(t.merchant) + '">×</button></td>' +
      "</tr>";
  }
  html += "</tbody></table></div>";
  el.innerHTML = html;

  el.querySelectorAll("[data-del]").forEach((b) => { b.onclick = () => hideTxn(b.dataset.del); });
  el.querySelectorAll("[data-recat]").forEach((sel) => { sel.onchange = () => recat(sel.dataset.recat, sel.value); });
}

/* ================= actions ================= */
async function recat(id, category) {
  const r = await api("PATCH", "/api/transactions/" + encodeURIComponent(id), { category });
  if (r.error) { toast(r.error, true); return; }
  await load();
  toast(r.learned ? 'Remembered "' + r.learned + '" as ' + (S.catMap[category]?.name ?? category) : "Category updated");
}

async function hideTxn(id) {
  const r = await api("DELETE", "/api/transactions/" + encodeURIComponent(id));
  if (r.error) { toast(r.error, true); return; }
  await load();
}

async function unlink(item_id) {
  const it = S.items.find((i) => i.item_id === item_id);
  const name = it?.institution_name || "this bank";
  const u = S.usage;

  // On a capped plan this is not reversible in the way people expect.
  const slotWarning = u?.itemLimit > 0
    ? `\n\nThis does NOT free up a Plaid slot. You have used ${u.items} of ${u.itemLimit}; ` +
      `after this it stays ${u.items} of ${u.itemLimit}, with ${u.itemLimit - u.items} left to connect. ` +
      `Reconnecting the same bank later spends another slot.`
    : "";

  if (!confirm(
    `Disconnect ${name}?\n\nIts transactions are removed from this dashboard and the access ` +
    `token is revoked with Plaid. Anything you added by hand or imported stays.` + slotWarning,
  )) return;
  const r = await api("DELETE", "/api/items/" + encodeURIComponent(item_id));
  if (r.error) { toast(r.error, true); return; }
  toast("Disconnected " + name);
  await load();
}

async function connectBank() {
  if (typeof Plaid === "undefined") { toast("Plaid Link didn't load — check your connection.", true); return; }
  const btn = $("connectBtn");
  btn.disabled = true;
  const r = await api("POST", "/api/link/token");
  btn.disabled = false;
  if (r.error) { toast(r.error, true); return; }

  // Link runs in its own iframe and can fail without ever calling back, so
  // trace what it reports and ship the trace to the server log.
  const trace = [];
  const mark = (line) => { trace.push(new Date().toISOString().slice(11, 19) + "  " + line); };
  let sawOAuthOpen = 0;

  Plaid.create({
    token: r.link_token,

    onEvent: (name, md) => {
      mark([name, md?.view_name, md?.institution_name, md?.error_code, md?.error_message]
        .filter(Boolean).join(" · "));

      if (name === "OPEN_OAUTH") {
        sawOAuthOpen = Date.now();
        toast((md?.institution_name || "Your bank") + " opens in a NEW WINDOW — allow pop-ups if nothing appears.");
        // If the popup were blocked, the tab never loses focus.
        setTimeout(() => {
          if (sawOAuthOpen && document.hasFocus()) {
            mark("NO_FOCUS_CHANGE after OPEN_OAUTH — pop-up probably blocked");
            toast("No bank window opened. Your browser is blocking the pop-up — allow it and retry.", true);
          }
        }, 2500);
      }
      if (name === "ERROR") toast("Link error: " + (md?.error_code || "unknown"), true);
    },

    onSuccess: async (public_token, metadata) => {
      mark("SUCCESS · " + (metadata?.institution?.name || "?"));
      api("POST", "/api/link/trace", { trace, outcome: "success" });
      toast("Linking " + (metadata?.institution?.name || "account") + "…");
      const res = await api("POST", "/api/link/exchange", { public_token });
      if (res.error) { toast(res.error, true); return; }
      toast("Connected " + (res.institution_name || "bank") + " · " + res.accounts + " account(s)");
      await load();
    },

    onExit: (err, md) => {
      mark("EXIT · status=" + (md?.status || "?") +
           (err ? " · " + err.error_code + " · " + (err.error_message || "") : " · no error"));
      api("POST", "/api/link/trace", { trace, outcome: "exit" });
      if (err) toast(err.display_message || err.error_message || err.error_code, true);
    },
  }).open();
}

async function doSync() {
  if (S.syncing) return;
  S.syncing = true;
  const btn = $("syncBtn");
  const label = btn.textContent;
  btn.innerHTML = '<span class="spin"></span>';
  btn.disabled = true;

  const r = await api("POST", "/api/sync");

  btn.textContent = label;
  btn.disabled = false;
  S.syncing = false;

  if (r.error) {
    toast(r.error, true);
    // Refresh so the meter and the disabled state reflect what just happened.
    if (r.code === "BUDGET_EXHAUSTED" || r.code === "THROTTLED") await load();
    return;
  }
  if (r.note) { toast(r.note); return; }

  const failed = (r.results || []).filter((x) => x.error);
  if (failed.length) {
    toast(failed[0].institution + ": " + failed[0].error.message, true);
  } else {
    const a = (r.results || []).reduce((n, x) => n + x.added, 0);
    const m = (r.results || []).reduce((n, x) => n + x.modified, 0);
    const pending = (r.results || []).some((x) => x.pending);
    toast(pending ? "Bank is still preparing history — sync again shortly."
                  : a || m ? a + " new, " + m + " updated" : "Already up to date");
  }
  await load();
}

/* ================= CSV ================= */
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  const t = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === "\t") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); field = ""; if (row.some((x) => x.trim() !== "")) rows.push(row); row = []; }
    else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}
function parseAmount(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.includes("-");
  const n = Number(s.replace(/[()\-]/g, "").replace(/[^0-9.]/g, ""));
  if (!isFinite(n) || n === 0) return null;
  return neg ? -n : n;
}
function parseDate(v) {
  const s = String(v ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = "20" + y; return y + "-" + pad(Number(m[1])) + "-" + pad(Number(m[2])); }
  const d = new Date(s);
  return isNaN(d) ? null : d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function looksLikeHeader(row) {
  return row.some((c) => /date|desc|merchant|payee|amount|debit|credit|transaction|category|name/i.test(c)) &&
        !row.some((c) => parseAmount(c) !== null && /^\s*[-$(]?\d/.test(c) && parseDate(c) === null);
}

const csv = { header: [], body: [], map: { d: -1, m: -1, a: -1 } };

function analyzeCSV() {
  const rows = parseCSV($("csvText").value);
  $("csvPreview").innerHTML = ""; $("csvSummary").textContent = "";
  if (!rows.length) {
    $("mapRow").hidden = true; $("flipLine").hidden = true; $("csvStatus").hidden = true; $("csvGo").disabled = true;
    return;
  }
  const hasHeader = looksLikeHeader(rows[0]);
  csv.header = hasHeader ? rows[0].map((h) => h.trim()) : rows[0].map((_, i) => "Column " + (i + 1));
  csv.body = hasHeader ? rows.slice(1) : rows;
  if (!csv.body.length) { $("csvStatus").hidden = true; $("csvGo").disabled = true; $("mapRow").hidden = true; return; }

  const find = (re) => csv.header.findIndex((h) => re.test(h));
  let d = find(/date|posted/i), m = find(/desc|merchant|payee|name|memo/i), a = find(/amount|debit|value/i);
  const sample = csv.body.slice(0, 12);
  if (d < 0) d = csv.header.findIndex((_, i) => sample.filter((r) => parseDate(r[i])).length > sample.length * 0.6);
  if (a < 0) a = csv.header.findIndex((_, i) => i !== d && sample.filter((r) => parseAmount(r[i]) !== null).length > sample.length * 0.6);
  if (m < 0) m = csv.header.findIndex((_, i) => i !== d && i !== a && sample.filter((r) => String(r[i] ?? "").trim().length > 3).length > sample.length * 0.5);
  csv.map = { d, m, a };

  const opts = (sel) => csv.header.map((h, i) => '<option value="' + i + '"' + (i === sel ? " selected" : "") + ">" + esc(h) + "</option>").join("");
  $("mapDate").innerHTML = opts(d); $("mapDesc").innerHTML = opts(m); $("mapAmt").innerHTML = opts(a);
  $("mapRow").hidden = false;

  const amts = csv.body.map((r) => parseAmount(r[a])).filter((v) => v !== null);
  $("flipSign").checked = amts.filter((v) => v < 0).length < amts.length / 2;
  $("flipLine").hidden = false;

  previewCSV();
}

function csvRows() {
  const { d, m, a } = csv.map;
  const flip = $("flipSign").checked;
  return csv.body.map((r) => {
    const date = parseDate(r[d]);
    const raw = parseAmount(r[a]);
    const merchant = String(r[m] ?? "").trim().replace(/\s+/g, " ");
    if (date === null || raw === null || !merchant) return { ok: false, reason: "incomplete", date, merchant, amount: raw };
    const spend = flip ? raw : -raw;
    if (spend <= 0) return { ok: false, reason: "credit", date, merchant, amount: Math.abs(raw) };
    return { ok: true, date, merchant, amount: Math.round(spend * 100) / 100 };
  });
}

function previewCSV() {
  const rows = csvRows();
  const ok = rows.filter((r) => r.ok);
  const credits = rows.filter((r) => !r.ok && r.reason === "credit").length;
  const bad = rows.filter((r) => !r.ok && r.reason !== "credit").length;

  const st = $("csvStatus");
  st.hidden = false;
  st.innerHTML = "<b>" + ok.length + "</b> purchase" + (ok.length === 1 ? "" : "s") + " ready to import" +
    (credits ? " · <b>" + credits + "</b> credit" + (credits === 1 ? "" : "s") + " and refunds skipped" : "") +
    (bad ? " · <b>" + bad + "</b> row" + (bad === 1 ? "" : "s") + " couldn't be read" : "");
  $("csvGo").disabled = ok.length === 0;
  $("csvSummary").textContent = ok.length ? MONEY.format(ok.reduce((a, r) => a + r.amount, 0)) + " total" : "";

  const show = rows.slice(0, 6);
  $("csvPreview").innerHTML = show.length
    ? '<table><thead><tr><th>Date</th><th>Merchant</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>' +
      show.map((r) => r.ok
        ? '<tr><td class="m">' + esc(r.date) + "</td><td>" + esc(r.merchant) +
          '</td><td>ready</td><td class="amt">' + MONEY.format(r.amount) + "</td></tr>"
        : '<tr class="skip"><td class="m">' + esc(r.date || "—") + "</td><td>" + esc(r.merchant || "—") +
          "</td><td>" + (r.reason === "credit" ? "credit — skipped" : "unreadable") + '</td><td class="amt">—</td></tr>'
      ).join("") + "</tbody></table>"
    : "";
}

async function doImport() {
  const rows = csvRows().filter((r) => r.ok);
  if (!rows.length) return;
  $("csvGo").disabled = true;
  const r = await api("POST", "/api/import", { rows });
  $("csvGo").disabled = false;
  if (r.error) { toast(r.error, true); return; }

  const newest = rows.map((x) => mKey(x.date)).sort().pop();
  if (newest && newest <= mKey(todayISO())) S.month = newest;
  $("csvDlg").close();
  $("csvText").value = "";
  await load();
  toast(r.imported + " imported" + (r.skipped ? " · " + r.skipped + " skipped as duplicates" : ""));
}

/** Read a dropped or chosen file into the textarea and analyze it. */
function loadFile(file) {
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { toast("That file is over 12 MB — too big to paste in.", true); return; }
  const r = new FileReader();
  r.onload = () => {
    $("csvText").value = String(r.result ?? "");
    analyzeCSV();
    toast("Loaded " + file.name);
  };
  r.onerror = () => toast("Couldn't read " + file.name, true);
  r.readAsText(file);
}

/** The server imports anything dropped in data/inbox/; notice when it does. */
let lastInboxAt = null;
function watchInbox() {
  const poll = async () => {
    const r = await api("GET", "/api/inbox");
    if (r.error || !Array.isArray(r.log) || !r.log.length) return;
    const newest = r.log[0];
    if (lastInboxAt === null) { lastInboxAt = newest.at; return; } // don't replay history on load
    if (newest.at === lastInboxAt) return;
    lastInboxAt = newest.at;

    if (newest.ok) {
      toast(newest.file + ": " + newest.imported + " imported" +
            (newest.skipped ? " · " + newest.skipped + " duplicate" : ""));
      await load();
    } else {
      toast(newest.file + " needs a look — " + newest.reason, true);
    }
  };
  poll();
  setInterval(poll, 6000);
}

/* ================= wiring ================= */
function initControls() {
  $("fDate").value = todayISO();

  $("prevM").onclick = () => { S.month = shiftMonth(S.month, -1); load(); };
  $("nextM").onclick = () => { if (S.month < mKey(todayISO())) { S.month = shiftMonth(S.month, 1); load(); } };

  $("connectBtn").onclick = connectBank;
  $("syncBtn").onclick = doSync;

  $("discToggle").onchange = async (e) => {
    S.settings.discretionaryOnly = e.target.checked;
    render();
    await api("PUT", "/api/settings", { discretionaryOnly: e.target.checked });
  };

  $("xferToggle").onchange = async (e) => {
    S.settings.includeTransfers = e.target.checked;
    render();
    await api("PUT", "/api/settings", { includeTransfers: e.target.checked });
  };

  $("addForm").onsubmit = async (e) => {
    e.preventDefault();
    const date = $("fDate").value;
    const merchant = $("fMerchant").value.trim();
    const amount = Math.round(Number($("fAmount").value) * 100) / 100;
    if (!date || !merchant || !(amount > 0)) return;

    const r = await api("POST", "/api/transactions", { date, merchant, amount, category: $("fCat").value || undefined });
    if (r.error) { toast(r.error, true); return; }

    $("fMerchant").value = ""; $("fAmount").value = ""; $("fCat").value = "";
    if (mKey(date) !== S.month && mKey(date) <= mKey(todayISO())) S.month = mKey(date);
    await load();
    $("fMerchant").focus();
  };

  let tq;
  $("search").oninput = (e) => { clearTimeout(tq); tq = setTimeout(() => { S.filter.q = e.target.value; render(); }, 120); };
  $("catFilter").onchange = (e) => { S.filter.cat = e.target.value; render(); };

  const dlg = $("csvDlg");
  $("importBtn").onclick = () => { dlg.showModal(); $("csvText").focus(); };
  $("csvCancel").onclick = () => dlg.close();
  $("csvGo").onclick = doImport;

  /* ---- file picker + drag and drop ---- */
  $("csvPick").onclick = () => $("csvFile").click();
  $("csvFile").onchange = (e) => { loadFile(e.target.files?.[0]); e.target.value = ""; };

  const dz = $("dropzone");
  const hasFile = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

  for (const el of [dlg, dz]) {
    el.addEventListener("dragover", (e) => { if (hasFile(e)) { e.preventDefault(); dz.classList.add("over"); } });
    el.addEventListener("dragleave", (e) => { if (e.target === el) dz.classList.remove("over"); });
    el.addEventListener("drop", (e) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      dz.classList.remove("over");
      loadFile(e.dataTransfer.files?.[0]);
    });
  }

  // Dropping a CSV anywhere on the page opens the dialog with it loaded.
  document.addEventListener("dragover", (e) => { if (hasFile(e)) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!hasFile(e) || dlg.open) return;
    e.preventDefault();
    dlg.showModal();
    loadFile(e.dataTransfer.files?.[0]);
  });

  watchInbox();
  let tc;
  $("csvText").oninput = () => { clearTimeout(tc); tc = setTimeout(analyzeCSV, 180); };
  $("csvText").onpaste = () => setTimeout(analyzeCSV, 30);
  ["mapDate", "mapDesc", "mapAmt"].forEach((id) => {
    $(id).onchange = () => {
      csv.map = { d: +$("mapDate").value, m: +$("mapDesc").value, a: +$("mapAmt").value };
      previewCSV();
    };
  });
  $("flipSign").onchange = previewCSV;
}

initControls();
load();
})();

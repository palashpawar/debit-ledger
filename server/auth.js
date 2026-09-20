/**
 * Access control for remote requests.
 *
 * The rule is deliberately blunt: requests arriving over a tunnel must carry a
 * valid session, and remote access is impossible at all unless APP_PASSWORD is
 * set. It fails CLOSED — misconfiguring it locks you out rather than quietly
 * publishing your bank history.
 *
 * Localhost is still trusted, because cloudflared runs on this machine and
 * connects to 127.0.0.1; a proxied request is told apart by its forwarding
 * headers, not by its socket address.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "./db.js";

const PASSWORD = process.env.APP_PASSWORD || "";
export const authConfigured = PASSWORD.length > 0;

const SESSION_DAYS = 30;
const COOKIE = "dl_session";

// Derive once at startup so a comparison never handles the raw value.
const SALT = "debit-ledger/v1";
const EXPECTED = authConfigured ? scryptSync(PASSWORD, SALT, 32) : null;

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    label      TEXT
  );
`);

function sweep() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(new Date().toISOString());
}
sweep();
setInterval(sweep, 6 * 60 * 60 * 1000).unref();

/* ------------------------------ sessions ------------------------------ */

function createSession(label) {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  db.prepare(`INSERT INTO sessions (token, created_at, expires_at, label) VALUES (?,?,?,?)`)
    .run(token, now.toISOString(), exp.toISOString(), label ?? null);
  return { token, expires: exp };
}

function validSession(token) {
  if (!token) return false;
  const row = db.prepare(`SELECT expires_at FROM sessions WHERE token = ?`).get(token);
  if (!row) return false;
  if (row.expires_at < new Date().toISOString()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return false;
  }
  return true;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ------------------------------ request shape ------------------------------ */

/** A tunnelled request carries forwarding headers; a direct one does not. */
export function isRemote(req) {
  return Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
}

const clientKey = (req) =>
  req.headers["cf-connecting-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "local";

/* ------------------------------ brute force ------------------------------ */

const attempts = new Map(); // key -> {n, until}
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function lockedFor(key) {
  const a = attempts.get(key);
  if (!a?.until) return 0;
  const left = a.until - Date.now();
  if (left <= 0) { attempts.delete(key); return 0; }
  return left;
}

function recordFailure(key) {
  const a = attempts.get(key) ?? { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= MAX_ATTEMPTS) { a.until = Date.now() + LOCKOUT_MS; a.n = 0; }
  attempts.set(key, a);
}

/* ------------------------------ middleware ------------------------------ */

const OPEN_PATHS = new Set(["/login", "/login.html", "/api/login", "/styles.css"]);

export function requireAuth(req, res, next) {
  if (!isRemote(req)) return next();               // local: unchanged behaviour

  if (!authConfigured) {
    return res.status(503).type("text/plain").send(
      "Remote access is disabled.\n\n" +
      "This app refuses connections from outside your machine until a password is set.\n" +
      "Add APP_PASSWORD=<something long> to .env and restart.",
    );
  }

  if (OPEN_PATHS.has(req.path)) return next();

  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (validSession(token)) return next();

  if (req.path.startsWith("/api/")) {
    return res.status(401).json({ error: "Not signed in", code: "UNAUTHENTICATED" });
  }
  return res.redirect(302, "/login");
}

/* ------------------------------ routes ------------------------------ */

export function mountAuth(app) {
  app.get("/login", (req, res, next) => {
    if (!isRemote(req)) return res.redirect(302, "/");
    req.url = "/login.html";
    next();
  });

  app.post("/api/login", (req, res) => {
    if (!authConfigured) return res.status(503).json({ error: "No password configured on the server." });

    const key = clientKey(req);
    const left = lockedFor(key);
    if (left > 0) {
      return res.status(429).json({
        error: `Too many attempts. Try again in ${Math.ceil(left / 60000)} minutes.`,
      });
    }

    const given = String(req.body?.password ?? "");
    const got = scryptSync(given, SALT, 32);
    const ok = got.length === EXPECTED.length && timingSafeEqual(got, EXPECTED);

    if (!ok) {
      recordFailure(key);
      return res.status(401).json({ error: "Wrong password." });
    }

    attempts.delete(key);
    const { token, expires } = createSession(req.headers["user-agent"]?.slice(0, 120));
    const https = req.headers["x-forwarded-proto"] === "https";
    res.setHeader("Set-Cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}` +
      (https ? "; Secure" : ""));
    res.json({ ok: true, expires: expires.toISOString() });
  });

  app.post("/api/logout", (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });
}

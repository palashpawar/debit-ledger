# Debit Ledger

A local dashboard for tracking debit card spending, with real bank sync through
Plaid. Everything runs on your machine — the server binds to `127.0.0.1`, the
data lives in a SQLite file in this folder, and nothing is sent anywhere except
to Plaid's API.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Get Plaid keys

Create a free account at [dashboard.plaid.com](https://dashboard.plaid.com), then
open **Developers → Keys**. You need your `client_id` and your **Sandbox**
secret. Sandbox is free, unlimited, and uses fake banks — start there.

### 3. Configure

```bash
cp .env.example .env
```

Fill in `PLAID_CLIENT_ID` and `PLAID_SECRET`. Leave `PLAID_ENV=sandbox`.

### 4. Run

```bash
npm start
```

Open **http://127.0.0.1:4310**.

### 5. Connect a bank

Click **Connect bank**. In sandbox, pick any institution and log in with Plaid's
test credentials:

| Field | Value |
|---|---|
| Username | `user_good` |
| Password | `pass_good` |
| MFA code, if asked | `1234` |

You'll get a fake checking account preloaded with a couple of years of
transactions, which is enough to see every part of the dashboard working.

---

## Using it for free on your real bank

Sandbox banks are fake. The free way to reach a real one is the **Plaid Trial
plan** — free access to Plaid's production APIs with *no business registration,
no security questionnaire, and no sales process*.

> **Do not fill in the "request Production access" billing form.** That is the
> paid tier. The Trial plan is a different door, and it doesn't ask for a card.
> (Trial replaced the older "Limited Production" 200-call grant for accounts
> created on or after 15 April 2026. Plaid's public pricing FAQ still describes
> the old scheme, which is why it's easy to get this wrong.)

**What Trial gives you**

- **Transactions included** — the only product this app uses.
- **Unlimited API calls** against the banks you've connected. Sync as often as
  you like.
- OAuth to most major US institutions: Chase, Bank of America, Wells Fargo,
  Capital One, Citi, PNC, U.S. Bank, Navy Federal, Amex. Access usually goes
  live 6–24 hours after approval.
- Usually **approved automatically** after identity verification. A flagged
  application gets a human reply in 2–3 business days.
- US and Canada only, and only if you don't already hold a Production or
  Limited Production account.

**The one real limit: 10 Items.** An Item is one connected bank. For tracking
your own debit card that is effectively unlimited — but there's a trap:

> **Disconnecting a bank does NOT give the slot back.** Plaid's `/item/remove`
> revokes the token but still counts the slot as spent. Connect, disconnect and
> reconnect the same bank three times and you've burned three of your ten.

So the app shows a **Bank slots** meter next to your connected banks, disables
**Connect bank** at the cap, and spells this out in the disconnect confirmation
rather than letting you discover it afterwards. `PLAID_ITEM_LIMIT` in `.env`
sets the ceiling (`0` = no cap, for a paid Production plan).

Upgrading from Trial to a paid Production plan is **one-way** — you can't go
back.

**If you ever do hit the cap**, switch to CSV import below. Same database, same
categories, same learned merchant rules. Nothing breaks, and it's free forever.

## Switching to your real bank

1. Get on the Trial plan at `dashboard.plaid.com` (or sign up at
   `dashboard.plaid.com/signup`). You'll accept Plaid's standard MSA.
2. Put your **production** secret in `.env` and set `PLAID_ENV=production`.
3. Restart, then **Connect bank** and log in with your real credentials. Those
   go to your bank through Plaid's own UI — they never touch this server, and
   this app never sees them.
4. Disconnect First Platypus Bank *before* switching, so your sandbox fixtures
   don't sit alongside real data. Sandbox Items don't count against the Trial
   Item cap.

---

## How it works

```
server/
  index.js       Express routes + CSV inbox watcher, binds 127.0.0.1 only
  plaid.js       Plaid client, Link tokens, /transactions/sync, call budget
  db.js          SQLite schema + queries (node:sqlite, no native deps)
  categorize.js  Plaid PFC → categories, keyword fallback, learned rules
  csv.js         headless CSV parsing for the inbox watcher
public/
  index.html     the dashboard
  app.js         frontend — talks only to this server
  styles.css
data/
  ledger.db      your transactions + Plaid access tokens (gitignored, chmod 600)
  inbox/         drop bank CSVs here; imported/ and needs-review/ below it
```

**Sync** uses Plaid's `/transactions/sync`, which is incremental: the server
stores a cursor per connected bank and each sync pulls only what changed. Press
it as often as you like; it's cheap. There's no background job — syncing is
something you trigger.

**Categories** are resolved in three tiers, most trusted first:

1. a rule you taught by changing a category in the ledger
2. Plaid's own `personal_finance_category`
3. keyword matching on the merchant name (for CSV and manual rows)

When you change a category, that merchant is remembered and the change is
applied backwards to every other transaction from them that you hadn't already
set by hand. Anything you set by hand is pinned — a later sync won't overwrite it.

**Which accounts Link offers.** Checking only, by design — a debit card draws
on checking, and savings activity is almost all transfers. Widening this means
editing `account_filters` in `server/plaid.js` *and reconnecting the bank*,
which spends another Item slot, so it's set narrow deliberately.

**Discretionary vs fixed.** Rent, loan repayments and insurance are
obligations you can't act on month to month, and blending them into a spending
tracker drowns everything else — rent alone can be three-quarters of a month.
They're flagged `fixed` at categorize time, and the **Discretionary only**
toggle (on by default) keeps them out of the headline figure, the budget bar,
the daily average, the projection and the charts. They stay in the ledger,
tagged, and a line under the headline says exactly how much is being left out.
Utilities and subscriptions are deliberately *not* fixed — you can still act on
those.

**Transfers vs purchases.** Plaid labels transfers out (to savings, Venmo, and
so on) separately from purchases. Those are excluded from spending totals by
default, since they aren't debit card spending. The **Include transfers** toggle
above the ledger brings them back in.

**Refunds vs income.** A negative amount is only treated as income when Plaid's
label says so (`TRANSFER_IN`, `INCOME`). Anything else negative is a refund: it
keeps the category of the purchase it reverses and is netted off that category
and off the month total, which is what "spent" means. Refunds are shown in the
ledger in green, tagged, so they're never silently dropped. A month where
refunds outweigh purchases shows a negative net, and the budget bar and
projection say so rather than rendering as empty.

**Merchant logos.** Plaid returns a `logo_url` for most card purchases (about
70% of a typical month); it's stored per transaction and shown as a 26px mark
in the ledger. Rows Plaid couldn't resolve fall back to a monogram tinted with
their category colour, so the column keeps one consistent shape rather than
ragged gaps. Logos load from `plaid-merchant-logos.plaid.com`, so viewing the
dashboard makes image requests to Plaid — the only outbound traffic the page
generates. Logos are drawn for light backgrounds, so they get a white chip that
holds up in dark mode. `logo_url` populates on sync; after adding the column an
existing database needs a cursor reset to backfill (see Troubleshooting).

**Pending transactions** are shown and marked. When a pending charge posts,
Plaid replaces it on the next sync — it isn't double counted.

**CSV import** works three ways, all of them free and unlimited:

1. **Drop a file anywhere on the page** — the import dialog opens with it
   loaded, columns detected, ready to confirm.
2. **Import CSV → choose a file**, or paste the text.
3. **Drop it in `data/inbox/`** and it imports itself within about five
   seconds, no dialog. Point your browser's download folder there and a bank
   export lands in the dashboard on its own.

All three detect the header, guess the columns, work out whether purchases are
positive or negative in that file, skip refunds and credits, and dedupe against
what's already stored.

The inbox is a **dedicated folder rather than `~/Downloads`** on purpose:
dropping a file there is an explicit instruction, where watching Downloads
would try to eat every CSV that ever lands in it. Processed files move to
`data/inbox/imported/` with a timestamp. A file whose columns can't be
identified confidently is **not guessed at** — it moves to
`data/inbox/needs-review/` and the reason appears in the dashboard, so import
it through the dialog where you can map the columns yourself.

---

## Security notes

- `data/ledger.db` holds **Plaid access tokens**, which are bearer credentials
  for your bank data. It's gitignored and created `chmod 600`. Don't commit it,
  and don't sync this folder to a shared drive.
- `.env` holds your Plaid secret. Also gitignored.
- The server has **no authentication**, which is fine only because it listens on
  `127.0.0.1` and nothing off this machine can reach it. If you ever change the
  bind address, add auth first.
- Access tokens never leave the server process — the `/api/state` response
  strips them before sending anything to the browser.
- Disconnecting a bank calls Plaid's `/item/remove`, which revokes the token on
  their side too, and deletes that bank's transactions locally.

---

## Troubleshooting

**"Plaid keys are missing"** — `.env` doesn't exist or the values are blank. The
server prints which env it loaded at startup.

**Sync says "still preparing history"** — a freshly linked Item is still pulling
transactions on Plaid's side. Wait a few seconds and sync again.

**`INVALID_CREDENTIALS` / `ITEM_LOGIN_REQUIRED`** — the bank needs you to
reauthenticate. Disconnect the bank and connect it again.

**Nothing in the current month** — check the month arrows at the top, and that
the accounts you expect are connected. Sandbox data may not include the current
month.

**Port 4310 in use** — change `PORT` in `.env`.

**You changed `categorize.js` and nothing re-categorized** — expected. Sync is
incremental, so with a stored cursor Plaid returns no changes and the new logic
never touches rows already in the database. Force a full replay:

```bash
sqlite3 data/ledger.db "UPDATE items SET cursor = NULL;"
```

Then press **Sync**. Every transaction is re-fetched and re-categorized;
upserts key on `transaction_id`, so nothing duplicates, and anything you set by
hand stays put.

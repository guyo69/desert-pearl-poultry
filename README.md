# Desert Pearl Poultry Manager

Farm, stock and money app for **Desert Pearl Ventures Ltd (Tuala Farm Fresh Eggs)**. It runs as one installable web app on Android, iPhone and desktop, with a separate screen for each job:

| Who | What they see |
|---|---|
| **Owner** | Everything: overview, stock at all 5 locations, money (cash, M-Pesa Till, Paybill, bank), weekly intelligence report, activity log, setup (staff, prices, thresholds, houses, opening balances) |
| **Farm Manager** | Alerts first, then overview, stock, report, flock health, feed, water, money, farm records |
| **Production Clerk** | Egg collection, feed used/received, **water drunk and tank level**, medicine & vaccines, mortality, sending eggs to outlets |
| **Farm Counter, Van Driver, shop attendants** (Tuala, Rayan Fedha, Lucky Summer) | Their own location only: opening count, receive deliveries, sales with cash/Till/Paybill split, breakage, expenses, moving money, close the day |

## How the numbers stay honest

- **One ledger.** Every action is a record (collection, delivery, sale, money move…). Stock, cash balances, the feed buffer and the tank level are *calculated* from those records, never typed in. Records are never deleted; a manager can mark one as corrected, with a reason, and everything recalculates.
- **Sales must balance.** A sale saves only when cash + Till + Paybill equals the price worked out from the eggs sold.
- **Money moves cannot create or lose money.** "Paybill → cash", "cash → bank" and similar moves take from one account and add to another. Only charges (M-Pesa or bank fees) reduce the total. The owner's Money screen proves it: opening funds + sales − expenses − charges ± count differences = what is in the four places.
- **Deliveries are confirmed at the other end.** Eggs sent from the farm stay "on the way" until the outlet counts and confirms them. Any shortfall is logged as transit breakage and reported.
- **Opening and closing counts** at every sales point compare the physical count with the book and record any difference.
- **Egg grades.** Normal, big, jumbo / double yolk and cracked (sellable) are stock, each with its own price. Damaged / broken eggs are recorded at collection, on arrival and at the outlets, and always written off.
- **Issued out.** Eggs that leave an outlet without a sale (credit customers, bulk orders) are recorded with who received them.
- **Missed days.** The owner and farm manager can enter a day up to 62 days back (daily house sheet, daily stock sheet). If a later stock count already absorbed the missing record as a variance, that variance is reduced by the same amount, so nothing is counted twice.
- **Paper-book imports** are flagged `imported`; their money is history and stays out of account balances, which start at go-live.
- **The database enforces the rules.** All writes go through database functions that check the person's role and location; row-level security means a shop attendant's phone cannot even download another location's figures.

## Feed buffer and water

Feed and the water tank use the same five colour bands:

| Band | Level |
|---|---|
| Full buffer (green) | 100% or more |
| Good | 75–99% |
| Watch (yellow) | 50–74% |
| Low (orange) | 25–49% |
| No buffer (red) | below 25% |

- **Feed:** the full buffer is the weekly requirement, set in Setup in **bags** (default **315 bags**, kept in kg as bags × bag size). Feed is shown in bags everywhere. When a feed entry drops the store into a worse band, the manager is notified at once.
- **Water:** the clerk records litres drunk per house and tank readings. Alerts fire when a house drinks 10% less than its 7-day average (often the first sign of disease or a blocked line), when the water-to-feed ratio leaves 1.6–2.5 L per kg, and when the tank drops into Low or No buffer.

A database job runs every morning at 06:00 Nairobi time to check water, lay rate, feed, tank, vaccinations due, low medicine and unbanked cash.

## Sign-in and security

Everyone signs in with a **username and password**. **Two-step sign-in** (a 6-digit code from an authenticator app such as Google or Microsoft Authenticator) is optional for every role and is turned on or off under My account. It is strongly recommended for the owner and farm manager, whose accounts can see and move money.

* **Temporary password `0000`.** New accounts, and accounts the owner resets, get the temporary password 0000. It works once, for 72 hours, and only lets the person choose their own password: nothing else in the app or the database is reachable until they do.
* **Password rules (checked on the server):** at least 8 characters with a lowercase letter, a capital, a number and a symbol; not one of the 10,000 most common passwords (also with capitals, numbers or look-alike characters added: `Password123!`, `P@ssw0rd`); no runs like `12345` or `qwerty`; not the person's name or username or the farm's name; and not found in a known data breach (Have I Been Pwned, checked with k-anonymity: only 5 characters of a hash leave the server). The app shows a strength meter while typing.
* **Limits:** per network (IP), 5 failed attempts per 15 minutes per action; per account, a growing wait after each failure (1, 2, 4, 8 s), then a lockout after 5 failures for 15 minutes, doubling each time it happens again (up to 24 hours). After 3 failures the device must pass a security check (a built-in puzzle the phone solves in about a second, or Cloudflare Turnstile if configured). The same limits cover two-step codes and password changes. The owner can unlock an account early.
* **Sessions** live in `HttpOnly; Secure; SameSite=Strict` cookies that the page's JavaScript cannot read, handled by the gateway at `/api/gateway`. Nothing about the session or the farm's data is kept in browser storage. A session ends after 12 hours, at sign-out, when the password changes (other devices), or when the owner resets or disables the account.
* **The database decides.** Every database function checks, on every call, that the session is live, the account active, the password not temporary and, where needed, that this session passed two-step sign-in. The app's screens only show or hide buttons.
* **Log.** Every sign-in, code, password change and staff change is recorded with time, IP and device. The owner sees it under Activity → Security.

### Owner recovery

If the owner loses both the phone and the backup codes, or the temporary password expires, run this in the Supabase dashboard (SQL editor), then sign in again:

```sql
-- remove the owner's two-step sign-in (they set it up again at the next sign-in)
delete from public.mfa_backup_codes where staff_id = (select id from public.staff where username = 'owner');
delete from public.mfa_factors      where staff_id = (select id from public.staff where username = 'owner');
-- give a temporary password more time (the password itself is unchanged)
update public.staff set temp_expires_at = now() + interval '72 hours' where username = 'owner' and must_change_password;
```

## Live project

| | |
|---|---|
| Supabase project | `desert-pearl-poultry` (ref `aokegaxznbobbuqnwgdo`, London) |
| Database | migrations in `supabase/migrations`, applied |
| Edge functions | `auth`, `staff-admin`, `push-notify` (and retired stubs `pin-login`, `change-pin`) |
| Staff accounts | `owner`, `manager`, `clerk`, `farm`, `van`, `tuala`, `rayan`, `lucky` |

## Put the app online (Vercel)

The site is static (`dist/`) plus one Edge Function, `api/gateway.ts`. `vercel.json` sets the build, the security headers (Content-Security-Policy, HSTS, no framing, etc.) and the routes.

1. On vercel.com: **Add New → Project →** import `guyo69/desert-pearl-poultry`. Framework: Vite (detected).
2. **Settings → Environment Variables** (Production, Preview and Development):
   * `SUPABASE_URL` = `https://aokegaxznbobbuqnwgdo.supabase.co`
   * `SUPABASE_ANON_KEY` = the project's anon key (Supabase → Project Settings → API)
   * `DPV_GATEWAY_SECRET` = the result of this query in the Supabase SQL editor (keep it secret):
     `select value from public.app_secrets where key = 'gateway_secret';`
3. Deploy. Then on each phone open the site and use **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: menu → Install app). On iPhone, phone notifications only work after the app is added to the Home Screen.

**In Supabase, once:** Authentication → Sign In / Providers → Email: turn **off** "Allow new users to sign up". Staff accounts are only created by the owner. (Even with it on, a self-made account has no staff record and can do nothing, but there is no reason to allow it.)

**Optional, Cloudflare Turnstile** instead of the built-in puzzle: create a Turnstile widget for your domain, then in Supabase → Edge Functions → Secrets add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET`.

## Go-live checklist

1. Owner signs in with username `owner` and their current PIN as the temporary password (or `0000`), chooses a password and, recommended, sets up two-step sign-in and saves the backup codes.
2. Setup → Staff: rename each account to the real person, set usernames, add or disable as needed.
3. Setup → Houses: hens in each house, the start date and their age, expected lay rate from the breed guide.
4. Setup → Prices & thresholds: tray prices, feed bag price and size, feed buffer, **tank size**.
5. On go-live morning: Setup → **Opening balances**: physical egg counts at all 5 locations, cash at each, Till, Paybill and bank balances, feed in store, water in the tank, medicine stock.
6. Each person signs in on their phone with their username and `0000`, chooses a password (two-step sign-in is optional; recommended for the farm manager), and turns on phone notifications under My account. Temporary passwords expire after 72 hours; the owner can reset them.

## Development

```bash
npm install
cp .env.example .env.local   # fill in the three gateway values (never commit .env.local)
npm run dev                  # http://localhost:5173, with the gateway at /api/gateway
npm test                     # dashboard arithmetic, gateway and puzzle tests
npm run build
```

Database tests run on a local Postgres (no Supabase needed):

```bash
PGHOST=/tmp PGPORT=5433 PGUSER=postgres supabase/tests/run.sh
```

Edge function unit tests (TOTP, password rules, breach check, puzzle): `deno test --allow-env --allow-net supabase/functions/tests/`

`supabase/tests/02_demo_seed.sql` loads 30 days of realistic demo history into a **local** database for trying the screens. Never run it on the live project.

### Layout

```
supabase/migrations/   schema, actions (rpc_*), reads + security, push
supabase/functions/    auth, staff-admin, push-notify (Deno); _shared: TOTP, password policy, puzzle
api/gateway.ts         Vercel Edge Function: session cookies, CSRF checks, routing
src/lib/metrics.ts     every dashboard figure, alert and the weekly report
src/forms/forms.tsx    every data-entry form
src/views/             screens per role
tests/                 unit tests + fixtures exported from the database
```

### Refreshing and data use

Phones ask `data_version()` once a minute while the app is on screen (a few bytes) and download the full dashboard only when it changed, at most every 2 minutes, or straight after a save. A write anywhere moves the counter.

### Backups

Every Sunday at 23:00 Nairobi (`pg_cron` job `dpv-weekly-backup`) the `backup` function writes the farm records as gzipped JSON to the private Storage bucket `backups` and keeps the newest 12. Sign-in secrets, two-step keys and push addresses are left out. The owner can back up now and download under Activity → Setup → Backups.

To restore into a database that has the migrations applied:

```
node scripts/backup-to-sql.mjs dpv-2026-11-08-20-00.json.gz > restore.sql
psql "<connection string>" -v ON_ERROR_STOP=1 -f restore.sql
```

The SQL runs in one transaction and moves the id counters past the restored rows. Staff sign-in accounts are recreated by the owner afterwards.

### Retiring the old egg functions

`20261101000009_retire_grade_blind.sql` removes the functions that cannot record big or damaged eggs. Apply it once the app version with egg grades is live on every phone.

### Deploying function changes

The functions import `../_shared/*.ts`. With the Supabase CLI: `supabase functions deploy <name> --no-verify-jwt`. They refuse any call that does not carry the gateway secret (`push-notify` POST: the database trigger secret), and check the session themselves.

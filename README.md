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

- **Feed:** the full buffer is the weekly requirement, set in Setup (default **315 kg**). When a feed entry drops the store into a worse band, the manager is notified at once. Note: 45 bags of 50 kg is about 2,250 kg/week (≈315 kg/day); change the setting when the feed formula is confirmed.
- **Water:** the clerk records litres drunk per house and tank readings. Alerts fire when a house drinks 10% less than its 7-day average (often the first sign of disease or a blocked line), when the water-to-feed ratio leaves 1.6–2.5 L per kg, and when the tank drops into Low or No buffer.

A database job runs every morning at 06:00 Nairobi time to check water, lay rate, feed, tank, vaccinations due, low medicine and unbanked cash.

## Sign-in

Staff tap their name and enter a PIN. **Every new account starts with PIN 0000**, and the app asks them to change it (Menu → Change PIN, or My account). The owner can reset anyone's PIN back to 0000 from Setup → Staff. Five wrong PINs lock an account for 15 minutes.

PINs are never stored. Each PIN is combined with a secret server key before it reaches Supabase Auth, so it can only be tried through the app's sign-in, which has the lockout.

> **Do this first:** sign in as **Owner** with 0000 and change the PIN straight away. Until then anyone who opens the app can sign in as the owner.

## Live project

| | |
|---|---|
| Supabase project | `desert-pearl-poultry` (ref `aokegaxznbobbuqnwgdo`, London) |
| Database | migrations in `supabase/migrations`, already applied |
| Edge functions | `pin-login`, `change-pin`, `staff-admin`, `push-notify`, already deployed |
| Staff accounts | 8 created (Owner, Farm Manager, Production Clerk, Farm Counter, Van Driver, 3 shop attendants), all PIN 0000 |

## Put the app online

The app is a static site (`npm run build` → `dist/`). The quickest free host is Vercel, Netlify or Cloudflare Pages:

1. Import this GitHub repo on the host.
2. Build command `npm run build`, output folder `dist`.
3. Environment variables are already in `.env.production`. They are the public project URL and anon key; data is protected by the database rules, not by hiding these.
4. Add a rewrite of all paths to `/index.html` if the host asks (single-page app).

Then on each phone open the site and use **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: menu → Install app). On iPhone, phone notifications only work after the app is added to the Home Screen.

## Go-live checklist

1. Owner signs in, changes PIN.
2. Setup → Staff: rename each account to the real person, add or disable as needed.
3. Setup → Houses: hens in each house, the start date and their age, expected lay rate from the breed guide.
4. Setup → Prices & thresholds: tray prices, feed bag price and size, feed buffer, **tank size**.
5. On go-live morning: Setup → **Opening balances**: physical egg counts at all 5 locations, cash at each, Till, Paybill and bank balances, feed in store, water in the tank, medicine stock.
6. Each person signs in on their phone, changes PIN, and turns on phone notifications under My account.

## Development

```bash
npm install
cp .env.example .env.local   # or use .env.production values
npm run dev                  # http://localhost:5173
npm test                     # dashboard arithmetic tests against exported real data
npm run build
```

Database tests run on a local Postgres (no Supabase needed):

```bash
PGHOST=/tmp PGPORT=5433 PGUSER=postgres supabase/tests/run.sh
```

`supabase/tests/02_demo_seed.sql` loads 30 days of realistic demo history into a **local** database for trying the screens. Never run it on the live project.

### Layout

```
supabase/migrations/   schema, actions (rpc_*), reads + security, push
supabase/functions/    pin-login, change-pin, staff-admin, push-notify (Deno)
src/lib/metrics.ts     every dashboard figure, alert and the weekly report
src/forms/forms.tsx    every data-entry form
src/views/             screens per role
tests/                 unit tests + fixtures exported from the database
```

### Deploying function changes

The functions import `../_shared/util.ts`. With the Supabase CLI: `supabase functions deploy <name> --no-verify-jwt` (the functions check sign-in themselves; `push-notify` is called by the database).

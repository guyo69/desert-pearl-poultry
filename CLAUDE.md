# Desert Pearl Poultry Manager

A live production web app (installable on phones) for Desert Pearl Ventures, which trades as Tuala Farm Fresh Eggs. It covers farm production, feed, water and medicine, egg collection, van dispatch, outlet stock and sales, money, reports and reminders. Real staff use it every day, so treat every change as a production change.

## Where things live

- **GitHub:** `guyo69/desert-pearl-poultry`. `main` deploys to production on Vercel automatically. Any other branch gets a preview link.
- **Vercel:** project `desert-pearl-poultry`, team `halkano`. Production address: https://desert-pearl-poultry.vercel.app
- **Supabase:** project `aokegaxznbobbuqnwgdo`. It holds the Postgres database, the edge functions and pg_cron.
- **Front end:** `src/`. React 18, Vite and TypeScript. The screens are in `src/views/`, the forms in `src/forms/forms.tsx`, and the calculations in `src/lib/metrics.ts`.
- **Gateway:** `api/gateway.ts`, a Vercel edge function. It holds the session in HttpOnly cookies, checks for CSRF via the `X-DPV` header, and only lets through RPC names on its allowlist.
- **Database:** `supabase/migrations/`, numbered and applied in order. All writes go through SECURITY DEFINER `rpc_*` functions that start with `_require(...)`.
- **Edge functions:** `supabase/functions/`, with shared code in `_shared/`.
  - `staff-admin`: staff tools for the owner, and for the farm manager on every account except owners (no owner accounts, no making owners, not their own account); backups are owner only and no longer shown in the app.
  - `backup`, `push-notify`, `auth`.
- **Older functions:** `pin-login` and `change-pin` are from the old PIN sign-in. Never bring PIN sign-in back.

## Commands

```bash
npm ci                 # install
npm run dev            # local dev (needs .env.local; see .env.example)
npm run build          # type-check and production build
npm test               # vitest: gateway, metrics, sha256
npm run test:db        # SQL and pgTAP tests (supabase/tests/run.sh; needs a local Postgres with pgTAP)
deno test supabase/functions/tests/   # edge function unit tests
```

Before you push, run `npm test` and `npm run build`. If you touch SQL, also run the database tests. `supabase/tests/03_auth.sql` requires every `rpc_*` function to call `_require`.

## Rules for working on this repo

1. Work on a branch and check the Vercel preview before anything reaches `main`.
2. Make every database change a new numbered migration in `supabase/migrations/`. Never run ad hoc SQL against production.
3. Never change or delete existing data. Never modify existing `rpc_*` or auth functions unless it can't be avoided, and say so first.
4. Never weaken the security hardening. That covers the cookie sessions, CSRF checks, the RPC allowlist, rate limits, the password policy, optional two-step sign-in and the `revoke execute` rules.
   - Revoke `execute` on new functions from `public` and `anon`.
   - Revoke internal helpers from `authenticated` as well.
5. Secrets live in Supabase edge-function secrets or in the `app_secrets` table.
   - Never print, log or commit them, or read `app_secrets` into output.
   - For Vercel environment variables, work with names only, never values.
6. **No Claude or AI attribution anywhere in the repo.**
   - Commits: no `Co-Authored-By: Claude` and no "Generated with Claude Code" lines.
   - Pull requests: no attribution footers.
   - Commit as the repo owner.
7. Ask at most one question at a time.
8. When writing text the app shows to people: plain words, no em dashes, no exclamation marks, and never "n/a". Compare with the week before only when that week was fully entered.

## How the reporting works

- **Notifications are reminders only** (since 3 Nov 2026). `reminders(slot)` runs through pg_cron and sends each reminder at most once a day, and only when there is something to do:
  - 09:00 Nairobi (`morning`): sales points without an opening count; the van's start of day; the production clerk if the tank is not read; the inventory clerk only when stock is low or issues are unconfirmed.
  - 19:00 (`evening`): sales points not yet closed; the van if eggs are still on board; the production clerk if eggs or water are missing.
  - 21:00 (`close`): one day-close summary to the owner and farm manager.
  - `_notify` and `_notify_once` drop everything that is not kind `reminder` or `day_close`, so no event alert is sent. Live alerts still show on the app's screens.
- **`weekly_facts(from, to, role, loc)`** is the insight engine. It ranks missing entries first, then whether a fair comparison is possible, then anomalies measured against the farm's own settings. It keeps at most 5 points and scopes them by role:
  - `owner` sees everything.
  - `manager` sees farm operations, outlets and money.
  - `clerk` sees the farm only.
  - `store` (inventory clerk) gets no weekly insights yet.
  - `pos` sees its own outlet, with no cash.
- **`rpc_weekly_report()`** feeds the Report screen. It covers the last 7 days to yesterday, for the owner and the farm manager only.
- **No report email.** The weekly digest, the reminder emails and the opt-out link were repealed on 3 Nov 2026. The old `digest_log` and `nudge_log` tables are kept as history. The only email the app sends is account recovery (below). Do not bring other email back without the client asking.

## Business rules (from the client, 2 Nov 2026)

- **Owner is view-only for the day's records.** The `owner_view_only` trigger refuses any insert, update or delete by a signed-in owner on the record tables. Setup stays open to the owner: houses, staff, prices, thresholds, the medicine list, the schedule and go-live opening balances. In the UI, `canEnter(D)` hides entry buttons.
- **No corrections from the app.** The Correct button is gone. The app records what staff enter and never changes it.
- **Big eggs count as Normal.** The forms no longer offer Big; older records keep their Big figures, shown inside Normal.
- **"Issue eggs" means sending eggs to another location** (a transfer the receiver confirms), one destination per entry. The older stock-out form is now "Out, no sale".
- **Credit is a payment method on a sale** (`rpc_sale_with_credit`, `sales.credit`); credit needs the customer's name and does not reach any cash account.

## Business rules (from the client, 3 Nov 2026)

- **Credit paid:** `rpc_credit_paid` records a customer paying what they owe (cash, Till or Paybill), set against their oldest credit sales first (`credit_payments`). The money reaches the account through `v_money_lines` (kind `credit_paid`). The dashboard's `credits` list feeds the "Outstanding credits" card.
- **Water drunk lowers the tank:** the tank level is the last reading less the water drunk since it (`_tank()` and the dashboard's `tank`). A new reading resets it.
- **The activity log is ordered by the day a record is for** (`activity(..., p_cursor)`), newest day first, not by when it was entered.
- **Skipped days:** the farm manager can enter feed used, water drunk, deaths and medicine for an earlier day, up to 62 days back (`rpc_farm_record_on`). The daily house sheet and shop sheet already take a date.
- **Farm manager Setup tab:** houses, prices and thresholds (`rpc_save_settings`), staff other than owners, and the monthly workbooks. Opening balances and the security log stay with the owner.
- **Monthly outlet workbooks (owner and farm manager):** Activity → Setup and the Report screen list one workbook per month. `rpc_month_book(month)` returns each outlet's day as entered; `src/lib/monthBook.ts` lays it out like the client's Daily Outlet Report template (yellow = entered, grey = formulas, values cached for phone previewers) and `src/lib/xlsx.ts` writes the file in the browser. The current month covers every day to yesterday, and today once an outlet has a closing count. This replaced the Backups card; the weekly JSON backup still runs on Sunday nights for disaster recovery.
- **Inventory clerk (role `store`):** runs the farm store through `rpc_store(action, p)`: feed, medicine and other supplies (`supplies`, `supply_moves`), quantities only (the farm manager records payments). Feed and medicine are issued to a house with `need_confirm`; the production clerk confirms what arrived (`rpc_confirm_issue`, `issue_confirms`); a shortfall is on record in the activity log. The production clerk no longer records feed or medicine; the daily house sheet only takes feed from the farm manager.
- **The van (location kind `van`) has no counts.** It loads (receives), delivers to the farm or outlets, sells, and must end the day empty (drop what is left with Deliver eggs). `completeness()` checks "eggs left on the van" instead of opening and closing counts. The driver banks or sends the cash.
- **Lucky Summer was a test outlet:** its records and the 3 Nov test entries were removed (migration 15).

## Business rules (from the client, 4 Nov 2026)

- **The farm mills its own layers feed** (from the inventory clerk's stock ledger). `raw_materials` holds the list and the recipe in kg per tonne of feed; the materials in use must add up to 1,000 kg. The farm's recipe is seeded: Maize 533, Wheat bran 180, Soybean 130, Sunflower cake 50, Limestone (white) 50, Chick grit 42, Macropack 15.
- **`rpc_mill(action, p, date)`** (inventory clerk and farm manager): `raw_in` (a delivery, bags or kg), `mill` (tonnes mixed: takes each material by the recipe into `raw_moves` kind `mill`, records a `mill_batches` row with the recipe used, and adds tonnes x 1,000 kg to `feed_moves` as kind `in`), `raw_count` (what was counted; the difference from the book is a `count` move). Milling is refused when any material is short, naming it.
- **`rpc_recipe_save(rows)`** (owner and farm manager) saves the list and recipe together. A change applies to the next milling; each batch keeps its own recipe.
- **Screens:** the Feed mill tab (store, manager, owner) shows what the store can mill, which material runs out first, the recipe and the mill records. Activity kinds `mill` and `raw`; feed made by milling shows as the milling, not as a feed delivery.
- **Monthly workbook:** `rpc_month_book` also returns `materials`, `ledger` (per material per day it moved: opening, purchase, used, count adjustment, tonnes), `feed` (per day: milled, bought, used by house, adjustment, eggs), `houses`, `feed_open` and `feed_bag_kg`. `monthBook.ts` adds a Store ledger tab in the clerk's layout (closing = opening + purchase - used + adjustment, each opening linked to the previous closing, month KPIs over every row) and a Feed tab.
- **Store morning reminder** also names the raw material that limits milling when the store cannot make a usual batch (the biggest in the last 30 days, else 5 tonnes).

## Changes from the client, 5 Nov 2026

- **Tabs:** Activity is the record log only. **Settings** (owner and farm manager) holds houses and flocks, staff, prices and thresholds, the monthly workbooks, opening balances, the security log (owner) and My account. An old `#setup` link opens Settings.
- **Houses and flocks** (`flocks`, `houses.breed`, `rpc_flock(action, p)`: `house_new`, `place`, `edit`, `end`) for the owner, farm manager and production clerk. One flock per house at a time; placing a new flock ends the one before. The house's current-flock fields follow its current flock, and `farm_daily2()` counts hens from the flock in the house on each day, so earlier flocks keep their history. A house with no flock on record still counts from the house list. The Houses and flocks card is on Flock health and Settings. `rpc_save_house` is used from the app only to rename a house or take it out of use.
- **Weekly report** (`src/lib/report.ts`, `src/lib/knowledge.ts`): written as a report, with no "provisional" labels. Records entered come first as a finding and in a Data coverage section; every flock is judged against the Hy-Line Brown performance standard for its age (low end of each published range, projected past 100 weeks) unless the house has a realistic target (a target of 97% or more counts as not set). The server's `weekly_facts` still supplies the numbers; the app writes the words.
- **Interface:** dropdown options use the app's colours (no white on white in dark mode), text actions (`.lnk`, `.act`) are boxed buttons, loading shows skeletons instead of spinners, and lists, tiles, buttons and tables have hover and press motion (off with reduced motion).

## Account recovery (from the client, 8 Nov 2026)

- **Recovery email:** the owner and farm manager add one under My account (`auth` actions `recovery_start`, `recovery_confirm`: a 6-digit code sent to it). The owner is asked for it after signing in until one is confirmed (`staff.recovery_email`, `recovery_verified_at`).
- **Forgot password** on the sign-in screen: `reset_request {username}` emails a 6-digit code (15 minutes, at most 3 an hour, the same answer whether or not the account exists); `reset_confirm {username, code, new_password}` checks the policy, sets the password, ends every session and lifts the sign-in lock. Two-step sign-in is still asked at the next sign-in. Both are public gateway actions with their own rate limits (`reset_request`, `reset`).
- **Break-glass:** `select issue_recovery_code('owner');` in the SQL editor returns a one-use code valid 24 hours (console only: no API role can call it; it is logged). The person uses Forgot password, I already have a code.
- Codes live in `account_codes` as salted SHA-256 hashes; five wrong tries burn a code. Email goes through Resend: edge-function secrets `RESEND_API_KEY` and `MAIL_FROM` on a verified domain (`_shared/mail.ts`).

## In-app help (from the client, 9 Nov 2026)

- **Tips on the real buttons** (`src/ui/Help.tsx` `TipHost`): one at a time, each a short line pointing at an element tagged `data-tip` (tiles get `tile:<label>`, nav buttons `tab:<key>`, step buttons `step:<label>`, plus `steps`, `gaps`, `mill`, `houses`, `today`, `findings`, `search`, `help`, `fab`). A tip shows only when its element is on screen and nothing is open on top; order follows each role's day. Seen tips are kept per person (`staff.tips_seen`, `rpc_tips(add, reset)`), so a new phone does not replay them. Help, Show me around replays the current screen's tips.
- **Help button** (top bar, every screen): How to (role tasks in daily order, each with Open it), Questions (role FAQs), Show me around, Search.
- **Search** (top bar, or Ctrl+K): screens, actions that open the form directly, and help answers, filtered by role and by `canEnter`.
- **One source:** `src/lib/help.ts` holds the tips, tasks and questions for each role (`pos`, `van`, `clerk`, `store`, `manager`, `owner`); `tests/help.test.ts` keeps tips short and every how-to linked to a real action. When a feature is added, add its tip there with a new id: only that tip shows to people who saw the rest.

## Blind counts and the interface refresh (from the client, 10 Nov 2026)

- **Blind counts:** the opening count, Close the day and Count cash show no book stock, no expected cash and nothing pre-filled. The person enters what they see; the server works out the difference and the app shows it only after saving ("The farm manager can see it"). On the Daily stock sheet the outlet attendant (`pos`) sees no book closing and no expected cash. The attendant's Today screen shows Cash counted (or Not yet), never the expected cash, and Money shows the expected total only after a count. Owner and farm manager screens are unchanged.
- **Interface:** Geist type (self-hosted latin subset, no third-party fonts, works offline), tinted neutrals with an off-black dark mode, at least 44px touch targets and 48px for field roles (`html[data-field]`, set for every role except owner and manager), a tinted pill on the current tab, sentence-case table and section labels, composed empty states and a short staggered page entry (off with reduced motion).

## Open items

- **Tank size:** `settings.tank_capacity_l` is 1,000 L while the farm sheet showed about 3,500 L drunk per house a day. Confirm the real tank size, then record a fresh tank reading.
- **Lay rates:** both houses have expected lay at 100%. The report now uses the breed guide instead, and says so; set a realistic target with Edit flock. Both flocks are about 110 weeks old (placed Dec 2024 and Jan 2025 at 12 and 14 weeks); set their breed too.
- **Closed days:** outlets are set as closed on Sunday (`locations.closed_dow = '{7}'`). The client said they would confirm this.
- **Raw material opening stock:** the app's raw store starts empty. The inventory clerk should count each material once (Count the store) to bring in the ledger's closing stock. The paper ledger's 3 Nov wheat bran opening (6,390 kg) did not follow from the 29 Oct closing (1,273 kg); 5,117 kg was not recorded as a delivery.
- **Recovery email sending:** the Resend domain studio.sagedesigns.co.ke is verified and the secrets are set (9 Nov 2026). The API key was shown in a screenshot: rotate it in Resend and set the new one.
- **Later phases:** invoicing and a payment gateway are proposed, not built, and each needs its own scope agreement.

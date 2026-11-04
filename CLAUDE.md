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
- **There is no email.** The weekly digest, the reminder emails and the opt-out link were repealed on 3 Nov 2026. The old `digest_log` and `nudge_log` tables are kept as history. Do not bring email back without the client asking.

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

## Open items

- **Tank size:** `settings.tank_capacity_l` is 1,000 L while the farm sheet showed about 3,500 L drunk per house a day. Confirm the real tank size, then record a fresh tank reading.
- **Lay rates:** set a realistic expected lay rate for each house. Both are at 100% now, so every week reports a shortfall.
- **Closed days:** outlets are set as closed on Sunday (`locations.closed_dow = '{7}'`). The client said they would confirm this.
- **Raw material opening stock:** the app's raw store starts empty. The inventory clerk should count each material once (Count the store) to bring in the ledger's closing stock. The paper ledger's 3 Nov wheat bran opening (6,390 kg) did not follow from the 29 Oct closing (1,273 kg); 5,117 kg was not recorded as a delivery.
- **Later phases:** invoicing and a payment gateway are proposed, not built, and each needs its own scope agreement.

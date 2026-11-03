# Desert Pearl Poultry Manager

A live production web app (installable on phones) for Desert Pearl Ventures, which trades as Tuala Farm Fresh Eggs. It covers farm production, feed, water and medicine, egg collection, van dispatch, outlet stock and sales, money, reports, reminders and the weekly email digest. Real staff use it every day, so treat every change as a production change.

## Where things live

- **GitHub:** `guyo69/desert-pearl-poultry`. `main` deploys to production on Vercel automatically. Any other branch gets a preview link.
- **Vercel:** project `desert-pearl-poultry`, team `halkano`. Production address: https://desert-pearl-poultry.vercel.app
- **Supabase:** project `aokegaxznbobbuqnwgdo`. It holds the Postgres database, the edge functions and pg_cron.
- **Front end:** `src/`. React 18, Vite and TypeScript. The screens are in `src/views/`, the forms in `src/forms/forms.tsx`, and the calculations in `src/lib/metrics.ts`.
- **Gateway:** `api/gateway.ts`, a Vercel edge function. It holds the session in HttpOnly cookies, checks for CSRF via the `X-DPV` header, and only lets through RPC names on its allowlist.
- **Database:** `supabase/migrations/`, numbered and applied in order. All writes go through SECURITY DEFINER `rpc_*` functions that start with `_require(...)`.
- **Edge functions:** `supabase/functions/`, with shared code in `_shared/`.
  - `weekly-digest`: the Monday email with its Excel attachment, plus the daily missing-entry emails.
  - `digest-optout`: the one-click unsubscribe.
  - `staff-admin`: owner-only staff tools and backups.
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

- **`daily_checks()`** runs at 06:00 Nairobi time through pg_cron. It checks the previous day with `completeness()`, then posts reminders through `_notify_once` and, when the email secrets are set, sends emails.
- **`weekly_facts(from, to, role, loc)`** is the insight engine. It ranks missing entries first, then whether a fair comparison is possible, then anomalies measured against the farm's own settings. It keeps at most 5 points and scopes them by role:
  - `owner` sees everything.
  - `manager` sees farm operations, outlets and money.
  - `clerk` sees the farm only.
  - `pos` sees its own outlet, with no cash.
- **`rpc_weekly_report()`** feeds the Report screen. It covers the last 7 days to yesterday, for the owner and the farm manager only.
- **The weekly digest** goes out Mondays at 06:30 Nairobi time (03:30 UTC), with a retry at 08:30. `digest_enqueue()` sends one call per recipient, and the `digest_log` and `nudge_log` tables stop anything sending twice.

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
- **Lucky Summer was a test outlet:** its records and the 3 Nov test entries were removed (migration 15).

## Open items

- **Email secrets:** add these in Supabase under Edge Functions → Secrets:
  - `RESEND_API_KEY`
  - `DIGEST_FROM` (an address on a domain verified in Resend)
  - `DIGEST_REPLY_TO` (optional)
  - `ANTHROPIC_API_KEY`
  - `ANTHROPIC_MODEL`
  - `DPV_APP_URL`
- **Email domain:** verify a Desert Pearl domain in Resend, with SPF, DKIM and DMARC records.
- **Staff emails:** add each person's address on the Settings → Staff screen.
- **Tank size:** `settings.tank_capacity_l` is 1,000 L while the farm sheet showed about 3,500 L drunk per house a day. Confirm the real tank size, then record a fresh tank reading.
- **Lay rates:** set a realistic expected lay rate for each house. Both are at 100% now, so every week reports a shortfall.
- **Closed days:** outlets are set as closed on Sunday (`locations.closed_dow = '{7}'`). The client said they would confirm this.
- **Later phases:** invoicing and a payment gateway are proposed, not built, and each needs its own scope agreement.

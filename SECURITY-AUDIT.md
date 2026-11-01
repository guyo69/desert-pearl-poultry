# Security audit: sign-in and access (30 Oct 2026)

Scope: everything between a person and the farm's data. That covers the browser app, the Vercel gateway, the Supabase edge functions, Supabase Auth and the Postgres database (functions, row-level security and grants).

## Findings and fixes

| # | Finding (before) | Severity | Fix |
|---|---|---|---|
| 1 | Session tokens (access + refresh) were stored in `localStorage` (`dpv-session`), where any injected script could read them. | Critical | Tokens now live only in `__Host-dpv_at` / `__Host-dpv_rt` cookies with `HttpOnly; Secure; SameSite=Strict; Path=/`, set by the gateway (`api/gateway.ts`). The browser bundle no longer includes supabase-js. Old keys are wiped on first load. |
| 2 | Farm data was cached in `localStorage` (`dpv-dashboard`) and stayed on shared phones after sign-out. | High | The data is now kept in memory only. The service worker never caches `/api/*`. |
| 3 | The 4-digit PIN sign-in could be brute-forced: 10,000 combinations, 5 tries per 15 minutes, no IP limit, no CAPTCHA, no log. | Critical | Replaced with a username and password, with the rules below (items 9–13). |
| 4 | There was no two-factor authentication. | Critical | Added TOTP (RFC 6238) with 10 single-use backup codes. It was first enforced for the owner and farm manager; on 30 Oct 2026 the owner chose to make it optional for every role (see Remaining notes). Codes cannot be replayed (one use per 30-second step). Secrets are stored encrypted with AES-256-GCM. Codes share the account lockout. |
| 5 | Authorization in the UI only showed or hid tabs and buttons. The server enforced roles, but it never checked the state of the session. | High | The database gate `_session_state()` is called by `_require()`, by every rpc, by `dashboard()` and `activity()`, and by every row-level policy helper. It checks five things: the session exists, the session is under 12 hours old, the account is active, the password is not temporary, and two-step sign-in was passed in this session. The owner-only staff tools check the same state on the server. |
| 6 | Staff names and roles were readable by anyone without signing in (`staff_directory`), so accounts could be listed. | Medium | Removed from anonymous access. Sign-in now uses a typed username, and every failure gives the same answer ("Wrong username or password"). Failed sign-ins take the same time whether or not the account exists. |
| 7 | Signed-in staff could read other people's security columns (`failed_attempts`, `locked_until`, `must_change_pin`). | Low | Column-level grants now expose only `id, display_name, role, location_id, active, created_at`. Managers get security status through a function. |
| 8 | Internal helpers `_eggs` and `_kes` could be executed by signed-in users. Supabase's default grants would also expose new functions. | Low | All grants were restated. Anonymous users can execute nothing. Signed-in users can execute only the app's functions. Default privileges were revoked. |
| 9 | There was no IP-based rate limiting. | High | Each IP gets 5 failures per 15 minutes per action, and at most 40 requests per 15 minutes. This covers sign-in, two-step codes, password changes, the security check, first-time setup and staff admin. The gateway supplies the real client IP. The functions refuse any call that does not carry the gateway secret, so the limits cannot be bypassed by calling Supabase directly. |
| 10 | There was no backoff or progressive lockout. | High | After each failure the account must wait 1, 2, 4, 8 … seconds. After 5 failures it is locked for 15 minutes, and each repeat lockout doubles that time, up to 24 hours. Counters are kept per username, so lockouts behave the same for real and made-up usernames. The owner can unlock an account. |
| 11 | There was no CAPTCHA. | Medium | After 3 failures the sign-in requires a built-in proof-of-work check. The device solves a signed puzzle in about a second. Each puzzle is bound to the IP, lasts 2 minutes and can be used once. Cloudflare Turnstile can be switched on instead. |
| 12 | Failed attempts were not logged. | Medium | `auth_events` records every sign-in, two-step code, password change, sign-out and staff-admin action, with the IP and device. The owner reads it under Activity → Security. |
| 13 | There was no password policy. | High | Enforced on the server: 8 to 128 characters, with a lowercase letter, a capital, a number and a symbol. Passwords are refused if they are in the top 10,000 common passwords, if they are a common password with numbers, symbols or look-alike letters added, if they contain runs or repeats, if they contain the person's name or username, or if they contain the business name. They are also checked against Have I Been Pwned using k-anonymity (only 5 hash characters are sent). The app shows a strength meter (zxcvbn) and a checklist. |
| 14 | Default PIN 0000 never expired. | High | 0000 is now a temporary password. It works for 72 hours and only allows setting a new password. Existing accounts were moved to the same rule (an old PIN works once). |
| 15 | Sessions were not ended on a password change, reset or disable. | Medium | These now end sessions through `auth.sessions.not_after`, which both Supabase Auth (on refresh) and the database gate (on every request) respect. Sessions also have a 12-hour absolute limit. |
| 16 | `push-notify` could be called by anyone. | Low | POST now requires a secret held by the database trigger. |
| 17 | There were no security headers. | Medium | `vercel.json` adds the following headers. Content-Security-Policy: scripts only from the site itself (plus Turnstile), `connect-src 'self'`, `frame-ancestors 'none'` and `object-src 'none'`. HSTS with preload. `X-Frame-Options: DENY`. `nosniff`. `Referrer-Policy: no-referrer`. A restrictive Permissions-Policy. COOP and CORP set to `same-origin`. |
| 18 | CSRF. | Medium | Cookies are `SameSite=Strict`. The gateway also requires an `X-DPV` header, a same-origin `Origin` header, `Sec-Fetch-Site` and a JSON content type. Only allow-listed routes and functions are forwarded. |

## Verified

* SQL tests (`supabase/tests/03_auth.sql`), run on Postgres: privilege sweep, session gate states, the 12-hour limit, sign-out, disable, MFA ordering, IP limit, backoff, lockout doubling, unlock, CAPTCHA threshold, single-use puzzles and event logging.
* Deno tests for the following: RFC 6238 test vectors, replay refusal, AES-GCM binding, backup codes, password rules, the HIBP k-anonymity request, puzzle signing, puzzle expiry and puzzle IP binding.
* Gateway tests: cookie flags, tokens never returned to the browser, CSRF refusals, refresh, sign-out on refusal, mapping of database AUTH errors, route allow-list and body size limit.
* Browser test under the production CSP, with no console errors: failed sign-ins, the security check solved in a web worker, refusal of weak and common passwords, two-step set-up and backup codes, and sign-in with a code. After sign-in, `localStorage`, `sessionStorage` and `document.cookie` were all empty.
* Live project checks:
  * Without the gateway secret, the server answers 404.
  * An unknown user and a wrong password get the same 401 answer.
  * A temporary-password session gets `AUTH_PASSWORD` for both the dashboard and writes.
  * `Password123!` is refused as common.
  * `Tr0ub4dor&3` is refused by HIBP, which found it 3,196 times.
  * After sign-out the session is `expired`, and Supabase refuses the refresh token (`session_expired`).
  * Anonymous users can execute nothing, and no table is writable by app roles.

## Not applicable, by design

* **Self sign-up and email forgot/reset.** Staff accounts have no real email and are created only by the owner. An owner-issued reset sets a temporary password that expires after 72 hours. In Supabase Auth, also turn off "Allow new users to sign up". Even with it on, a self-made account has no staff record and gets nothing.
* **Email OTP.** There are no mailboxes. TOTP and backup codes are used instead.
* **Supabase "leaked password protection".** Supabase Auth only ever sees an HMAC of the real password, so the HIBP check runs on the real password in the `auth` function instead.

## Remaining notes

* The temporary password is the well-known `0000`, as requested. Until each person claims their account (72 hours), someone who knows their username could claim it first. Ask staff to sign in promptly; the owner sees "Temporary password" on each account until it is replaced.
* Dev-only build tools (vite 5, vitest 2, vite-plugin-pwa) have advisories that need major upgrades. They do not ship to phones: `npm audit --omit=dev` reports 0 vulnerabilities.
* pg_net sits in the `public` schema (Supabase default). This is low risk; only the database uses it.
* **Two-step sign-in is optional for every role (owner's decision, 30 Oct 2026).** The owner and farm manager can turn it off under My account. Without it, their accounts rest on the password alone, so leaving it on is recommended. To require it again for those roles, change `_mfa_required()` in the database to return `p_role in ('owner','manager')`.
* **Digest opt-out link (2 Nov 2026).** `/api/gateway?r=optout` is the only gateway route that takes no session and skips the X-DPV / same-origin checks, because mail apps call it. It can only switch emails off for one person, needs a per-person HMAC link (key in `app_secrets.digest_optout_key`), shows a confirm button on GET so link scanners change nothing, and failed links count against the same per-IP limits as sign-in (logged as `optout`). Staff emails are readable only by the owner's staff tools (service role); signed-in users keep their column-level grant on the six public staff columns.

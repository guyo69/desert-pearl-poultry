// Weekly digest and the daily "missing entries" emails.
// Only the database can call this (POST with the x-dpv-trigger secret, the
// same pattern as push-notify and backup):
//   { mode: 'weekly',  staff, week }   one person's digest for the week starting Monday `week`
//                                      (queued by digest_enqueue() every Monday 06:30 Nairobi, retried 08:30)
//   { mode: 'nudges',  day }           emails for that day's completeness gaps (from daily_checks())
//   { mode: 'preview', staff, week }   builds the digest and returns it without sending or logging
// Every send is claimed in digest_log / nudge_log first, so a retry never sends twice.
// Secrets: RESEND_API_KEY, DIGEST_FROM, DIGEST_REPLY_TO (optional), ANTHROPIC_API_KEY,
// ANTHROPIC_MODEL, DPV_APP_URL. Without the email ones, sends are held (status "held")
// and picked up by the next run; without the Claude ones, the plain templates are used.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { adminClient, json, readJson, safeEqual, secret, str } from '../_shared/util.ts';
import { UUID, optoutUrl } from '../_shared/optout.ts';
import { type Facts, phrase } from '../_shared/phrase.ts';
import { type Sheet, csv, xlsx } from '../_shared/xlsx.ts';
import { NotConfigured, mailConfig, sendMail } from '../_shared/mail.ts';
import { digestEmail, nudgeEmail } from '../_shared/digest_email.ts';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const appUrl = () => (Deno.env.get('DPV_APP_URL') ?? 'https://desert-pearl-poultry.vercel.app').replace(/\/$/, '');
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dayLabel = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }).replace(',', '');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

interface Staff { id: string; display_name: string; role: 'owner' | 'manager' | 'clerk' | 'pos'; location_id: string | null; email: string | null; digest_enabled: boolean; active: boolean }

async function staffRow(db: SupabaseClient, id: string): Promise<Staff | null> {
  const { data } = await db.from('staff').select('id, display_name, role, location_id, email, digest_enabled, active').eq('id', id).maybeSingle();
  return data as Staff | null;
}

/** Facts, phrasing, attachment and email for one person and week. Sends nothing. */
async function build(db: SupabaseClient, s: Staff, week: string) {
  const args = { p_from: week, p_to: addDays(week, 6), p_role: s.role, p_loc: s.location_id };
  const [f, e] = await Promise.all([db.rpc('weekly_facts', args), db.rpc('digest_entries', args)]);
  if (f.error) throw new Error(`weekly_facts: ${f.error.message}`);
  if (e.error) throw new Error(`digest_entries: ${e.error.message}`);
  const facts = f.data as Facts;
  const sheets = ((e.data as { sheets: Sheet[] }).sheets ?? []);
  const phrased = await phrase(facts, { apiKey: Deno.env.get('ANTHROPIC_API_KEY'), model: Deno.env.get('ANTHROPIC_MODEL') });
  let attachment;
  try {
    attachment = { filename: `desert-pearl-week-${week}.xlsx`, content: xlsx(sheets), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  } catch (x) {
    console.error('xlsx failed, sending CSV', x);
    attachment = { filename: `desert-pearl-week-${week}.csv`, content: new TextEncoder().encode(csv(sheets)), contentType: 'text/csv' };
  }
  const scope = facts.scope as { location?: string } | undefined;
  const scopeLabel = s.role === 'pos' ? (scope?.location ?? 'your outlet') : s.role === 'clerk' ? 'the Central Farm' : 'the farm and all outlets';
  const optout = await optoutUrl(db, s.id);
  const email = digestEmail({ name: s.display_name, scopeLabel, facts, paragraphs: phrased.paragraphs, optout, attachmentName: attachment.filename, appUrl: appUrl() });
  return { facts, sheets, phrased, attachment, email, optout };
}

async function weekly(db: SupabaseClient, staffId: string, week: string, preview: boolean): Promise<Response> {
  const s = await staffRow(db, staffId);
  if (!s) return json({ error: 'Unknown staff' }, 404);
  if (preview) {
    const b = await build(db, s, week);
    return json({ subject: b.phrased.subject, source: b.phrased.source, problems: b.phrased.problems, paragraphs: b.phrased.paragraphs,
                  text: b.email.text, attachment: { filename: b.attachment.filename, bytes: b.attachment.content.length },
                  sheets: b.sheets.map((x) => ({ name: x.name, rows: x.rows.length })), facts: b.facts });
  }
  const { data: claim, error } = await db.rpc('mail_claim', { p_kind: 'digest', p_staff: s.id, p_period: week });
  if (error) return json({ error: error.message }, 500);
  if (!claim) return json({ skipped: 'already sent, in progress or out of attempts' });
  const finish = (status: string, err: string | null = null, provider: string | null = null, insights: number | null = null) =>
    db.rpc('mail_finish', { p_kind: 'digest', p_id: claim.id, p_status: status, p_error: err, p_provider_id: provider, p_insights: insights });
  if (!s.active || !s.email || !s.digest_enabled) { await finish('skipped', 'no email, emails turned off, or account disabled'); return json({ skipped: true }); }
  if (!mailConfig().ok) { await finish('held', 'email provider not configured'); return json({ held: true }); }
  try {
    const b = await build(db, s, week);
    const id = await sendMail({ to: s.email, subject: b.phrased.subject, html: b.email.html, text: b.email.text, unsubscribeUrl: b.optout,
                                idempotencyKey: `digest-${s.id}-${week}`, attachments: [b.attachment] });
    await finish('sent', b.phrased.problems.length ? `template used: ${b.phrased.problems.join('; ')}` : null, id, b.facts.insights.length);
    return json({ sent: true, source: b.phrased.source });
  } catch (e) {
    console.error('digest', s.id, week, e);
    await finish(e instanceof NotConfigured ? 'held' : 'failed', errText(e));
    return json({ error: errText(e) }, 500);
  }
}

/** One email per person with their part of the day's gaps; people without gaps get nothing. */
async function nudges(db: SupabaseClient, day: string, preview: boolean): Promise<Response> {
  const [{ data: people, error: e1 }, { data: notes, error: e2 }] = await Promise.all([
    db.rpc('mail_recipients'),
    db.from('notifications').select('id, title, body, to_roles, location_id, dedupe_key').eq('kind', 'gap')
      .or(`dedupe_key.like.gap:${day}:%,dedupe_key.eq.gap-summary:${day}`),
  ]);
  if (e1 || e2) return json({ error: (e1 ?? e2)!.message }, 500);
  const results: Record<string, string> = {};
  for (const p of (people ?? []) as { staff_id: string; display_name: string; role: string; location_id: string | null; email: string }[]) {
    // the same rule as the notifications screen: their role, and their location unless they work across the farm
    const items = (notes ?? []).filter((n) => (n.to_roles as string[]).includes(p.role)
      && (!n.location_id || ['owner', 'manager', 'clerk'].includes(p.role) || n.location_id === p.location_id));
    if (!items.length) continue;
    try {
      const optout = await optoutUrl(db, p.staff_id);
      const mail = nudgeEmail({ name: p.display_name, dayLabel: dayLabel(day), items: items.map((i) => ({ title: i.title, body: i.body })), optout, appUrl: appUrl() });
      if (preview) { results[p.staff_id] = mail.subject; continue; }
      const { data: claim } = await db.rpc('mail_claim', { p_kind: 'nudge', p_staff: p.staff_id, p_period: day });
      if (!claim) { results[p.staff_id] = 'already sent'; continue; }
      const finish = (status: string, err: string | null = null, provider: string | null = null) =>
        db.rpc('mail_finish', { p_kind: 'nudge', p_id: claim.id, p_status: status, p_error: err, p_provider_id: provider });
      if (!mailConfig().ok) { await finish('held', 'email provider not configured'); results[p.staff_id] = 'held'; continue; }
      try {
        const id = await sendMail({ to: p.email, subject: mail.subject, html: mail.html, text: mail.text, unsubscribeUrl: optout,
                                    idempotencyKey: `nudge-${p.staff_id}-${day}` });
        await finish('sent', null, id); results[p.staff_id] = 'sent';
      } catch (e) {
        await finish(e instanceof NotConfigured ? 'held' : 'failed', errText(e)); results[p.staff_id] = 'failed';
      }
    } catch (e) {
      console.error('nudge', p.staff_id, day, e); results[p.staff_id] = 'failed';
    }
  }
  return json({ day, results });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const db = adminClient();
  if (!safeEqual(req.headers.get('x-dpv-trigger') ?? '', await secret(db, 'trigger_secret'))) return json({ error: 'Not found' }, 404);
  const body = await readJson(req);
  const mode = str(body.mode, 20);
  try {
    if (mode === 'weekly' || mode === 'preview') {
      const staff = str(body.staff, 40), week = str(body.week, 10);
      if (!UUID.test(staff)) return json({ error: 'staff must be a staff id' }, 400);
      if (!ISO.test(week) || new Date(`${week}T00:00:00Z`).getUTCDay() !== 1) return json({ error: 'week must be a Monday (YYYY-MM-DD)' }, 400);
      return await weekly(db, staff, week, mode === 'preview');
    }
    if (mode === 'nudges' || mode === 'nudges-preview') {
      const day = str(body.day, 10);
      if (!ISO.test(day)) return json({ error: 'day must be YYYY-MM-DD' }, 400);
      return await nudges(db, day, mode === 'nudges-preview');
    }
    return json({ error: 'Unknown mode' }, 400);
  } catch (e) {
    console.error(mode, e);
    return json({ error: errText(e) }, 500);
  }
});

// Sending email through Resend (https://resend.com).
// Secrets: RESEND_API_KEY, DIGEST_FROM (e.g. "Desert Pearl <reports@mail.example.co.ke>",
// on a domain verified in Resend), optional DIGEST_REPLY_TO.
// Each send carries an idempotency key, so a retry of the same digest within
// 24 hours is ignored by Resend even if our log update was lost.

export interface Attachment { filename: string; content: Uint8Array; contentType: string }
export interface Mail {
  to: string; subject: string; html: string; text: string;
  unsubscribeUrl: string; idempotencyKey: string; attachments?: Attachment[];
}
export class NotConfigured extends Error {}

export function mailConfig() {
  const key = Deno.env.get('RESEND_API_KEY') ?? '', from = Deno.env.get('DIGEST_FROM') ?? '';
  return { ok: !!key && !!from, key, from, replyTo: Deno.env.get('DIGEST_REPLY_TO') ?? '' };
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Sends one email; returns the provider's message id. */
export async function sendMail(m: Mail): Promise<string> {
  const c = mailConfig();
  if (!c.ok) throw new NotConfigured('Email is not set up yet (RESEND_API_KEY and DIGEST_FROM).');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': m.idempotencyKey.slice(0, 256) },
    body: JSON.stringify({
      from: c.from, to: [m.to], subject: m.subject, html: m.html, text: m.text,
      ...(c.replyTo ? { reply_to: c.replyTo } : {}),
      headers: { 'List-Unsubscribe': `<${m.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      attachments: (m.attachments ?? []).map((a) => ({ filename: a.filename, content: b64(a.content), content_type: a.contentType })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${String(j.message ?? j.name ?? 'send failed').slice(0, 200)}`);
  return String(j.id ?? '');
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

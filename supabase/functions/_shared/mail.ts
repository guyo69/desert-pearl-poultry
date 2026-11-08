// Account emails only: recovery codes and "your password was changed" notices.
// Sent through Resend (https://resend.com). Edge-function secrets:
//   RESEND_API_KEY   the Resend API key
//   MAIL_FROM        e.g. "Desert Pearl <no-reply@studio.sagedesigns.co.ke>", on a domain verified in Resend
// Nothing else in the app sends email.

export class MailNotConfigured extends Error {}

export const mailReady = () => Boolean(Deno.env.get('RESEND_API_KEY') && Deno.env.get('MAIL_FROM'));

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Hides most of an address: j***@g***.com */
export function maskEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const m = /^(.)[^@]*@(.)[^.]*(\..+)$/.exec(e);
  return m ? `${m[1]}***@${m[2]}***${m[3]}` : '***';
}

export const looksLikeEmail = (e: string) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

/** One plain account email. Returns the provider's id. */
export async function sendAccountMail(to: string, subject: string, lines: string[], key: string): Promise<string> {
  const apiKey = Deno.env.get('RESEND_API_KEY') ?? '', from = Deno.env.get('MAIL_FROM') ?? '';
  if (!apiKey || !from) throw new MailNotConfigured('Email is not set up yet.');
  const text = [...lines, '', 'Desert Pearl Poultry Manager', 'If you did not ask for this, tell the farm owner and Sage Design Lab.'].join('\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c1c1e;max-width:520px">${
    lines.map((l) => (/^[A-Z0-9-]{6,12}$/.test(l)
      ? `<p style="font-size:28px;font-weight:700;letter-spacing:.12em;margin:18px 0">${escapeHtml(l)}</p>`
      : `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`)).join('')
  }<p style="color:#6e6e73;font-size:13px;margin-top:24px">Desert Pearl Poultry Manager. If you did not ask for this, tell the farm owner and Sage Design Lab.</p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key.slice(0, 256) },
    body: JSON.stringify({ from, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend ${r.status}: ${String(j.message ?? j.name ?? 'send failed').slice(0, 160)}`);
  return String(j.id ?? '');
}

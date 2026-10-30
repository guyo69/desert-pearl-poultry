// Sign-in, first password, two-step sign-in and backup codes.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AppError, auth, type AuthUser } from '../lib/api';
import { getChallenge, loadTurnstile, solvePuzzle, type Solution } from '../lib/challenge';
import { loadMeter, rules, type Strength } from '../lib/strength';
import { Icon } from '../ui/icons';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong. Try again.');

export function AuthPage({ title, sub, children, back }: { title: string; sub?: ReactNode; children: ReactNode; back?: () => void }) {
  return <div className="login">
    <div className="hero"><div className="hero-in">
      {back && <button className="lnk backlnk" onClick={back}><Icon name="back" />Back</button>}
      <div className="brand"><img src="/icon.svg" alt="" /><div><h1>{title}</h1>{sub && <div className="muted sub">{sub}</div>}</div></div>
    </div></div>
    <div className="body"><div className="body-in narrow">{children}</div></div>
  </div>;
}

export function PasswordField({ id, label, value, onChange, autoComplete, autoFocus, invalid }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; autoFocus?: boolean; invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return <label className="fld" htmlFor={id}><span>{label}</span>
    <div className="inp"><input id={id} name={id} type={show ? 'text' : 'password'} value={value} autoComplete={autoComplete} autoFocus={autoFocus}
      autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={128} aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="eye" onClick={() => setShow(!show)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
        <Icon name={show ? 'eyeoff' : 'eye'} /></button></div></label>;
}

function Countdown({ until, onEnd }: { until: number; onEnd: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => { const n = Date.now(); setNow(n); if (n >= until) { clearInterval(t); onEnd(); } }, 1000);
    return () => clearInterval(t);
  }, [until, onEnd]);
  const s = Math.max(0, Math.ceil((until - now) / 1000));
  return <>{s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s} s`}</>;
}

// ------------------------------------------------------------------------------------------ sign in
export function Login({ setupNeeded, notice, onDone }: { setupNeeded?: boolean; notice?: string; onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [needCheck, setNeedCheck] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [turnstile, setTurnstile] = useState<{ site: string; token: string } | null>(null);
  const tsBox = useRef<HTMLDivElement>(null);
  const [created, setCreated] = useState<{ username: string; display_name: string }[] | null>(null);

  // Turnstile, when the server uses it instead of the built-in puzzle
  useEffect(() => {
    if (!turnstile || turnstile.token || !tsBox.current) return;
    let id = '';
    loadTurnstile().then(() => {
      if (!tsBox.current || !window.turnstile) return;
      id = window.turnstile.render(tsBox.current, {
        sitekey: turnstile.site, action: 'login', theme: 'auto',
        callback: (token: string) => setTurnstile((t) => (t ? { ...t, token } : t)),
        'expired-callback': () => setTurnstile((t) => (t ? { ...t, token: '' } : t)),
      });
    }).catch((e) => setErr(msg(e)));
    return () => { if (id) window.turnstile?.remove(id); };
  }, [turnstile]);

  const solveCheck = async (): Promise<Solution | undefined> => {
    if (turnstile?.token) return { type: 'turnstile', token: turnstile.token };
    const c = await getChallenge(username);
    if (c.type === 'turnstile') { setTurnstile({ site: c.site_key, token: '' }); throw new Error('Tick the security check below, then sign in.'); }
    setProgress(0);
    try { return await solvePuzzle(c, setProgress); } finally { setProgress(null); }
  };

  const submit = async (e?: FormEvent, forceCheck = false) => {
    e?.preventDefault();
    if (busy || Date.now() < waitUntil) return;
    if (!username.trim() || !password) { setErr('Enter your username and password.'); return; }
    setBusy(true); setErr('');
    try {
      const captcha = needCheck || forceCheck ? await solveCheck() : undefined;
      await auth('login', { username: username.trim(), password, captcha });
      setPassword('');
      onDone();
    } catch (x) {
      const ex = x as AppError;
      if (ex.data?.captcha_required) setNeedCheck(true);
      if (turnstile) setTurnstile({ site: turnstile.site, token: '' });
      if (ex.code === 'CAPTCHA' && !forceCheck && !needCheck) { setBusy(false); return submit(undefined, true); }
      if (ex.status === 429 && ex.data?.retry_after) setWaitUntil(Date.now() + Number(ex.data.retry_after) * 1000);
      if (ex.code === 'BAD_CREDENTIALS' || ex.code === 'LOCKED') setPassword('');
      setErr(msg(x));
    } finally { setBusy(false); }
  };

  const bootstrap = async () => {
    setBusy(true); setErr('');
    try { const r = await auth<{ created: { username: string; display_name: string }[] }>('bootstrap'); setCreated(r.created); }
    catch (e) { setErr(msg(e)); } finally { setBusy(false); }
  };

  const waiting = waitUntil > Date.now();
  return <AuthPage title="Desert Pearl" sub="Tuala Farm Fresh Eggs · Kagundo">
    {notice && <div className="banner info"><div><b>{notice}</b></div></div>}
    {created && <div className="card"><h3>Team created</h3>
      <p className="muted small">Everyone signs in with their username and the temporary password <b>0000</b>, which works once, for 72 hours, and must be replaced straight away. The owner and farm manager also set up two-step sign-in.</p>
      <ul className="userlist">{created.map((c) => <li key={c.username}><code>{c.username}</code> {c.display_name}</li>)}</ul></div>}
    <form className="card authform" onSubmit={submit} noValidate>
      <label className="fld" htmlFor="username"><span>Username</span>
        <div className="inp"><input id="username" name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
          autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={64} autoFocus /></div></label>
      <PasswordField id="password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      {turnstile && <div ref={tsBox} className="turnstile" />}
      {needCheck && !turnstile && <p className="muted small"><Icon name="lock" /> After several failed attempts this device does a short security check when you sign in.</p>}
      <div className="form-err" role="alert" aria-live="polite">{err}{waiting && <> Try again in <Countdown until={waitUntil} onEnd={() => setWaitUntil(0)} />.</>}</div>
      <button className="btn wide" disabled={busy || waiting}>
        {progress !== null ? `Checking this device… ${Math.round(progress * 100)}%` : busy ? 'Signing in…' : 'Sign in'}</button>
      <p className="muted small center-t">Forgot your password? Ask the owner to reset it.</p>
    </form>
    {setupNeeded && !created && <div className="card"><h3>First-time setup</h3>
      <p className="muted small">Create the team: Owner, Farm Manager, Production Clerk, Farm Counter, Van Driver and one attendant for each shop.</p>
      <button className="btn alt" disabled={busy} onClick={bootstrap}>{busy ? 'Creating…' : 'Create the team'}</button></div>}
  </AuthPage>;
}

// ------------------------------------------------------------------------------------------ passwords
export function StrengthMeter({ pw, user }: { pw: string; user?: Pick<AuthUser, 'username' | 'display_name'> }) {
  const [meter, setMeter] = useState<((p: string, i: string[]) => Strength) | null>(null);
  useEffect(() => { loadMeter().then((m) => setMeter(() => m)).catch(() => {}); }, []);
  const inputs = useMemo(() => [user?.username ?? '', ...(user?.display_name ?? '').split(/\s+/), 'desert', 'pearl', 'tuala', 'kagundo'].filter(Boolean), [user]);
  const r = rules(pw, { username: user?.username, displayName: user?.display_name });
  const s = pw && meter ? meter(pw, inputs) : null;
  const allRules = r.every((x) => x.ok);
  const score = !pw ? 0 : s ? (allRules ? s.score : Math.min(s.score, 1)) : 0;
  return <div className="meter" aria-live="polite">
    <div className={`bars s${score}`} role="meter" aria-valuemin={0} aria-valuemax={4} aria-valuenow={score} aria-label="Password strength">
      {[0, 1, 2, 3].map((i) => <i key={i} className={pw && i < Math.max(1, score) ? 'on' : ''} />)}</div>
    <div className="meter-l"><b>{!pw ? 'Password strength' : s ? (allRules ? s.label : 'Too weak') : 'Checking…'}</b>
      {s && pw && allRules && <small>Time to crack: {s.crack}</small>}</div>
    {s && pw && (s.warning || s.suggestions[0]) && <p className="muted small">{s.warning || s.suggestions[0]}</p>}
    <ul className="rules">{r.map((x) => <li key={x.id} className={x.ok ? 'ok' : ''}><Icon name={x.ok ? 'check' : 'dot'} />{x.label}</li>)}</ul>
  </div>;
}

export function NewPassword({ user, forced, onDone, onSignOut }: { user: Pick<AuthUser, 'username' | 'display_name'>; forced: boolean; onDone: () => void; onSignOut?: () => void }) {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setErr([]); }, [pw, again]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const bad = rules(pw, { username: user.username, displayName: user.display_name }).filter((r) => !r.ok);
    if (bad.length) { setErr(bad.map((b) => `Missing: ${b.label.toLowerCase()}.`)); return; }
    if (pw !== again) { setErr(['The two passwords do not match.']); return; }
    setBusy(true); setErr([]);
    try {
      await auth('set_password', { new_password: pw, current_password: forced ? undefined : cur });
      setPw(''); setAgain(''); setCur('');
      onDone();
    } catch (x) {
      const ex = x as AppError;
      setErr(Array.isArray(ex.data?.problems) && ex.data.problems.length ? ex.data.problems : [msg(x)]);
    } finally { setBusy(false); }
  };
  const form = <form className={forced ? 'card authform' : 'authform'} onSubmit={submit} noValidate>
    {/* lets password managers save the new password against the right username */}
    <input type="text" name="username" autoComplete="username" value={user.username} readOnly hidden />
    {!forced && <PasswordField id="cur" label="Current password" value={cur} onChange={setCur} autoComplete="current-password" autoFocus />}
    <PasswordField id="newpw" label="New password" value={pw} onChange={setPw} autoComplete="new-password" autoFocus={forced} />
    <StrengthMeter pw={pw} user={user} />
    <PasswordField id="again" label="New password again" value={again} onChange={setAgain} autoComplete="new-password" invalid={Boolean(again) && again !== pw} />
    {err.length > 0 && <div className="form-err" role="alert">{err.map((x) => <div key={x}>{x}</div>)}</div>}
    <button className="btn wide" disabled={busy}>{busy ? 'Checking…' : forced ? 'Set password' : 'Change password'}</button>
    <p className="muted small">Tip: three or four unrelated words with a number and a symbol are easy to remember and hard to guess, like <i>Mvua#Ya-Jioni42</i>. Passwords found in known data leaks are refused.{!forced && ' Changing it signs you out on every other device.'}</p>
  </form>;
  if (!forced) return form;
  return <AuthPage title="Choose your password" sub={<>Signed in as <b>{user.display_name}</b> ({user.username}) with a temporary password.</>}>
    {form}
    {onSignOut && <button className="lnk center-t blockc" onClick={onSignOut}>Sign out</button>}
  </AuthPage>;
}

// ------------------------------------------------------------------------------------------ two-step sign-in
function CodeInput({ value, onChange, autoFocus = true }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return <label className="fld" htmlFor="otp"><span>6-digit code</span>
    <div className="inp"><input id="otp" className="otp" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={7} autoFocus={autoFocus}
      value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 6))} placeholder="123456" /></div></label>;
}

export function BackupCodes({ codes, onDone, inline }: { codes: string[]; onDone: () => void; inline?: boolean }) {
  const [saved, setSaved] = useState(false);
  const text = `Desert Pearl backup codes\nEach code works once if you cannot use your authenticator app.\n\n${codes.join('\n')}\n`;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = 'desert-pearl-backup-codes.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const body = <div className={inline ? '' : 'card'}>
    <p className="muted small">If your phone is lost or the app is deleted, each of these codes signs you in <b>once</b>. Keep them somewhere safe, away from your phone: written down at home, or in a password manager. They will not be shown again.</p>
    <ol className="codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
    <div className="row-btns">
      <button className="btn sm alt" onClick={() => navigator.clipboard?.writeText(text).catch(() => {})}><Icon name="copy" />Copy</button>
      <button className="btn sm alt" onClick={download}><Icon name="download" />Download</button>
    </div>
    <label className="check"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes</label>
    <button className="btn wide" disabled={!saved} onClick={onDone}>Continue</button>
  </div>;
  return inline ? body : <AuthPage title="Save your backup codes">{body}</AuthPage>;
}

export function MfaEnroll({ user, onDone, onSignOut, inline }: { user: Pick<AuthUser, 'username' | 'display_name' | 'mfa_required'>; onDone: () => void; onSignOut?: () => void; inline?: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const r = await auth<{ secret: string; uri: string }>('mfa_enroll');
        const QR = await import('qrcode');
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        const qr = await QR.toDataURL(r.uri, { margin: 1, width: 232, errorCorrectionLevel: 'M', color: dark ? { dark: '#FFFFFF', light: '#1C1C1E' } : undefined });
        setSetup({ ...r, qr });
      } catch (e) { setErr(msg(e)); }
    })();
  }, []);
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true); setErr('');
    try { const r = await auth<{ backup_codes: string[] }>('mfa_confirm', { code }); setCodes(r.backup_codes); }
    catch (x) { setErr(msg(x)); setCode(''); } finally { setBusy(false); }
  };
  if (codes) return <BackupCodes codes={codes} onDone={onDone} inline={inline} />;
  const body = <form className={inline ? 'authform' : 'card authform'} onSubmit={confirm} noValidate>
    <ol className="steps">
      <li>Install an authenticator app on your phone: <b>Google Authenticator</b>, <b>Microsoft Authenticator</b> or similar.</li>
      <li>In the app, tap <b>+</b> and scan this code.</li>
    </ol>
    <div className="qr">{setup ? <img src={setup.qr} alt="QR code for your authenticator app" width={232} height={232} /> : !err && <div className="spinner" />}</div>
    {setup && <details className="manual"><summary>Cannot scan? Enter this key instead</summary><code className="secret">{setup.secret}</code>
      <a className="lnk" href={setup.uri}>Open in an authenticator app on this phone</a></details>}
    <ol className="steps" start={3}><li>Enter the 6-digit code the app shows.</li></ol>
    <CodeInput value={code} onChange={setCode} autoFocus={false} />
    <div className="form-err" role="alert">{err}</div>
    <button className="btn wide" disabled={busy || code.length !== 6 || !setup}>{busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>
  </form>;
  if (inline) return body;
  return <AuthPage title="Set up two-step sign-in" sub={<>{user.mfa_required ? 'Required for your role. ' : ''}Each sign-in will need your password and a code from your phone.</>}>
    {body}
    {onSignOut && <button className="lnk center-t blockc" onClick={onSignOut}>Sign out</button>}
  </AuthPage>;
}

export function MfaVerify({ user, onDone, onSignOut }: { user: Pick<AuthUser, 'display_name'>; onDone: (r: { used_backup?: boolean; backup_codes_left?: number }) => void; onSignOut: () => void }) {
  const [code, setCode] = useState('');
  const [backup, setBackup] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true); setErr('');
    try { onDone(await auth('mfa_verify', backup ? { backup_code: code } : { code })); }
    catch (x) { setErr(msg(x)); setCode(''); } finally { setBusy(false); }
  };
  useEffect(() => { if (!backup && code.length === 6) submit(); }, [code]);   // eslint-disable-line react-hooks/exhaustive-deps
  return <AuthPage title="Two-step sign-in" sub={<>Hello {user.display_name}. Open your authenticator app and enter the code for Desert Pearl.</>}>
    <form className="card authform" onSubmit={submit} noValidate>
      {backup
        ? <label className="fld" htmlFor="bc"><span>Backup code</span><div className="inp"><input id="bc" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={11}
            value={code} onChange={(e) => setCode(e.target.value)} placeholder="xxxxx-xxxxx" autoFocus /></div></label>
        : <CodeInput value={code} onChange={setCode} />}
      <div className="form-err" role="alert">{err}</div>
      <button className="btn wide" disabled={busy || (backup ? code.replace(/[^a-z0-9]/gi, '').length !== 10 : code.length !== 6)}>{busy ? 'Checking…' : 'Continue'}</button>
      <button type="button" className="lnk center-t blockc" onClick={() => { setBackup(!backup); setCode(''); setErr(''); }}>
        {backup ? 'Use the authenticator app' : 'Lost your phone? Use a backup code'}</button>
    </form>
    <button className="lnk center-t blockc" onClick={onSignOut}>Sign out</button>
  </AuthPage>;
}

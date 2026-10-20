import { useEffect, useState } from 'react';
import { ApiError, useSubmit } from '../api.ts';
import { type AuthConfig, setDevToken, signOut, supabase } from '../auth.ts';
import { Button, ErrorSummary, Field } from '../ui.tsx';

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="content" style={{ maxWidth: 480, paddingTop: 48 }}>
      <div className="row" style={{ marginBottom: 24 }}>
        <span className="brand-mark" style={{ color: '#fff' }} aria-hidden="true">VW</span>
        <div><strong style={{ fontSize: '1.25rem' }}>Valor &amp; Wellbeing Hub</strong><div className="muted small">People · Performance · Properties · Governance</div></div>
      </div>
      <div className="card">{children}</div>
      <p className="muted small" style={{ marginTop: 16 }}>For Valor Housing Ltd, Wellbeing Homes Ltd and Wellbeing Housing Ltd staff. Accounts are by invitation only.</p>
    </main>
  );
}

export function Login({ config }: { config: AuthConfig }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent'>('signin');
  const sb = supabase();
  useEffect(() => { document.title = 'Sign in · Valor & Wellbeing Hub'; }, []);

  const signIn = useSubmit(async () => {
    const fields: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) fields.email = 'Enter your work email address';
    if (!password) fields.password = 'Enter your password';
    if (Object.keys(fields).length) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields });
    const { error } = await sb!.auth.signInWithPassword({ email, password });
    // One message for every failure, so the form does not reveal which emails have accounts.
    if (error) throw new ApiError(401, 'auth', error.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : 'The email or password is not right. Check them and try again, or reset your password.');
  });
  const forgot = useSubmit(async () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { email: 'Enter your work email address' } });
    await sb!.auth.resetPasswordForEmail(email, { redirectTo: `${location.origin}/reset-password` });
    setMode('sent');
  });

  return (
    <Frame>
      <h1 style={{ fontSize: '1.5rem' }}>{mode === 'signin' ? 'Sign in' : 'Reset your password'}</h1>
      {!sb && !config.devAuth && <div className="notice bad">Sign-in is not set up yet. An administrator needs to configure Supabase (see the administrator guide).</div>}
      {sb && mode === 'signin' && (
        <form noValidate onSubmit={(e) => { e.preventDefault(); signIn.run(); }}>
          <ErrorSummary error={signIn.error} />
          <Field label="Work email" error={signIn.error?.fields.email}>
            <input name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password" error={signIn.error?.fields.password}>
            <input name="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show password</label>
          <Button type="submit" block big busy={signIn.busy} busyText="Signing in…">Sign in</Button>
          <p style={{ marginTop: 16 }}><button type="button" className="btn ghost" onClick={() => setMode('forgot')}>Forgot your password?</button></p>
        </form>
      )}
      {sb && mode === 'forgot' && (
        <form noValidate onSubmit={(e) => { e.preventDefault(); forgot.run(); }}>
          <ErrorSummary error={forgot.error} />
          <p>We will email you a link to choose a new password.</p>
          <Field label="Work email" error={forgot.error?.fields.email}><input name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <div className="row"><Button type="submit" busy={forgot.busy} busyText="Sending…">Send reset link</Button><Button variant="secondary" onClick={() => setMode('signin')}>Back to sign in</Button></div>
        </form>
      )}
      {mode === 'sent' && <div className="notice ok" role="status">If an account exists for {email}, a reset link is on its way. It may take a few minutes.</div>}
      {config.devAuth && <DevSignIn />}
      <p className="muted small" style={{ marginTop: 24 }}>Need help signing in? {config.helpContact ?? 'Contact your manager or administrator.'}</p>
    </Frame>
  );
}

// Development only (DEV_AUTH=true; the server refuses this in production). Fictional demo accounts.
function DevSignIn() {
  const [users, setUsers] = useState<any[]>([]);
  useEffect(() => { fetch('/api/dev/users').then((r) => r.json()).then(setUsers).catch(() => {}); }, []);
  const go = useSubmit(async (email: string) => {
    const r = await fetch('/api/dev/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    const b = await r.json();
    if (!r.ok) throw new ApiError(r.status, b.error, b.message);
    setDevToken(b.token);
  });
  return (
    <section aria-labelledby="dev-h" style={{ marginTop: 24, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h2 id="dev-h" style={{ fontSize: '1.125rem' }}>Demo sign-in (development only)</h2>
      <p className="muted small">Fictional accounts for testing. This option does not exist on the live site.</p>
      <ErrorSummary error={go.error} />
      <ul className="list">
        {users.map((u) => (
          <li key={u.id}>
            <span>{u.full_name}<br /><span className="muted small">{u.roles}</span></span>
            <Button variant="secondary" disabled={go.busy} onClick={() => go.run(u.email)}>Sign in as {u.full_name.split(' ')[0]}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Privileged roles must complete MFA (TOTP via Supabase) before the API will serve them.
export function MfaGate({ onDone }: { onDone: () => void }) {
  const sb = supabase();
  const [factor, setFactor] = useState<{ id: string; qr?: string; secret?: string } | null>(null);
  const [code, setCode] = useState('');
  const setup = useSubmit(async () => {
    const { data } = await sb!.auth.mfa.listFactors();
    const existing = data?.totp?.find((f) => f.status === 'verified');
    if (existing) return setFactor({ id: existing.id });
    const { data: en, error } = await sb!.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Hub authenticator' });
    if (error) throw new ApiError(400, 'mfa', error.message);
    setFactor({ id: en.id, qr: en.totp.qr_code, secret: en.totp.secret });
  });
  useEffect(() => { if (sb) setup.run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const verify = useSubmit(async () => {
    if (!/^\d{6}$/.test(code)) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { code: 'Enter the 6-digit code from your authenticator app' } });
    const { error } = await sb!.auth.mfa.challengeAndVerify({ factorId: factor!.id, code });
    if (error) throw new ApiError(400, 'mfa', 'That code did not work. Codes change every 30 seconds — try the newest one.');
    await sb!.auth.refreshSession();
    onDone();
  });
  return (
    <Frame>
      <h1 style={{ fontSize: '1.5rem' }}>Two-step verification</h1>
      <p>Your role can see sensitive information, so you need a code from an authenticator app as well as your password.</p>
      {!sb && <div className="notice bad">Two-step verification needs Supabase to be configured.</div>}
      <ErrorSummary error={setup.error ?? verify.error} />
      {factor?.qr && (<><p>Scan this code with an authenticator app (for example Microsoft Authenticator or Google Authenticator).</p><img src={factor.qr} alt="QR code for setting up your authenticator app" width={200} height={200} /><p className="small">Can’t scan? Enter this key instead: <code>{factor.secret}</code></p></>)}
      {factor && (
        <form noValidate onSubmit={(e) => { e.preventDefault(); verify.run(); }}>
          <Field label="6-digit code" error={verify.error?.fields.code}><input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.trim())} /></Field>
          <Button type="submit" busy={verify.busy} busyText="Checking…">Verify</Button>
        </form>
      )}
      <p style={{ marginTop: 16 }}><button type="button" className="btn ghost" onClick={() => signOut()}>Sign out</button></p>
    </Frame>
  );
}

// Reached from a password-reset or invitation email: Supabase has already started a recovery session.
export function SetPassword() {
  const [pw, setPw] = useState('');
  const [done, setDone] = useState(false);
  const save = useSubmit(async () => {
    if (pw.length < 12) throw new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields: { password: 'Use at least 12 characters' } });
    const { error } = await supabase()!.auth.updateUser({ password: pw });
    if (error) throw new ApiError(400, 'auth', 'The link may have expired. Request a new one from the sign-in page.');
    setDone(true);
  });
  return (
    <Frame>
      <h1 style={{ fontSize: '1.5rem' }}>Choose your password</h1>
      {done ? <><div className="notice ok" role="status">Password saved.</div><a className="btn" href="/">Continue to the Hub</a></> : (
        <form noValidate onSubmit={(e) => { e.preventDefault(); save.run(); }}>
          <ErrorSummary error={save.error} />
          <Field label="New password" hint="At least 12 characters. A short phrase is easier to remember." error={save.error?.fields.password}>
            <input name="password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Button type="submit" busy={save.busy}>Save password</Button>
        </form>
      )}
    </Frame>
  );
}

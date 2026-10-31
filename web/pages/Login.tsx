import { useEffect, useState } from 'react';
import { ApiError, post, useSubmit } from '../api.ts';
import { type AuthConfig, setToken, signOut } from '../auth.ts';
import { Button, ErrorSummary, Field } from '../ui.tsx';

export function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-shell">
      <section className="auth-story" aria-label="About the Hub">
        <div className="brand"><span className="brand-mark" aria-hidden="true">VW</span><span className="brand-text"><strong>Valor &amp; Wellbeing Hub</strong><span>Your people. Your purpose.</span></span></div>
        <div>
          <div className="auth-eyebrow">One connected workplace</div>
          <h2>Great support starts with a connected team.</h2>
          <p>Your working day, training, properties and company updates. Together in one place, so you can focus on the people who matter.</p>
          <svg className="auth-art" viewBox="0 0 520 205" fill="none" aria-hidden="true">
            <defs><linearGradient id="hub-card" x1="40" y1="30" x2="440" y2="200" gradientUnits="userSpaceOnUse"><stop stopColor="#ffffff" stopOpacity=".17"/><stop offset="1" stopColor="#ffffff" stopOpacity=".04"/></linearGradient></defs>
            <path d="M20 173H500" stroke="#ffffff" strokeOpacity=".12"/>
            <rect x="34" y="46" width="224" height="127" rx="16" fill="url(#hub-card)" stroke="#ffffff" strokeOpacity=".2"/>
            <rect x="55" y="67" width="29" height="29" rx="9" fill="#60cdb4"/><path d="m63 81 5 5 9-11" stroke="#123d47" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <rect x="96" y="70" width="130" height="7" rx="3.5" fill="#ffffff" fillOpacity=".65"/><rect x="96" y="85" width="85" height="5" rx="2.5" fill="#ffffff" fillOpacity=".25"/>
            <rect x="55" y="116" width="181" height="6" rx="3" fill="#ffffff" fillOpacity=".12"/><rect x="55" y="116" width="133" height="6" rx="3" fill="#60cdb4"/>
            <rect x="55" y="138" width="100" height="5" rx="2.5" fill="#ffffff" fillOpacity=".3"/>
            <rect x="279" y="20" width="201" height="153" rx="16" fill="url(#hub-card)" stroke="#ffffff" strokeOpacity=".2"/>
            <rect x="300" y="41" width="91" height="6" rx="3" fill="#ffffff" fillOpacity=".6"/>
            <rect x="301" y="114" width="22" height="37" rx="5" fill="#ffffff" fillOpacity=".22"/><rect x="335" y="95" width="22" height="56" rx="5" fill="#ffffff" fillOpacity=".32"/><rect x="369" y="77" width="22" height="74" rx="5" fill="#60cdb4" fillOpacity=".8"/><rect x="403" y="61" width="22" height="90" rx="5" fill="#60cdb4"/>
            <circle cx="469" cy="29" r="15" fill="#60cdb4"/><path d="m462 29 5 5 9-11" stroke="#123d47" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
        <div className="auth-tags"><span>People &amp; performance</span><span>Properties &amp; visits</span><span>Training &amp; governance</span></div>
      </section>
      <section className="auth-form-side" aria-label="Account access"><div className="auth-form-inner">
        <div className="auth-eyebrow" style={{ color: 'var(--teal-text)' }}>Welcome to your Hub</div>
        <div className="card">{children}</div>
        <p className="auth-footer">For Valor Housing Ltd, Wellbeing Homes Ltd and Wellbeing Housing Ltd staff. New accounts require email verification and administrator approval. <a href="/privacy">Privacy notice</a>.</p>
        <p className="auth-footer">Valor Housing Ltd, registered in England and Wales, company number 16175322. Registered office: 63 Grove Lane, Handsworth, Birmingham B21 9ES.</p>
      </div></section>
    </main>
  );
}
const invalid = (fields: Record<string, string>) => new ApiError(400, 'invalid', 'Please check the highlighted fields.', { fields });
const CodeField = ({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) => (
  <Field label="6-digit code" hint="From your authenticator app" error={error}>
    <input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value} onChange={(e) => onChange(e.target.value.replace(/\s/g, ''))} />
  </Field>
);

export function Login({ config }: { config: AuthConfig }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'signin' | 'forgot' | 'sent'>('signin');
  useEffect(() => { document.title = 'Sign in · Valor & Wellbeing Hub'; }, []);

  const signIn = useSubmit(async () => {
    const fields: Record<string, string> = {};
    if (!/^\S+@\S+\.\S+$/.test(email)) fields.email = 'Enter your work email address';
    if (!password) fields.password = 'Enter your password';
    if (Object.keys(fields).length) throw invalid(fields);
    const r = await post('/auth/login', { email, password });
    if (r.mfa) setTicket(r.ticket); else setToken(r.token);
  });
  const second = useSubmit(async () => {
    if (!/^\d{6}$/.test(code)) throw invalid({ code: 'Enter the 6-digit code from your authenticator app' });
    try { setToken((await post('/auth/login/mfa', { ticket, code })).token); }
    catch (e) { if (e instanceof ApiError && e.code === 'auth' && !e.fields.code) { setTicket(null); setCode(''); } throw e; } // ticket expired: start again
  });
  const forgot = useSubmit(async () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) throw invalid({ email: 'Enter your work email address' });
    await post('/auth/forgot', { email });
    setMode('sent');
  });

  return (
    <Frame>
      <p><a href="/register">New staff? Create an account request</a></p>
      <h1 style={{ fontSize: '1.5rem' }}>{ticket ? 'Two-step verification' : mode === 'signin' ? 'Sign in' : 'Reset your password'}</h1>
      {ticket ? (
        <form noValidate onSubmit={(e) => { e.preventDefault(); second.run(); }}>
          <ErrorSummary error={second.error} />
          <p>Enter the current code from your authenticator app.</p>
          <CodeField value={code} onChange={setCode} error={second.error?.fields.code} />
          <div className="row"><Button type="submit" busy={second.busy} busyText="Checking…">Continue</Button><Button variant="secondary" onClick={() => { setTicket(null); setCode(''); }}>Back</Button></div>
          <p className="muted small" style={{ marginTop: 16 }}>Lost your phone? Ask a super administrator to reset your two-step verification.</p>
        </form>
      ) : mode === 'signin' ? (
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
      ) : mode === 'forgot' ? (
        config.selfServiceReset ? (
          <form noValidate onSubmit={(e) => { e.preventDefault(); forgot.run(); }}>
            <ErrorSummary error={forgot.error} />
            <p>We will email you a link to choose a new password.</p>
            <Field label="Work email" error={forgot.error?.fields.email}><input name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
            <div className="row"><Button type="submit" busy={forgot.busy} busyText="Sending…">Send reset link</Button><Button variant="secondary" onClick={() => setMode('signin')}>Back to sign in</Button></div>
          </form>
        ) : (
          <><p>Ask your manager or administrator to send you a new sign-in link from your profile in the Hub.</p><Button variant="secondary" onClick={() => setMode('signin')}>Back to sign in</Button></>
        )
      ) : <div className="notice ok" role="status">If an account exists for {email}, a reset link is on its way. It works for 1 hour.</div>}
      {config.devAuth && !ticket && <DevSignIn />}
      <p className="muted small" style={{ marginTop: 24 }}>Need help signing in? {config.helpContact ?? 'Contact your manager or administrator.'}</p>
    </Frame>
  );
}

// Development only (DEV_AUTH=true; the server refuses this in production). Fictional demo accounts.
function DevSignIn() {
  const [users, setUsers] = useState<any[]>([]);
  useEffect(() => { fetch('/api/dev/users').then((r) => r.json()).then(setUsers).catch(() => {}); }, []);
  const go = useSubmit(async (email: string) => setToken((await post('/dev/login', { email })).token));
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

// Privileged roles must set up (or confirm) an authenticator app before the API will serve them.
export function MfaGate({ onDone }: { onDone: () => void }) {
  const [setup, setSetup] = useState<{ enabled: boolean; qr?: string; secret?: string; uri?: string } | null>(null);
  const [code, setCode] = useState('');
  const load = useSubmit(async () => setSetup(await post('/auth/mfa/setup', {})));
  useEffect(() => { load.run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const verify = useSubmit(async () => {
    if (!/^\d{6}$/.test(code)) throw invalid({ code: 'Enter the 6-digit code from your authenticator app' });
    await post('/auth/mfa/verify', { code });
    onDone();
  });
  return (
    <Frame>
      <h1 style={{ fontSize: '1.5rem' }}>Two-step verification</h1>
      <p>Your role can see sensitive information, so you need a code from an authenticator app as well as your password.</p>
      <ErrorSummary error={load.error ?? verify.error} />
      {setup && !setup.enabled && (
        <>
          <p>Scan this code with an authenticator app (for example Microsoft Authenticator or Google Authenticator), then enter the 6-digit code it shows.</p>
          <img src={setup.qr} alt="QR code for setting up your authenticator app" width={200} height={200} />
          <p className="small">Can’t scan? On this phone, <a href={setup.uri}>open it in your authenticator app</a>, or enter this key: <code style={{ wordBreak: 'break-all' }}>{setup.secret}</code></p>
        </>
      )}
      {setup && (
        <form noValidate onSubmit={(e) => { e.preventDefault(); verify.run(); }}>
          <CodeField value={code} onChange={setCode} error={verify.error?.fields.code} />
          <Button type="submit" busy={verify.busy} busyText="Checking…">Verify</Button>
        </form>
      )}
      <p style={{ marginTop: 16 }}><button type="button" className="btn ghost" onClick={() => signOut()}>Sign out</button></p>
    </Frame>
  );
}

// Reached from an invitation or reset link: /set-password#token=… (the token stays out of server logs).
export function SetPassword() {
  // Keep the ticket for this form's lifetime, including re-renders after saving.
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const save = useSubmit(async () => {
    if (pw.length < 8) throw invalid({ password: 'Use at least 8 characters' });
    if (pw !== pw2) throw invalid({ confirm: 'The two passwords do not match' });
    const r = await post('/auth/set-password', { token, password: pw });
    setToken(r.token);
    // A signed-in user still has signedIn=true, so an auth event alone does not
    // re-render App or leave this screen. Navigate after saving the new session.
    location.replace('/');
  });
  useEffect(() => { document.title = 'Choose your password · Valor & Wellbeing Hub'; }, []);
  return (
    <Frame>
      <h1 style={{ fontSize: '1.5rem' }}>Choose your password</h1>
      {!token ? <div className="notice bad">This link is incomplete. Open the link from your email again, or ask your administrator for a new one.</div> : (
        <form noValidate onSubmit={(e) => { e.preventDefault(); save.run(); }}>
          <ErrorSummary error={save.error} />
          <Field label="New password" hint="At least 8 characters. A short phrase is easier to remember." error={save.error?.fields.password}>
            <input name="password" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Type it again" error={save.error?.fields.confirm}>
            <input name="confirm" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <Button type="submit" busy={save.busy} busyText="Saving…">Save password and sign in</Button>
        </form>
      )}
    </Frame>
  );
}


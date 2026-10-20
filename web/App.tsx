import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BrowserRouter, Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, get, serverNow, useApi } from './api.ts';
import { type AuthConfig, initAuth, isSignedIn, onAuthChange, signOut } from './auth.ts';
import { fmtElapsed } from './format.ts';
import { ADMIN_PERMS, HubCtx, makeHub, type Me, useHub } from './hub.tsx';
import { Admin } from './pages/Admin.tsx';
import { Attendance, VisitDetail, ActiveVisit, ManualVisit } from './pages/Visits.tsx';
import { Handover } from './pages/Handover.tsx';
import { Inbox, Notifications } from './pages/Inbox.tsx';
import { Login, MfaGate, SetPassword } from './pages/Login.tsx';
import { ActivityPage } from './pages/Activity.tsx';
import { MyDay } from './pages/MyDay.tsx';
import { People, PersonPage, Resume } from './pages/People.tsx';
import { Performance } from './pages/Performance.tsx';
import { Policies, PolicyPage } from './pages/Policies.tsx';
import { CasePage, Concerns } from './pages/Concerns.tsx';
import { AgentPage, AgentPortal, Estates, RepairPage } from './pages/Estates.tsx';
import { ActionPage, Governance } from './pages/Governance.tsx';
import { Finance, FinanceDocument } from './pages/Finance.tsx';
import { Conversation, Messages, News } from './pages/Messages.tsx';
import { Assistant } from './pages/Assistant.tsx';
import { InstallPage } from './pages/DataTools.tsx';
import { JobDescriptionPage } from './pages/Development.tsx';
import { LeavePage } from './pages/Leave.tsx';
import { CourseEditor, CoursePlayer, Training } from './pages/Training.tsx';
import { Properties, PropertyPage } from './pages/Properties.tsx';
import { TaskPage, Tasks } from './pages/Tasks.tsx';
import { Timesheets, Workload } from './pages/Timesheets.tsx';
import { Avatar, Button, Icon, Skeleton, ToastProvider } from './ui.tsx';

export function App() {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    initAuth().then(async (c) => { setConfig(c); setSignedIn(await isSignedIn()); }).catch(() => setSignedIn(false));
    return onAuthChange(async () => setSignedIn(await isSignedIn()));
  }, []);
  if (signedIn === null) return <main className="content"><Skeleton /></main>;
  if (location.pathname === '/set-password') return <SetPassword />;
  if (!signedIn) return config ? <Login config={config} /> : <main className="content"><div className="notice bad" role="alert">The Hub could not reach its server. Please check your connection and reload.</div></main>;
  return <BrowserRouter><ToastProvider><Session /></ToastProvider></BrowserRouter>;
}

function Session() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [company, setCompanyState] = useState<string>(() => { try { return localStorage.getItem('hub.company') ?? 'all'; } catch { return 'all'; } });
  const reloadMe = useCallback(async () => {
    try { setMe(await get<Me>('/me')); setErr(null); } catch (e) { setErr(e as ApiError); }
  }, []);
  useEffect(() => { reloadMe(); }, [reloadMe]);
  const setCompany = (c: string) => { setCompanyState(c); try { localStorage.setItem('hub.company', c); } catch { /* convenience only */ } };
  const hub = useMemo(() => me && makeHub(me, me.companies.some((c) => c.id === company) ? company : 'all', setCompany, reloadMe), [me, company, reloadMe]);
  if (err) return (
    <main className="content" style={{ maxWidth: 560 }}>
      <div className="notice bad" role="alert"><strong>{err.message}</strong></div>
      <Button variant="secondary" onClick={() => signOut()}>Sign out</Button>
    </main>
  );
  if (!me || !hub) return <main className="content"><Skeleton lines={6} /></main>;
  if (me.mfaRequired) return <MfaGate onDone={reloadMe} />;
  if (!me.companies.length && me.agents.length) return <HubCtx.Provider value={hub}><ToastAgentShell /></HubCtx.Provider>;
  return <HubCtx.Provider value={hub}><Shell /></HubCtx.Provider>;
}

// Grouped so the sidebar reads as a few clear areas rather than one long list. People sits high: it is used most.
const NAV: { to: string; label: string; icon: string; group: string; show?: (h: ReturnType<typeof useHub>) => boolean }[] = [
  { to: '/', label: 'My Day', icon: 'home', group: '' },
  { to: '/inbox', label: 'Needs Your Review', icon: 'inbox', group: '' },
  { to: '/news', label: 'News', icon: 'note', group: '' },
  { to: '/people', label: 'People', icon: 'users', group: 'People' },
  { to: '/performance', label: 'Performance', icon: 'check', group: 'People' },
  { to: '/workload', label: 'Workload', icon: 'tasks', group: 'People', show: (h) => h.can('visits.view_all') },
  { to: '/properties', label: 'Properties', icon: 'building', group: 'Properties & visits' },
  { to: '/attendance', label: 'Visits & attendance', icon: 'clock', group: 'Properties & visits' },
  { to: '/tasks', label: 'Tasks', icon: 'tasks', group: 'Properties & visits' },
  { to: '/handover', label: 'Handover', icon: 'note', group: 'Properties & visits' },
  { to: '/estates', label: 'Repairs & safety', icon: 'shield', group: 'Properties & visits' },
  { to: '/activity', label: 'Calendar & activity', icon: 'calendar', group: 'Time & leave' },
  { to: '/timesheets', label: 'Timesheets', icon: 'clock', group: 'Time & leave' },
  { to: '/leave', label: 'Leave', icon: 'calendar', group: 'Time & leave' },
  { to: '/training', label: 'Training', icon: 'check', group: 'Learning & policies' },
  { to: '/policies', label: 'Policies & handbooks', icon: 'file', group: 'Learning & policies' },
  { to: '/governance', label: 'Governance', icon: 'shield', group: 'Organisation', show: (h) => h.can('governance.view') },
  { to: '/concerns', label: 'Concerns', icon: 'note', group: 'Organisation' },
  { to: '/finance', label: 'Finance & expenses', icon: 'file', group: 'Organisation' },
  { to: '/assistant', label: 'AI assistant', icon: 'search', group: 'Organisation' },
];
// The visible pages, in groups, in NAV order.
const navGroups = (hub: ReturnType<typeof useHub>) => {
  const out: [string, typeof NAV][] = [];
  for (const n of NAV.filter((x) => !x.show || x.show(hub))) {
    if (out.at(-1)?.[0] !== n.group) out.push([n.group, []]);
    out.at(-1)![1].push(n);
  }
  return out;
};

function Shell() {
  const hub = useHub();
  const { me, company, setCompany } = hub;
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('hub.nav') === 'collapsed'; } catch { return false; } });
  const [compact, setCompact] = useState(() => { try { return localStorage.getItem('hub.density') === 'compact'; } catch { return false; } });
  const toggleDensity = () => setCompact((value) => { try { localStorage.setItem('hub.density', value ? 'comfortable' : 'compact'); } catch { /* optional preference */ } return !value; });
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const inbox = useApi<any[]>(`/inbox${hub.q()}`);
  const isAdmin = ADMIN_PERMS.some((p) => hub.can(p));
  const selected = hub.co(company);

  // Move focus to the page heading on navigation so screen-reader users hear the new page.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    requestAnimationFrame(() => document.getElementById('page-title')?.focus());
    setMore(false);
    inbox.reload();
  }, [loc.pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); } };
    const on = () => setOnline(true), off = () => setOnline(false);
    addEventListener('keydown', key); addEventListener('online', on); addEventListener('offline', off);
    return () => { removeEventListener('keydown', key); removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);
  const toggleNav = () => setCollapsed((c) => { try { localStorage.setItem('hub.nav', c ? 'open' : 'collapsed'); } catch { /* ignore */ } return !c; });
  const name = me.person.preferred_name ?? me.person.full_name;
  const inboxCount = inbox.data?.length ?? 0;

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${compact ? 'compact' : ''}`}>
      <a className="skip-link" href="#main">Skip to main content</a>
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand"><span className="brand-mark" aria-hidden="true">VW</span><span className="brand-text"><strong>Valor &amp; Wellbeing Hub</strong><span>People · Performance · Properties · Governance</span></span></Link>
        <nav aria-label="Primary">
          {navGroups(hub).map(([g, items]) => (
            <div key={g || 'top'} className="nav-group" role={g ? 'group' : undefined} aria-label={g || undefined}>
              {g && <div className="nav-section" aria-hidden="true">{g}</div>}
              {items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.to === '/'} className="nav-link" title={collapsed ? n.label : undefined}>
                  <Icon name={n.icon} /><span className="nav-label">{n.label}</span>{n.to === '/inbox' && inboxCount > 0 && <span className="count" aria-label={`${inboxCount} items`}>{inboxCount}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          {selected?.support_system_url && <a className="nav-link" href={selected.support_system_url} target="_blank" rel="noopener noreferrer"><Icon name="link" /><span className="nav-label">Open Support System<span className="sr-only"> (opens in a new tab; separate system and sign-in)</span></span></a>}
        </nav>
        <div className="sidebar-foot">
          {isAdmin && <NavLink to="/admin" className="nav-link nav-admin"><Icon name="settings" /><span className="nav-label">Admin Centre</span></NavLink>}
          <button type="button" className="nav-link" style={{ background: 'none', border: 0, width: '100%', font: 'inherit', cursor: 'pointer' }} onClick={toggleNav} aria-expanded={!collapsed}>
            <Icon name="menu" /><span className="nav-label">{collapsed ? 'Expand menu' : 'Collapse menu'}</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <label className="sr-only" htmlFor="company-select">Company</label>
          <select id="company-select" className="co-select" value={company} onChange={(e) => setCompany(e.target.value)}>
            {me.companies.length > 1 && <option value="all">All my companies</option>}
            {me.companies.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
          </select>
          <span className="grow" />
          <Button variant="ghost" className="hide-mobile" onClick={toggleDensity} aria-pressed={compact} title="Switch between comfortable and compact layouts">{compact ? 'Comfortable view' : 'Compact view'}</Button>
          <Button variant="secondary" className="hide-mobile" onClick={() => setPalette(true)} aria-keyshortcuts="Control+K Meta+K"><Icon name="search" />Search <kbd className="muted small">Ctrl K</kbd></Button>
          <Button variant="ghost" className="icon-btn hide-desktop" onClick={() => setPalette(true)} aria-label="Search"><Icon name="search" /></Button>
          <QuickCreate />
          <Link to="/messages" className="btn ghost icon-btn" aria-label={`Messages${me.unreadMessages ? `, ${me.unreadMessages} unread` : ''}`} style={{ position: 'relative' }}>
            <Icon name="note" />{me.unreadMessages > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 6, right: 6, background: 'var(--teal-text)', color: '#fff', borderRadius: 999, fontSize: 11, padding: '0 5px', fontWeight: 700 }}>{me.unreadMessages}</span>}
          </Link>
          <Link to="/notifications" className="btn ghost icon-btn" aria-label={`Notifications${me.unread ? `, ${me.unread} unread` : ''}`} style={{ position: 'relative' }}>
            <Icon name="bell" />{me.unread > 0 && <span aria-hidden="true" style={{ position: 'absolute', top: 6, right: 6, background: 'var(--danger)', color: '#fff', borderRadius: 999, fontSize: 11, padding: '0 5px', fontWeight: 700 }}>{me.unread}</span>}
          </Link>
          <ProfileMenu name={name} />
        </header>
        {!online && <div className="offline-banner" role="status">You are offline. Nothing can be saved until your connection returns.</div>}
        {me.activeVisit && loc.pathname !== '/visit' && <VisitBanner />}
        <main id="main" className="content" key={loc.pathname}>
          <Routes>
            <Route path="/" element={<MyDay />} />
            <Route path="/properties" element={<Properties />} />
            <Route path="/properties/:id" element={<PropertyPage />} />
            <Route path="/visit" element={<ActiveVisit />} />
            <Route path="/visits/new" element={<ManualVisit />} />
            <Route path="/visits/:id" element={<VisitDetail />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/attendance" element={<Attendance />} />
            <Route path="/tasks" element={<Tasks />} />
            <Route path="/tasks/:id" element={<TaskPage />} />
            <Route path="/timesheets" element={<Timesheets />} />
            <Route path="/leave" element={<LeavePage />} />
            <Route path="/job-descriptions/:id" element={<JobDescriptionPage />} />
            <Route path="/workload" element={<Workload />} />
            <Route path="/handover" element={<Handover />} />
            <Route path="/performance" element={<Performance />} />
            <Route path="/training" element={<Training />} />
            <Route path="/training/courses/:id" element={<CoursePlayer />} />
            <Route path="/training/courses/:id/edit" element={<CourseEditor />} />
            <Route path="/policies" element={<Policies />} />
            <Route path="/policies/:id" element={<PolicyPage />} />
            <Route path="/governance" element={<Governance />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/finance/:id" element={<FinanceDocument />} />
            <Route path="/messages" element={<Messages />} />
            <Route path="/messages/:id" element={<Conversation />} />
            <Route path="/news" element={<News />} />
            <Route path="/assistant" element={<Assistant />} />
            <Route path="/install" element={<InstallPage />} />
            <Route path="/governance/actions/:id" element={<ActionPage />} />
            <Route path="/concerns" element={<Concerns />} />
            <Route path="/concerns/:id" element={<CasePage />} />
            <Route path="/estates" element={<Estates />} />
            <Route path="/estates/repairs/:id" element={<RepairPage />} />
            <Route path="/estates/agents/:id" element={<AgentPage />} />
            <Route path="/agent" element={<AgentPortal />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/approvals" element={<Inbox />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/people" element={<People />} />
            <Route path="/people/:id" element={<PersonPage />} />
            <Route path="/people/:id/resume" element={<Resume />} />
            <Route path="/profile" element={<PersonPage self />} />
            <Route path="/admin/*" element={<Admin />} />
            <Route path="*" element={<div><h1 id="page-title" tabIndex={-1}>Page not found</h1><p><Link to="/">Go to My Day</Link></p></div>} />
          </Routes>
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        <NavLink to="/" end><Icon name="home" />My Day</NavLink>
        <NavLink to="/properties"><Icon name="building" />Properties</NavLink>
        <NavLink to={me.activeVisit ? '/visit' : '/properties?mine=true'}><Icon name={me.activeVisit ? 'clock' : 'play'} />{me.activeVisit ? 'Visit' : 'Start'}</NavLink>
        <NavLink to="/tasks"><Icon name="tasks" />Tasks</NavLink>
        <a href="#more" onClick={(e) => { e.preventDefault(); setMore(true); }} aria-haspopup="dialog"><Icon name="menu" />More{inboxCount > 0 && <span className="sr-only">, {inboxCount} items need review</span>}</a>
      </nav>
      {more && <MoreSheet onClose={() => setMore(false)} isAdmin={isAdmin} inboxCount={inboxCount} />}
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}

function VisitBanner() {
  const { me } = useHub();
  const v = me.activeVisit!;
  const [now, setNow] = useState(serverNow());
  useEffect(() => { const t = setInterval(() => setNow(serverNow()), 1000); return () => clearInterval(t); }, []);
  return (
    <div className="visit-banner" role="region" aria-label="Visit in progress">
      <Icon name="clock" />
      <span><strong>Visit in progress</strong> at {v.property_name} ({v.company_code}) · <span className="timer" aria-hidden="true">{fmtElapsed(now - Date.parse(v.started_at))}</span></span>
      <Link className="btn go" to="/visit">Finish Visit</Link>
    </div>
  );
}

function QuickCreate() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => { if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('mousedown', close); addEventListener('keydown', close);
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', close); };
  }, [open]);
  const go = (to: string) => { setOpen(false); nav(to); };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <Button aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} className="icon-btn" aria-label="Create new"><Icon name="plus" /></Button>
      {open && (
        <div role="menu" className="card" style={{ position: 'absolute', right: 0, top: 52, padding: 8, minWidth: 240, zIndex: 40 }}>
          {[['Start a visit', '/properties?mine=true'], ['Log a completed visit', '/visits/new'], ['New task', '/tasks?new=1'], ['Log other working time', '/timesheets?log=1'], ['Write a handover note', '/handover?new=1']].map(([t, to]) => (
            <button key={to} role="menuitem" type="button" className="btn ghost block" style={{ justifyContent: 'flex-start' }} onClick={() => go(to)}>{t}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileMenu({ name }: { name: string }) {
  const { me } = useHub();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" className="btn ghost" style={{ padding: 4 }} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        <span aria-hidden="true"><Avatar personId={me.person.id} name={me.person.full_name} hasPhoto={!!me.person.photo_path} /></span><span className="sr-only">Account menu for {name}</span>
      </button>
      {open && (
        <div role="menu" className="card" style={{ position: 'absolute', right: 0, top: 52, padding: 8, minWidth: 220, zIndex: 40 }} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
          <p className="small muted" style={{ padding: '4px 8px' }}>Signed in as {me.person.email}</p>
          <Link role="menuitem" className="btn ghost block" style={{ justifyContent: 'flex-start' }} to="/profile" onClick={() => setOpen(false)}>My Profile / Resume</Link>
          <Link role="menuitem" className="btn ghost block" style={{ justifyContent: 'flex-start' }} to="/install" onClick={() => setOpen(false)}>Install on your phone</Link>
          <button role="menuitem" type="button" className="btn ghost block" style={{ justifyContent: 'flex-start' }} onClick={() => signOut()}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function MoreSheet({ onClose, isAdmin, inboxCount }: { onClose: () => void; isAdmin: boolean; inboxCount: number }) {
  const hub = useHub();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const sel = hub.co(hub.company);
  return (
    <dialog ref={ref} className="panel" aria-label="More" onClose={onClose}>
      <div className="dialog-head"><h2>More</h2><button className="btn ghost icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
      <div className="dialog-body">
        {navGroups(hub).map(([g, items]) => (
          <section key={g || 'top'} aria-label={g || 'Main'}>
            {g && <h3 className="small muted" style={{ margin: '16px 0 8px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{g}</h3>}
            {items.map((n) => <Link key={n.to} to={n.to} className="btn secondary block" style={{ marginBottom: 8, justifyContent: 'flex-start' }}><Icon name={n.icon} />{n.label}{n.to === '/inbox' && inboxCount > 0 && ` (${inboxCount})`}</Link>)}
          </section>
        ))}
        {sel?.support_system_url && <a className="btn secondary block" style={{ marginBottom: 8, justifyContent: 'flex-start' }} href={sel.support_system_url} target="_blank" rel="noopener noreferrer"><Icon name="link" />Open Support System</a>}
        {isAdmin && <Link to="/admin" className="btn block" style={{ justifyContent: 'flex-start' }}><Icon name="settings" />Admin Centre</Link>}
      </div>
    </dialog>
  );
}

// Ctrl/Cmd + K: actions and permission-aware search. Opened by keyboard, so it does not animate.
function Palette({ onClose }: { onClose: () => void }) {
  const hub = useHub();
  const nav = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const [term, setTerm] = useState('');
  const [res, setRes] = useState<any>(null);
  const [idx, setIdx] = useState(0);
  useEffect(() => { ref.current?.showModal(); }, []);
  useEffect(() => {
    if (term.trim().length < 2) { setRes(null); return; }
    const t = setTimeout(() => get(`/search?q=${encodeURIComponent(term.trim())}`).then(setRes).catch(() => setRes(null)), 200);
    return () => clearTimeout(t);
  }, [term]);
  const actions: [string, string][] = [['Start a visit', '/properties?mine=true'], ['Log a completed visit', '/visits/new'], ['New task', '/tasks?new=1'], ['Log other working time', '/timesheets?log=1'], ['Needs Your Review', '/inbox'], ['My Profile / Resume', '/profile']];
  const items: { group: string; label: string; sub?: string; to: string }[] = [
    ...actions.filter(([l]) => l.toLowerCase().includes(term.toLowerCase())).map(([label, to]) => ({ group: 'Actions', label, to })),
    ...NAV.filter((n) => (!n.show || n.show(hub)) && term.trim().length > 0 && n.label.toLowerCase().includes(term.trim().toLowerCase())).map((n) => ({ group: 'Workspace pages', label: n.label, to: n.to })),
    ...(res?.people ?? []).map((p: any) => ({ group: 'People', label: p.label, sub: p.sub, to: `/people/${p.id}` })),
    ...(res?.properties ?? []).map((p: any) => ({ group: 'Properties', label: p.label, sub: p.sub, to: `/properties/${p.id}` })),
    ...(res?.tasks ?? []).map((p: any) => ({ group: 'Tasks', label: p.label, sub: p.sub, to: `/tasks/${p.id}` })),
  ];
  const go = (to: string) => { onClose(); nav(to); };
  return (
    <dialog ref={ref} className="palette" aria-label="Search and quick actions" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <input autoFocus role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[idx] ? `pi-${idx}` : undefined} aria-label="Search people, properties and tasks, or choose an action"
        placeholder="Search or choose an action…" value={term} onChange={(e) => { setTerm(e.target.value); setIdx(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
          if (e.key === 'Enter' && items[idx]) go(items[idx].to);
        }} />
      <ul id="palette-list" role="listbox" aria-label="Results">
        {items.map((it, i) => (
          <li key={`${it.group}${it.to}`} role="presentation">
            {(i === 0 || items[i - 1].group !== it.group) && <div className="group" aria-hidden="true">{it.group}</div>}
            <button type="button" id={`pi-${i}`} role="option" aria-selected={i === idx} tabIndex={-1} onClick={() => go(it.to)} onMouseEnter={() => setIdx(i)}>
              <span>{it.label}<span className="sr-only"> ({it.group})</span></span>{it.sub && <span className="muted small">{it.sub}</span>}
            </button>
          </li>
        ))}
        {term.length >= 2 && res && items.length === 0 && <li className="empty">No matches you have access to.</li>}
      </ul>
    </dialog>
  );
}

// Managing-agent users have no staff access at all: a minimal shell with the agent portal only.
function ToastAgentShell() {
  const { me } = useHub();
  return (
    <div className="main">
      <a className="skip-link" href="#main">Skip to main content</a>
      <header className="topbar"><span className="brand-mark" aria-hidden="true" style={{ color: '#fff' }}>VW</span><strong>Valor &amp; Wellbeing Hub — agent portal</strong><span className="grow" /><span className="small muted hide-mobile">{me.person.email}</span><Button variant="secondary" onClick={() => signOut()}>Sign out</Button></header>
      <main id="main" className="content">
        <Routes>
          <Route path="/estates/repairs/:id" element={<RepairPage />} />
          <Route path="*" element={<AgentPortal />} />
        </Routes>
      </main>
    </div>
  );
}


// Outbound email. Everything goes through the outbound_messages table (the outbox), so sends are deduplicated,
// retried with back-off and visible when they fail. In-app notifications are always created separately.
// WhatsApp is paused: its tables exist (migration 008) but nothing sends to it.
import { type Db, one, q, tx } from './db.ts';
import { LONDON_TODAY } from './http.ts';

const APP_URL = process.env.APP_URL ?? 'http://localhost:5173';
const emailReady = () => !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
const MAX_ATTEMPTS = 5;

export async function enqueue(db: Db, m: { person_id: string; company_id: string | null; category: string; dedup: string; subject: string; body: string; link: string }) {
  const pref = await one(`select p.email, mp.email_enabled, mp.categories from people p left join messaging_preferences mp on mp.person_id = p.id where p.id = $1 and p.status <> 'left'`, [m.person_id], db);
  if (!pref?.email || pref.email_enabled === false || (pref.categories && !pref.categories.includes(m.category))) return;
  // Without a configured provider the message is recorded as not configured, never shown as sent.
  await q(`insert into outbound_messages (company_id, person_id, channel, category, dedup_key, subject, body, link, status) values ($1,$2,'email',$3,$4,$5,$6,$7,$8) on conflict (dedup_key) do nothing`,
    [m.company_id, m.person_id, m.category, `${m.dedup}:email`, m.subject, m.body, m.link, emailReady() ? 'queued' : 'not_configured'], db);
}

async function sendEmail(to: string, subject: string, body: string, link: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to, subject, text: `${body}\n\n${APP_URL}${link}\n\nThis email contains no personal details. Sign in to see them.` }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`email provider ${res.status}: ${json?.message ?? 'error'}`);
  return json.id as string;
}

// One pass of the worker. Rows are claimed with SKIP LOCKED, so several server instances never send the same message.
export async function processOutbox(limit = 20, send = sendEmail) {
  const batch = await tx((db) => q(`update outbound_messages set status = 'sending', attempts = attempts + 1, updated_at = now()
                                     where id in (select id from outbound_messages where status = 'queued' and next_attempt_at <= now() order by next_attempt_at limit $1 for update skip locked)
                                     returning *`, [limit], db));
  for (const m of batch) {
    try {
      const p = await one<{ email: string }>('select email from people where id = $1', [m.person_id]);
      const providerId = await send(p!.email, m.subject ?? 'Valor & Wellbeing Hub', m.body, m.link);
      await q(`update outbound_messages set status = 'sent', provider_id = $2, last_error = null, updated_at = now() where id = $1`, [m.id, providerId ?? null]);
    } catch (e: any) {
      await q(`update outbound_messages set status = $2, last_error = $3, next_attempt_at = now() + make_interval(mins => power(2, $4)::int), updated_at = now() where id = $1`,
        [m.id, m.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', String(e?.message ?? e).slice(0, 500), m.attempts]);
    }
  }
  return batch.length;
}

// Daily reminders. Dedup keys make repeated runs harmless.
export async function queueReminders() {
  await tx(async (db) => {
    for (const s of await q(`select s.id, s.person_id, s.company_id, p.name from scheduled_visits s join properties p on p.id = s.property_id
                              where s.status = 'scheduled' and (s.planned_start at time zone 'Europe/London')::date = ${LONDON_TODAY} + 1`, [], db))
      await enqueue(db, { person_id: s.person_id, company_id: s.company_id, category: 'visit_reminder', dedup: `visit:${s.id}`, subject: 'Visit tomorrow', body: `Reminder: you have a planned visit tomorrow at ${s.name}.`, link: '/' });
    for (const t of await q(`select m.person_id, m.company_id, m.course_root_id, m.due_on from training_matrix(${LONDON_TODAY}) m where m.status in ('due','expiring','overdue') and m.due_on <= ${LONDON_TODAY} + 7`, [], db))
      await enqueue(db, { person_id: t.person_id, company_id: t.company_id, category: 'training_due', dedup: `training:${t.person_id}:${t.course_root_id}:${t.due_on}`, subject: 'Training due', body: 'You have required training due soon.', link: '/training' });
  });
}

// shortcut: in-process timers; fine for one Render instance (SKIP LOCKED keeps more instances safe). Move to a Render cron job if the API scales out.
export function startWorkers() {
  const run = (f: () => Promise<unknown>) => f().catch((e) => console.error(JSON.stringify({ level: 'error', message: 'background job failed', error: String(e?.message ?? e) })));
  setInterval(() => run(processOutbox), 30_000).unref();
  setInterval(() => run(queueReminders), 6 * 3600_000).unref();
  setInterval(() => run(async () => (await import('./routes/ai.ts')).purgeAiRuns()), 24 * 3600_000).unref();
  run(queueReminders);
}

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { hashPassword, newToken, sha256, verifyPassword } from '../crypto.ts';
import { one, pool, q, tx } from '../db.ts';
import { audit, bad, conflict, forbidden, HttpError, idParam, LONDON_TODAY, notFound, notify, parse, text, uuid } from '../http.ts';
import { emailReady, sendEmail } from '../outbox.ts';
import { jobRole } from '../jobroles.ts';
import { ACTIVE_APPT, companiesWith, need } from '../perm.ts';

const credentials = z.object({ email: z.email().trim().toLowerCase().max(254), password: z.string().min(8).max(200) });
const limit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
export const registrationPublic = Router();
export const registrationAdmin = Router();

registrationPublic.get('/auth/organisations', async (_req, res) => {
  res.json(await q('select id, name from companies order by name'));
});
registrationPublic.get('/job-roles', async (_req, res) => {
  res.json(await q('select j.key, j.label, r.label as access_label from job_roles j join roles r on r.key = j.access_role_key order by j.sort'));
});

registrationPublic.post('/auth/register', limit, async (req, res) => {
  const b = parse(credentials.extend({ full_name: text(120).min(2), company_id: uuid.optional(), organisation_name: text(160).min(2).optional(), job_role_key: z.string().max(60) }), req.body);
  if (!!b.company_id === !!b.organisation_name) throw bad('Choose an organisation or request a new one.');
  if (b.password.toLowerCase().includes(b.email.split('@')[0])) throw bad('Do not include your email address in your password.');
  if (b.company_id && !await one('select id from companies where id=$1', [b.company_id])) throw bad('Choose an available organisation.');
  // The requested role grants nothing yet: the approver confirms it (and needs the right to hand out its access level).
  const jr = await one('select label from job_roles where key=$1', [b.job_role_key]);
  if (!jr) throw bad('Choose your job role from the list.', { fields: { job_role_key: 'Choose from the list' } });
  const hash = await hashPassword(b.password);
  // Never overwrite an account or a pending request, or reveal that one exists. A rejected request can be sent again:
  // it goes back to pending with the new details (the earlier decision stays in the audit log).
  const r = await one(`insert into staff_registrations(email,full_name,password_hash,company_id,organisation_name,job_title,job_role_key)
    select $1,$2,$3,$4,$5,$6,$7 where not exists(select 1 from people where lower(email)=lower($1))
    on conflict (lower(email)) do update set full_name=excluded.full_name,password_hash=excluded.password_hash,company_id=excluded.company_id,
      organisation_name=excluded.organisation_name,job_title=excluded.job_title,job_role_key=excluded.job_role_key,status='pending',
      decided_by=null,decided_at=null,decision_note=null,person_id=null,created_at=now()
      where staff_registrations.status='rejected'
    returning id`, [b.email,b.full_name,hash,b.company_id ?? null,b.organisation_name ?? null,jr.label,b.job_role_key]);
  if (r) await tellApprovers(r.id); // no email verification step: an administrator checks each request before approving
  res.status(202).json({ ok: true });
});

// Super admins, and people who can add staff in the requested company, get a notification and an email.
// Links emailed before verification was removed still work at /auth/verify-email; they no longer gate approval.
async function tellApprovers(id: string) {
  const r = await one('select full_name, job_title, company_id from staff_registrations where id = $1', [id]);
  const to = await q<{ id: string; email: string }>(`select distinct p.id, p.email from role_grants g join people p on p.id = g.person_id and p.status = 'active'
      left join role_permissions rp on rp.role_key = g.role_key
     where g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
       and (g.role_key = 'super_admin' or (rp.permission_key = 'staff.create' and g.company_id = $1))`, [r.company_id]);
  for (const a of to) {
    await notify(pool, a.id, r.company_id, `New sign-up request: ${r.full_name} (${r.job_title})`, '/admin/requests');
    if (emailReady() && a.email) await sendEmail(a.email, 'A new staff sign-up is waiting for approval', 'Someone has asked to join the Hub. Check who they are, then approve or reject the request in the Admin Centre.', '/admin/requests').catch(() => {});
  }
}
registrationPublic.post('/auth/verify-email', limit, async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(100) }), req.body);
  const r = await one(`update staff_registrations set email_verified_at=now(),verification_hash=null,verification_expires_at=null
    where verification_hash=$1 and verification_expires_at>now() and email_verified_at is null and status='pending' returning id`, [sha256(token)]);
  if (!r) throw bad('This verification link has expired or has already been used.');
  res.json({ ok: true });
});

registrationAdmin.get('/admin/registrations', async (req,res) => {
  const cs = companiesWith(req.access, 'staff.create').filter(c => req.access.perms.get(c)?.has('appointments.manage'));
  if (!cs.length && !req.access.superAdmin) throw forbidden();
  res.json(await q(`select r.id,r.email,r.full_name,r.company_id,r.organisation_name,r.job_title,r.job_role_key,r.status,r.email_verified_at,r.created_at,r.decision_note,c.name as company_name
    from staff_registrations r left join companies c on c.id=r.company_id
    where r.company_id=any($1::uuid[]) or $2 order by r.created_at desc limit 200`, [cs,req.access.superAdmin]));
});

registrationAdmin.post('/admin/registrations/:id/decide', async (req,res) => {
  const id=idParam(req.params.id);
  const b=parse(z.object({ decision:z.enum(['approved','rejected']), company_id:uuid.optional(), new_organisation:z.object({name:text(160).min(2),code:z.string().regex(/^[A-Z]{2,6}$/)}).optional(), note:text(500).min(3), job_role_key:z.string().max(60).optional(), relationship:z.enum(['employee','contractor','agency','secondment','volunteer','other']).default('employee'), also_company_ids:z.array(uuid).max(10).default([]), also_job_role_keys:z.array(z.string().max(60)).max(10).default([]) }),req.body);
  const result=await tx(async db => {
    const r=await one('select * from staff_registrations where id=$1 for update',[id],db);
    if (!r) throw notFound();
    if (r.company_id) { need(req.access,'staff.create',r.company_id); need(req.access,'appointments.manage',r.company_id); }
    else if (!req.access.superAdmin) throw forbidden();
    if (r.status!=='pending') throw conflict('This request has already been decided.');
    let companyId=b.company_id ?? r.company_id;
    if (b.decision==='approved') {
      if (b.new_organisation) {
        if (!req.access.superAdmin) throw forbidden();
        if (b.company_id) throw bad('Choose an existing organisation or create one.');
        const c=await one('insert into companies(name,code) values($1,$2) returning id',[b.new_organisation.name,b.new_organisation.code],db);
        companyId=c.id;
        await audit(db,req.person.id,companyId,'company',companyId,'create_from_request',{registration_id:id});
      }
      if (!companyId) throw bad('Choose the organisation to approve.');
      // Reassignment at approval needs permission in both the requested and destination organisation.
      if (!req.access.superAdmin) { need(req.access,'staff.create',companyId); need(req.access,'appointments.manage',companyId); }
      const roleKey=b.job_role_key ?? r.job_role_key;
      if (!roleKey) throw bad('Choose their job role.',{fields:{job_role_key:'Required'}});
      const p=await one(`insert into people(email,full_name,staff_ref,password_hash,status)
        values($1,$2,$3,$4,'active') returning id`,[r.email,r.full_name,`S-${newToken().slice(0,16)}`,r.password_hash],db);
      r.person_id=p.id;
      // People can hold several job roles and work for several organisations: one role (appointment) for each job role in each organisation chosen.
      const roleKeys=[...new Set([roleKey,...b.also_job_role_keys])];
      for (const co of [companyId,...new Set(b.also_company_ids.filter(c=>c!==companyId))]) {
        if (!req.access.superAdmin) { need(req.access,'staff.create',co); need(req.access,'appointments.manage',co); }
        for (const key of roleKeys) {
          const jr=await jobRole(db,req.access,key,co);
          const ap=await one(`insert into appointments(person_id,company_id,relationship,legal_employer_company_id,job_title,job_role_key,start_date)
            values($1,$2,$3,$2,$4,$5,${LONDON_TODAY}) returning id`,[p.id,co,b.relationship,jr.label,jr.key],db);
          await audit(db,req.person.id,co,'appointment',ap.id,'create_from_registration',{person_id:p.id,registration_id:id});
        }
      }
    }
    await q(`update staff_registrations set status=$2,decided_by=$3,decided_at=now(),decision_note=$4,person_id=$5,
      password_hash=null,verification_hash=null,verification_expires_at=null where id=$1`,[id,b.decision,req.person.id,b.note,r.person_id],db);
    await audit(db,req.person.id,companyId ?? null,'staff_registration',id,b.decision,{note:b.note,person_id:r.person_id,destination_company_id:companyId});
    return {email:r.email,person_id:r.person_id};
  });
  let email='not_configured';
  if (emailReady()) { try { await sendEmail(result.email,`Your Hub request was ${b.decision}`,b.decision==='approved'?'Your request has been approved. You can now sign in with the password you chose.':'Your request was not approved. If you think this was a mistake, check your details and send a new request from the sign-up page, or contact your administrator.', '/'); email='sent'; } catch { email='failed'; } }
  res.json({ok:true,person_id:result.person_id,email});
});

// A reassignment creates a new appointment; historical work stays with its original organisation.
registrationAdmin.post('/admin/appointments/:id/reassign', async (req,res) => {
  const id=idParam(req.params.id);
  const b=parse(z.object({company_id:uuid,reason:text(500).min(3),transfer_to:uuid.optional()}),req.body);
  const result=await tx(async db => {
    const ap=await one('select * from appointments where id=$1 for update',[id],db);
    if (!ap) throw notFound();
    need(req.access,'appointments.manage',ap.company_id); need(req.access,'appointments.manage',b.company_id);
    need(req.access,'staff.create',b.company_id);
    if (ap.person_id===req.person.id) throw forbidden('You cannot reassign your own organisation.');
    if (ap.company_id===b.company_id) throw bad('Choose a different organisation.');
    if (!await one(`select 1 from appointments a where a.id=$1 and ${ACTIVE_APPT('a')}`,[id],db)) throw conflict('Only current appointments can be reassigned.');
    // Serialise transfers of this person and avoid moving stronger or external portal accounts.
    await q('select id from people where id=$1 for update',[ap.person_id],db);
    if (!req.access.superAdmin && await one(`select 1 from role_grants g join roles r on r.key=g.role_key where g.person_id=$1 and r.privileged and g.revoked_at is null and (g.expires_at is null or g.expires_at>now())
      union all select 1 from job_roles j join roles r on r.key=j.access_role_key where j.key=$2 and r.privileged`,[ap.person_id,ap.job_role_key],db)) throw forbidden('A super administrator must reassign privileged staff.');
    if (ap.job_role_key) await jobRole(db,req.access,ap.job_role_key,b.company_id);
    if (await one(`select 1 from appointments a where a.person_id=$1 and a.company_id=$2 and a.status<>'ended' and (a.end_date is null or a.end_date>=${LONDON_TODAY})`,[ap.person_id,b.company_id],db)) throw conflict('This person already has an appointment in that organisation.');
    if (await one(`select 1 from visits where appointment_id=$1 and status='in_progress'`,[id],db)) throw conflict('Finish the current visit before reassigning.');
    const other=await one(`select 1 from appointments a where a.person_id=$1 and a.company_id=$2 and a.id<>$3 and ${ACTIVE_APPT('a')}`,[ap.person_id,ap.company_id,id],db);
    if (!other) {
      const tasks=await one(`select count(*) n from tasks where company_id=$1 and status<>'completed' and (owner_id=$2 or reviewer_id=$2)`,[ap.company_id,ap.person_id],db);
      if (tasks.n && !b.transfer_to) throw conflict('Choose a colleague to take over outstanding tasks in the old organisation.');
      if (b.transfer_to) {
        if (b.transfer_to===ap.person_id || !await one(`select 1 from appointments a where a.person_id=$1 and a.company_id=$2 and ${ACTIVE_APPT('a')}`,[b.transfer_to,ap.company_id],db)) throw bad('The task recipient must be another current colleague in the old organisation.');
        await q(`update tasks set owner_id=case when owner_id=$2 then $3 else owner_id end,reviewer_id=case when reviewer_id=$2 then $3 else reviewer_id end,updated_at=now() where company_id=$1 and status<>'completed' and (owner_id=$2 or reviewer_id=$2)`,[ap.company_id,ap.person_id,b.transfer_to],db);
      }
      await q('update role_grants set revoked_at=now(),revoked_by=$3 where person_id=$1 and company_id=$2 and revoked_at is null',[ap.person_id,ap.company_id,req.person.id],db);
    }
    await q(`update appointments set status='ended',end_date=${LONDON_TODAY},ended_reason=$2,updated_at=now() where id=$1`,[id,b.reason],db);
    await q(`update appointment_properties set to_date=greatest(from_date,${LONDON_TODAY}) where appointment_id=$1 and (to_date is null or to_date>${LONDON_TODAY})`,[id],db);
    await q(`update appointment_rates set effective_to=greatest(effective_from,${LONDON_TODAY}) where appointment_id=$1 and (effective_to is null or effective_to>${LONDON_TODAY})`,[id],db);
    await q(`update scheduled_visits set status='cancelled' where appointment_id=$1 and status='scheduled'`,[id],db);
    const next=await one(`insert into appointments(person_id,company_id,relationship,legal_employer_company_id,legal_employer_name,job_title,start_date,contracted_hours_per_week)
      values($1,$2,$3,$4,$5,$6,${LONDON_TODAY},$7) returning id`,[ap.person_id,b.company_id,ap.relationship,ap.legal_employer_company_id,ap.legal_employer_name,ap.job_title,ap.contracted_hours_per_week],db);
    if (ap.job_role_key) await q('update appointments set job_role_key=$2 where id=$1',[next.id,ap.job_role_key],db);
    await q('delete from sessions where person_id=$1',[ap.person_id],db);
    await q(`update auth_tokens set used_at=now() where person_id=$1 and used_at is null`,[ap.person_id],db);
    const detail={person_id:ap.person_id,from_company_id:ap.company_id,to_company_id:b.company_id,previous_appointment_id:id,new_appointment_id:next.id,reason:b.reason,transfer_to:b.transfer_to ?? null};
    await audit(db,req.person.id,ap.company_id,'appointment',id,'organisation_reassigned',detail);
    await audit(db,req.person.id,b.company_id,'appointment',next.id,'organisation_reassigned',detail);
    return {appointment_id:next.id};
  });
  res.json(result);
});

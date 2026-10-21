import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app, as, A, C, P, pool, resetDb } from './helpers.ts';

const pw='Oaks!729'; // exactly eight characters: the minimum supported by sign-up and resend
let emails:any[]=[];
let testNetwork=0;
const publicPost=(url:string)=>request(app).post(url).set('X-Forwarded-For', '192.0.2.' + testNetwork);
beforeEach(async()=>{
  await resetDb();emails=[];testNetwork++;
  vi.stubEnv('RESEND_API_KEY','test-key');vi.stubEnv('EMAIL_FROM','Valor Housing <info@valorhousing.co.uk>');
  vi.stubGlobal('fetch',vi.fn(async (_url,init)=>{emails.push(JSON.parse(init.body));return new Response(JSON.stringify({id:'email-test'}),{status:200,headers:{'Content-Type':'application/json'}});}));
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
const signup=(extra:object={})=>publicPost('/api/auth/register').send({email:'new.staff@example.test',password:pw,full_name:'New Staff',company_id:C.VH,job_title:'Support worker',...extra});
const registration=async()=> (await pool.query('select * from staff_registrations')).rows[0];
const decide=async(id:string,body:object)=> (await as('alex')).post(`/api/admin/registrations/${id}/decide`).send({decision:'approved',note:'Employment details checked',...body});

it('needs only administrator approval; hashes the password and creates only ordinary staff access',async()=>{
  expect((await signup()).status).toBe(202);
  let r=await registration();
  expect(r.password_hash).not.toContain(pw);
  expect(emails.some((e)=>/verify/i.test(e.subject))).toBe(false); // no verification email any more
  expect((await pool.query(`select * from people where email='new.staff@example.test'`)).rowCount).toBe(0);
  // Approvers hear about it straight away: a notification, an email and an item in Needs Your Review.
  expect((await pool.query(`select 1 from notifications where person_id=$1 and link='/admin/requests'`,[P.alex])).rowCount).toBe(1);
  expect(emails.some((e)=>e.subject==='A new staff sign-up is waiting for approval')).toBe(true);
  expect((await (await as('alex')).get('/api/inbox')).body.some((i:any)=>i.kind==='staff_request')).toBe(true);
  expect((await (await as('sam')).get('/api/inbox')).body.some((i:any)=>i.kind==='staff_request')).toBe(false);
  const early=await publicPost('/api/auth/login').send({email:r.email,password:pw});
  expect(early.status).toBe(403);expect(early.body.message).toMatch(/waiting for an administrator/);
  expect((await publicPost('/api/auth/login').send({email:r.email,password:'not the password'})).status).toBe(401); // a wrong password learns nothing
  await signup();expect((await pool.query('select count(*)::int n from staff_registrations')).rows[0].n).toBe(1); // no duplicates
  const approved=await decide(r.id,{});expect(approved.status).toBe(200);
  expect((await decide(r.id,{})).status).toBe(409);
  r=await registration();expect(r.password_hash).toBeNull();
  const login=await publicPost('/api/auth/login').send({email:r.email,password:pw});expect(login.status).toBe(200);
  const me=await request(app).get('/api/me').set('Authorization',`Bearer ${login.body.token}`);
  expect(me.status).toBe(200);expect(me.body.superAdmin).toBe(false);
  expect(me.body.companies.map((c:any)=>c.id)).toEqual([C.VH]);
});

it('reserves new organisation approval for super admins, and rejection never creates access',async()=>{
  expect((await signup({company_id:undefined,organisation_name:'Requested Organisation'})).status).toBe(202);
  const r=await registration();
  expect((await (await as('sam')).get('/api/admin/registrations')).status).toBe(403);
  expect((await (await as('sam')).post(`/api/admin/registrations/${r.id}/decide`).send({decision:'approved',note:'checked',company_id:C.VH})).status).toBe(403);
  const approved=await decide(r.id,{new_organisation:{name:'Requested Organisation',code:'REQ'}});expect(approved.status).toBe(200);
  expect((await pool.query(`select * from companies where code='REQ'`)).rowCount).toBe(1);
  await signup({email:'reject.staff@example.test'});const rejected=(await pool.query(`select id from staff_registrations where email='reject.staff@example.test'`)).rows[0];
  expect((await decide(rejected.id,{decision:'rejected'})).status).toBe(200);
  expect((await pool.query(`select * from people where email='reject.staff@example.test'`)).rowCount).toBe(0);
});

it('still takes requests when email is not set up',async()=>{
  vi.stubEnv('RESEND_API_KEY','');expect((await signup()).status).toBe(202);
  expect((await registration()).status).toBe('pending');expect(emails).toHaveLength(0);
});

it('reassigns a current appointment, preserves history, cancels plans and invalidates sessions',async()=>{
  const admin=await as('alex');const worker=await as('casey');
  const old=(await pool.query('select * from appointments where id=$1',[A.casey])).rows[0];
  const destination=old.company_id===C.VH?C.WHM:C.VH;
  const r=await admin.post(`/api/admin/appointments/${A.casey}/reassign`).send({company_id:destination,reason:'Changed operational team',transfer_to:P.sam});
  expect(r.status).toBe(200);
  const previous=(await pool.query('select * from appointments where id=$1',[A.casey])).rows[0];expect(previous.status).toBe('ended');expect(previous.company_id).toBe(old.company_id);
  const next=(await pool.query('select * from appointments where id=$1',[r.body.appointment_id])).rows[0];expect(next.company_id).toBe(destination);expect(next.person_id).toBe(P.casey);
  expect((await worker.get('/api/me')).status).toBe(401);
  expect((await pool.query(`select * from role_grants where person_id=$1 and company_id=$2 and revoked_at is null`,[P.casey,old.company_id])).rowCount).toBe(0);
  expect((await pool.query(`select * from audit_log where action='organisation_reassigned'`)).rowCount).toBe(2);
});

it('rejects unauthorised transfers and duplicate destinations without changing history',async()=>{
  expect((await (await as('casey')).post(`/api/admin/appointments/${A.samVH}/reassign`).send({company_id:C.WHM,reason:'Attempted move'})).status).toBe(403);
  expect((await (await as('alex')).post(`/api/admin/appointments/${A.samVH}/reassign`).send({company_id:C.WHM,reason:'Duplicate membership'})).status).toBe(409);
  expect((await pool.query('select status from appointments where id=$1',[A.samVH])).rows[0].status).toBe('active');
});

it('limits company administrators to requests and destinations they manage',async()=>{
  await pool.query(`insert into role_grants(person_id,role_key,company_id) values($1,'hr_admin',$2)`,[P.priya,C.VH]);
  await signup({company_id:C.WHM});const r=await registration();
  const admin=await as('priya');
  expect((await admin.get('/api/admin/registrations')).body).toEqual([]);
  expect((await admin.post(`/api/admin/registrations/${r.id}/decide`).send({decision:'approved',note:'Checked',company_id:C.VH})).status).toBe(403);
  await signup({email:'valor.staff@example.test'});
  const own=(await pool.query(`select id from staff_registrations where email='valor.staff@example.test'`)).rows[0];
  expect((await admin.post(`/api/admin/registrations/${own.id}/decide`).send({decision:'approved',note:'Checked',company_id:C.WHM})).status).toBe(403);
  expect((await admin.post(`/api/admin/appointments/${A.samVH}/reassign`).send({company_id:C.WHM,reason:'Attempted transfer'})).status).toBe(403);
});

it('serialises simultaneous approvals so one request cannot create two staff accounts',async()=>{
  await signup();const r=await registration();
  const admin=await as('alex');
  const results=await Promise.all([1,2].map(()=>admin.post(`/api/admin/registrations/${r.id}/decide`).send({decision:'approved',note:'Checked by administrator'})));
  expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  expect((await pool.query('select * from people where email=$1',[r.email])).rowCount).toBe(1);
});

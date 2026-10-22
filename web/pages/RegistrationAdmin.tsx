import { useState } from 'react';
import { post, useApi, useSubmit } from '../api.ts';
import { useHub } from '../hub.tsx';
import { Button, ErrorSummary, Field, JobRoleSelect, LoadError, PageHead, Skeleton } from '../ui.tsx';

export function RegistrationAdmin() {
  const requests=useApi<any[]>('/admin/registrations');
  return <><PageHead title="Staff & organisation requests" intro="Check each request and its organisation before approval. Staff receive ordinary staff access; additional roles and clearance are managed separately."/>
    {requests.loading && <Skeleton/>}{requests.error && <LoadError error={requests.error} retry={requests.reload}/>}
    {requests.data?.length===0 && <p>No registration requests.</p>}
    {requests.data && [...requests.data].sort((a,b)=>rank(a)-rank(b)).map(r=><RequestCard key={r.id} r={r} reload={requests.reload}/>)}
    <Reassignment/>
  </>;
}
// Pending requests first, then decided ones.
const rank=(r:any)=>r.status!=='pending'?1:0;
// Extra job roles for someone who does more than one job (e.g. support worker and housing officer). Each becomes its own role.
function ExtraRoles({main,value,onChange}:{main:string;value:string[];onChange:(v:string[])=>void}) {
  const roles=useApi<{key:string;label:string;access_label:string}[]>('/job-roles');
  return <details style={{margin:'8px 0 16px'}} open={value.length>0}><summary>Add more job roles{value.length?` (${value.length} added)`:''}</summary>
    <fieldset style={{border:0,padding:'8px 0 0'}}><legend className="sr-only">More job roles</legend>
      {roles.data?.filter(r=>r.key!==main).map(r=><label key={r.key} className="check"><input type="checkbox" checked={value.includes(r.key)} onChange={e=>onChange(e.target.checked?[...value,r.key]:value.filter(x=>x!==r.key))}/> {r.label} <span className="small muted">({r.access_label} access)</span></label>)}
    </fieldset></details>;
}
function RequestCard({r,reload}:{r:any;reload:()=>void}) {
  const hub=useHub();
  const [company,setCompany]=useState(r.company_id ?? ''),[name,setName]=useState(r.organisation_name ?? ''),[code,setCode]=useState(''),[note,setNote]=useState(''),[job,setJob]=useState(r.job_role_key ?? ''),[relationship,setRelationship]=useState('employee'),[also,setAlso]=useState<string[]>([]),[moreRoles,setMoreRoles]=useState<string[]>([]);
  const [delivery,setDelivery]=useState('');
  const decision=useSubmit(async (value:string)=>{
    const result=await post(`/admin/registrations/${r.id}/decide`,{decision:value,note:note.trim()||(value==='approved'?'Approved by an administrator':note),job_role_key:job||undefined,relationship,also_company_ids:also.filter(c=>c!==company),also_job_role_keys:moreRoles.filter(k=>k!==job),...(company==='new'?{new_organisation:{name,code}}:company?{company_id:company}:{})});
    setDelivery(result.email==='sent'?'Decision email sent.':'Decision saved. Email was not delivered; contact the applicant.');reload();
  });
  return <section className="card" style={{marginBottom:16}}><h2>{r.full_name}</h2><p>{r.email} · {r.company_name ?? `New organisation: ${r.organisation_name}`}</p>
    <p>{r.status!=='pending'?r.status:<strong>Waiting for your decision</strong>} · requested {new Date(r.created_at).toLocaleDateString('en-GB')}</p><ErrorSummary error={decision.error}/>
    {r.status==='pending'?<><Field label="Approve into organisation"><select value={company} onChange={e=>setCompany(e.target.value)}><option value="">Choose an organisation</option>{hub.me.companies.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}{hub.me.superAdmin && <option value="new">Create requested organisation</option>}</select></Field>
    {hub.me.companies.length>1 && <fieldset style={{border:0,padding:0}}><legend style={{fontWeight:600}}>Also add them to</legend><p className="small muted">For staff who work across organisations. They get the same job roles in each.</p>{hub.me.companies.filter(c=>c.id!==company).map(c=><label key={c.id} className="check"><input type="checkbox" checked={also.includes(c.id)} onChange={e=>setAlso(e.target.checked?[...also,c.id]:also.filter(x=>x!==c.id))}/> {c.name}</label>)}</fieldset>}
    {company==='new' && <><Field label="Organisation name"><input value={name} onChange={e=>setName(e.target.value)}/></Field><Field label="Unique organisation code" hint="2–6 uppercase letters"><input maxLength={6} value={code} onChange={e=>setCode(e.target.value.toUpperCase())}/></Field></>}
    <JobRoleSelect value={job} onChange={setJob} error={decision.error?.fields.job_role_key} showAccess hint={<>They asked for: {r.job_title}. The job role decides what they can see; manager roles see their team's work.</>}/>
    <ExtraRoles main={job} value={moreRoles} onChange={setMoreRoles}/>
    <Field label="Relationship"><select value={relationship} onChange={e=>setRelationship(e.target.value)}>{['employee','contractor','agency','secondment','volunteer','other'].map(v=><option key={v}>{v}</option>)}</select></Field>
    <Field label="Note" optional hint="Needed only if you reject the request."><textarea value={note} maxLength={500} onChange={e=>setNote(e.target.value)}/></Field>
    <p className="small muted">Their email address has not been checked, so make sure you know who they are before approving.</p>
    {(!company || !job) && <p className="notice">Choose the organisation and job role to approve them.</p>}
    <div className="row"><Button busy={decision.busy} disabled={!company || !job} onClick={()=>decision.run('approved')}>Approve staff account</Button><Button variant="secondary" disabled={decision.busy || note.trim().length<3} onClick={()=>decision.run('rejected')}>Reject request</Button></div></>:<p>{r.decision_note}</p>}
    {delivery && <p role="status">{delivery}</p>}
  </section>;
}
function Reassignment() {
  const hub=useHub();
  const staff=useApi<any[]>('/people');
  const [person,setPerson]=useState(''),[appointment,setAppointment]=useState(''),[company,setCompany]=useState(''),[reason,setReason]=useState(''),[transfer,setTransfer]=useState(''),[done,setDone]=useState(false);
  const selected=staff.data?.find(p=>p.id===person);
  const source=selected?.appointments?.find((a:any)=>a.appointment_id===appointment)?.company_id;
  const submit=useSubmit(async()=>{await post(`/admin/appointments/${appointment}/reassign`,{company_id:company,reason,...(transfer?{transfer_to:transfer}:{})});setDone(true);setAppointment('');await staff.reload();});
  return <section className="card"><h2>Reassign a staff organisation</h2><p>This ends the selected appointment and creates a new one today. Historical work stays in the old organisation. Old organisation roles are revoked when no other appointment there remains. Pay rates, clearance and property allocations must be reviewed for the new appointment. The legal employer is retained.</p>
    {staff.error && <LoadError error={staff.error} retry={staff.reload}/>}<ErrorSummary error={submit.error}/>{done && <p role="status">Organisation reassigned. The staff member must sign in again.</p>}
    <form onSubmit={e=>{e.preventDefault();setDone(false);submit.run();}}>
    <Field label="Staff member"><select required value={person} onChange={e=>{setPerson(e.target.value);setAppointment('');setTransfer('');}}><option value="">Choose staff</option>{staff.data?.filter(p=>p.id!==hub.me.person.id).map(p=><option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
    <Field label="Current appointment"><select required value={appointment} onChange={e=>{setAppointment(e.target.value);setTransfer('');}}><option value="">Choose appointment</option>{selected?.appointments?.filter((a:any)=>a.status==='active').map((a:any)=><option key={a.appointment_id} value={a.appointment_id}>{a.company_name} — {a.job_title}</option>)}</select></Field>
    <Field label="New organisation"><select required value={company} onChange={e=>setCompany(e.target.value)}><option value="">Choose organisation</option>{hub.me.companies.filter(c=>c.id!==source).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
    <Field label="Transfer outstanding tasks to" hint="Required if this is their last appointment in the old organisation and they have outstanding tasks."><select value={transfer} onChange={e=>setTransfer(e.target.value)}><option value="">No task transfer</option>{staff.data?.filter(p=>p.id!==person && p.appointments?.some((a:any)=>a.company_id===source && a.status==='active')).map(p=><option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
    <Field label="Reason"><textarea required minLength={3} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></Field><Button type="submit" busy={submit.busy}>Reassign organisation</Button>
    </form>
  </section>;
}

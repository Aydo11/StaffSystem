import { useState } from 'react';
import { post, useApi, useSubmit } from '../api.ts';
import { Button, ErrorSummary, Field, LoadError } from '../ui.tsx';
import { Frame } from './Login.tsx';

export function Registration() {
  const orgs=useApi<{id:string;name:string}[]>('/auth/organisations');
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[job,setJob]=useState('');
  const [company,setCompany]=useState(''),[organisation,setOrganisation]=useState(''),[sent,setSent]=useState(false);
  const submit=useSubmit(async()=>{
    await post('/auth/register',{email,password,full_name:name,job_title:job,...(company==='new'?{organisation_name:organisation}:{company_id:company})});
    setSent(true);
  });
  return <Frame><h1>{sent?'Request sent':'Join your organisation'}</h1>
    {!sent && <p>Ask for a staff account. An administrator checks your request, and you will get an email when you can sign in. A request for a new organisation also needs approval.</p>}
    {orgs.error && <LoadError error={orgs.error} retry={orgs.reload}/>}
    {sent && <div className="notice ok" role="status">Thanks, your request has been sent to an administrator. Once they approve it you can sign in with the email and password you chose. If you already have an account, use password reset instead.</div>}
    {!sent && <form onSubmit={e=>{e.preventDefault();submit.run();}}>
      <ErrorSummary error={submit.error}/>
      <Field label="Full name" error={submit.error?.fields.full_name}><input name="full_name" required minLength={2} maxLength={120} autoComplete="name" value={name} onChange={e=>setName(e.target.value)}/></Field>
      <Field label="Organisation" error={submit.error?.fields.company_id}><select name="company_id" required value={company} onChange={e=>setCompany(e.target.value)}><option value="">Choose your organisation</option>{orgs.data?.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}<option value="new">Request a new organisation</option></select></Field>
      {company==='new' && <Field label="Organisation name" error={submit.error?.fields.organisation_name}><input name="organisation_name" required minLength={2} maxLength={160} value={organisation} onChange={e=>setOrganisation(e.target.value)}/></Field>}
      <Field label="Job title" error={submit.error?.fields.job_title}><input name="job_title" required minLength={2} maxLength={120} value={job} onChange={e=>setJob(e.target.value)}/></Field>
      <Field label="Work email" error={submit.error?.fields.email}><input name="email" required type="email" maxLength={254} autoComplete="username" value={email} onChange={e=>setEmail(e.target.value)}/></Field>
      <Field label="Choose a password" error={submit.error?.fields.password} hint="At least 8 characters. Do not include your email address."><input name="password" required type="password" minLength={8} maxLength={200} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></Field>
      <Button type="submit" busy={submit.busy}>Send account request</Button>
    </form>}
    <p><a href="/">Back to sign in</a></p>
  </Frame>;
}

export function VerifyEmail() {
  const [token]=useState(()=>{const t=new URLSearchParams(location.hash.slice(1)).get('token');history.replaceState(null,'',location.pathname);return t;});
  const [done,setDone]=useState(false);
  const verify=useSubmit(async()=>{await post('/auth/verify-email',{token});setDone(true);});
  return <Frame><h1>Verify your email</h1><ErrorSummary error={verify.error}/>
    {done?<div className="notice ok" role="status">Email verified. Your request is awaiting administrator approval. We will email you when it has been reviewed.</div>:<><p>Confirm your email address to submit your request for administrator review.</p><Button disabled={!token} busy={verify.busy} onClick={()=>verify.run()}>Verify email address</Button>{!token && <p>This link is missing its verification token. Open the full link from your email.</p>}</>}
    <p><a href="/">Back to sign in</a></p>
  </Frame>;
}

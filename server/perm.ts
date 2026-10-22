import { type Db, pool, q } from './db.ts';
import { forbidden, LONDON_TODAY } from './http.ts';

export type Access = {
  personId: string;
  superAdmin: boolean;
  privileged: boolean;            // holds a role that requires MFA
  perms: Map<string, Set<string>>; // companyId → permission keys
  roles: Map<string, Set<string>>; // companyId → role keys (for display)
  agentIds: string[];             // managing agents this person may act for (agent portal only; no company membership)
};

// SQL for "this appointment is current". Used everywhere so the rule lives in one place.
export const ACTIVE_APPT = (a: string) => `${a}.status = 'active' and ${a}.start_date <= ${LONDON_TODAY} and (${a}.end_date is null or ${a}.end_date >= ${LONDON_TODAY})`;

export async function loadAccess(personId: string, db: Db = pool): Promise<Access> {
  // An active appointment grants the 'staff' role in that company, plus its job role's access level; explicit grants add more.
  const rows = await q<{ company_id: string | null; role_key: string; privileged: boolean; perm: string | null }>(
    `select a.company_id, r.key as role_key, r.privileged, rp.permission_key as perm
       from appointments a left join job_roles jr on jr.key = a.job_role_key
       join roles r on r.key in ('staff', coalesce(jr.access_role_key, 'staff'))
       left join role_permissions rp on rp.role_key = r.key
      where a.person_id = $1 and ${ACTIVE_APPT('a')}
     union all
     select g.company_id, g.role_key, r.privileged, rp.permission_key
       from role_grants g join roles r on r.key = g.role_key
       left join role_permissions rp on rp.role_key = g.role_key
      where g.person_id = $1 and g.revoked_at is null and g.valid_from <= now() and (g.expires_at is null or g.expires_at > now())`,
    [personId], db);
  const a: Access = { personId, superAdmin: false, privileged: false, perms: new Map(), roles: new Map(), agentIds: [] };
  const add = (c: string, role: string, perm: string | null) => {
    if (!a.perms.has(c)) { a.perms.set(c, new Set()); a.roles.set(c, new Set()); }
    a.roles.get(c)!.add(role);
    if (perm) a.perms.get(c)!.add(perm);
  };
  const superRows = rows.filter((r) => r.company_id === null);
  for (const r of rows) {
    if (r.privileged) a.privileged = true;
    if (r.company_id) add(r.company_id, r.role_key, r.perm);
  }
  if (superRows.length) {
    a.superAdmin = true;
    const companies = await q<{ id: string }>('select id from companies', [], db);
    for (const c of companies) for (const r of superRows) add(c.id, 'super_admin', r.perm);
  }
  a.agentIds = (await q<{ agent_id: string }>('select agent_id from agent_users where person_id = $1 and (expires_at is null or expires_at > now())', [personId], db)).map((r) => r.agent_id);
  return a;
}

export const can = (a: Access, perm: string, companyId: string | null | undefined) => !!companyId && !!a.perms.get(companyId)?.has(perm);
export const companiesWith = (a: Access, perm: string) => [...a.perms].filter(([, p]) => p.has(perm)).map(([c]) => c);
export const myCompanies = (a: Access) => [...a.perms.keys()];
export function need(a: Access, perm: string, companyId: string | null | undefined) {
  if (!can(a, perm, companyId)) throw forbidden();
}
// Narrow an optional ?company= filter to companies the person may use for this permission.
export function scope(a: Access, perm: string | null, company?: unknown): string[] {
  const all = perm ? companiesWith(a, perm) : myCompanies(a);
  return typeof company === 'string' && company ? all.filter((c) => c === company) : all;
}

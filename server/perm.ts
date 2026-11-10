import { type Db, pool, q } from './db.ts';
import { forbidden, LONDON_TODAY } from './http.ts';

export type Access = {
  personId: string;
  superAdmin: boolean;
  privileged: boolean;            // holds a role that requires MFA
  perms: Map<string, Set<string>>; // companyId → permission keys
  roles: Map<string, Set<string>>; // companyId → role keys (for display)
  agentIds: string[];             // managing agents this person may act for (agent portal only; no company membership)
  team: Map<string, Set<string>>;  // companyId → people assigned to this person to manage (staff_assignments)
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
  const a: Access = { personId, superAdmin: false, privileged: false, perms: new Map(), roles: new Map(), agentIds: [], team: new Map() };
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
  // Assigned staff count only in companies where the manager currently works (or holds a grant).
  for (const r of await q<{ company_id: string; person_id: string }>('select company_id, person_id from staff_assignments where manager_id = $1 and ended_at is null', [personId], db)) {
    if (!a.perms.has(r.company_id)) continue;
    if (!a.team.has(r.company_id)) a.team.set(r.company_id, new Set());
    a.team.get(r.company_id)!.add(r.person_id);
  }
  a.agentIds = (await q<{ agent_id: string }>('select agent_id from agent_users where person_id = $1 and (expires_at is null or expires_at > now())', [personId], db)).map((r) => r.agent_id);
  return a;
}

export const can = (a: Access, perm: string, companyId: string | null | undefined) => !!companyId && !!a.perms.get(companyId)?.has(perm);
// What managing an assigned person allows: the same oversight a manager has, for that person's work only.
export const TEAM_PERMS = new Set(['visits.view_all', 'visits.approve', 'timesheets.view_all', 'timesheets.approve', 'leave.approve', 'tasks.view_all']);
export const inTeam = (a: Access, companyId: string | null | undefined, personId: string | null | undefined) => !!companyId && !!personId && !!a.team.get(companyId)?.has(personId);
export const canFor = (a: Access, perm: string, companyId: string | null | undefined, personId: string | null | undefined) =>
  can(a, perm, companyId) || (TEAM_PERMS.has(perm) && inTeam(a, companyId, personId));
export function needFor(a: Access, perm: string, companyId: string | null | undefined, personId: string | null | undefined) {
  if (!canFor(a, perm, companyId, personId)) throw forbidden();
}
// SQL: the person in column `person` is assigned to $me in company `co`, and $me still works there.
export const TEAM_SQL = (me: number, co: string, person: string) =>
  `exists (select 1 from staff_assignments sa where sa.manager_id = $${me} and sa.company_id = ${co} and sa.person_id = ${person} and sa.ended_at is null
             and exists (select 1 from appointments ma where ma.person_id = sa.manager_id and ma.company_id = sa.company_id and ${ACTIVE_APPT('ma')}))`;
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

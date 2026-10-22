// Job roles come from a fixed list; each one carries an access level (a role in `roles`).
import { type Db, one } from './db.ts';
import { bad, forbidden } from './http.ts';
import { type Access, need } from './perm.ts';

export type JobRole = { key: string; label: string; access_role_key: string; privileged: boolean };

// Look up a job role and check the actor may hand out its access level in this company:
// basic staff roles need nothing extra; higher access needs access.manage; administrator-level access needs a super admin.
export async function jobRole(db: Db, a: Access, key: string, companyId: string): Promise<JobRole> {
  const jr = await one<JobRole>('select j.key, j.label, j.access_role_key, r.privileged from job_roles j join roles r on r.key = j.access_role_key where j.key = $1', [key], db);
  if (!jr) throw bad('Choose a job role from the list.', { fields: { job_role_key: 'Choose from the list' } });
  if (jr.access_role_key !== 'staff' && !a.superAdmin) {
    if (jr.privileged) throw forbidden(`Only a super administrator can give someone the ${jr.label} role, because it includes administrator access.`);
    need(a, 'access.manage', companyId);
  }
  return jr;
}

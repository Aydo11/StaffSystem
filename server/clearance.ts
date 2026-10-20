import { type Db, one, q } from './db.ts';
import { audit, HttpError } from './http.ts';
import { type Access, can } from './perm.ts';

const LABEL: Record<string, string> = { none: 'No clearance decision recorded', pending: 'Pending', not_authorised: 'Not Currently Authorised' };

// Deployment clearance gate, applied when allocating a property and when starting/logging a visit.
// Returns warnings to show; throws when the company's rule is "block" and no authorised exception is given.
export async function clearanceGate(db: Db, a: Access, personId: string, companyId: string, context: string, overrideReason?: string): Promise<string[]> {
  const cc = await one<{ status: string; restrictions: string | null }>('select status, restrictions from current_clearance where person_id = $1 and company_id = $2', [personId, companyId], db);
  const status = cc?.status ?? 'none';
  if (status === 'cleared') return [];
  if (status === 'cleared_with_restrictions') return [`Cleared with restrictions: ${cc!.restrictions}`];
  const company = (await one<{ clearance_rule: string; name: string }>('select clearance_rule, name from companies where id = $1', [companyId], db))!;
  const msg = `Deployment clearance for ${company.name}: ${LABEL[status]}.`;
  if (company.clearance_rule === 'warn') return [`${msg} This company is set to warn rather than block.`];
  if (overrideReason && can(a, 'clearance.override', companyId) && a.personId !== personId) {
    const ex = await one<{ id: string }>('insert into clearance_exceptions (person_id, company_id, context, reason, authorised_by) values ($1,$2,$3,$4,$5) returning id',
      [personId, companyId, context, overrideReason, a.personId], db);
    await audit(db, a.personId, companyId, 'clearance_exception', ex!.id, 'authorise', { person_id: personId, context });
    return [`${msg} Exception authorised and recorded.`];
  }
  throw new HttpError(409, 'clearance_required', `${msg} This must be resolved, or an exception authorised by someone with permission, before deployment.`,
    { canOverride: can(a, 'clearance.override', companyId) && a.personId !== personId });
}

export async function currentClearance(db: Db, personId: string, companyIds: string[]) {
  return q(`select cc.*, c.name as company_name, c.code as company_code, coalesce(d.preferred_name, d.full_name) as decided_by_name
              from current_clearance cc join companies c on c.id = cc.company_id left join people d on d.id = cc.decided_by
             where cc.person_id = $1 and cc.company_id = any($2::uuid[])`, [personId, companyIds], db);
}

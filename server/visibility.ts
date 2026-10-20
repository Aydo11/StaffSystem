// Row-visibility rules as SQL fragments. Each takes the positions of two params: $me (person id) and $cs (uuid[] of companies
// where the viewer holds the relevant "see everything" permission). Lists, detail pages, search and file downloads all use these.
import { ACTIVE_APPT } from './perm.ts';

export const personVisible = (alias: string, me: number, cs: number) =>
  `(${alias}.id = $${me} or exists (select 1 from appointments va where va.person_id = ${alias}.id and va.company_id = any($${cs}::uuid[])))`;

export const propertyVisible = (alias: string, me: number, cs: number) =>
  `(${alias}.company_id = any($${cs}::uuid[])
    or exists (select 1 from property_company_links vl where vl.property_id = ${alias}.id and vl.company_id = any($${cs}::uuid[]))
    or exists (select 1 from appointment_properties vap join appointments va on va.id = vap.appointment_id
                where vap.property_id = ${alias}.id and vap.to_date is null and va.person_id = $${me} and ${ACTIVE_APPT('va')}))`;

export const taskVisible = (alias: string, me: number, cs: number) =>
  `(${alias}.company_id = any($${cs}::uuid[]) or $${me} in (${alias}.owner_id, ${alias}.reviewer_id, ${alias}.created_by))`;

export const visitVisible = (alias: string, me: number, cs: number) =>
  `(${alias}.company_id = any($${cs}::uuid[]) or ${alias}.person_id = $${me})`;

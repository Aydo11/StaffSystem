// Read-only completeness audit. DATABASE_URL must point at the intended environment.
// Usage: npx tsx --env-file-if-exists=.env scripts/audit-records.ts [company-code]
import { pool } from '../server/db.ts';
import { missingFields, REVIEW_FIELDS, SUPERVISION_FIELDS } from '../server/record-completeness.ts';

const db = await pool.connect();
try {
  await db.query('begin isolation level repeatable read read only');
  const code = process.argv[2] ?? null;
  const companies = (await db.query('select id, code from companies where ($1::text is null or code = $1) order by code', [code])).rows;
  if (!companies.length) throw new Error('Company not found');
  const report: object[] = [];
  for (const company of companies) {
    const policies = (await db.query(`select p.id, p.status, p.file_id, jsonb_array_length(p.chapters) as chapters,
      p.effective_on, p.review_on, f.id is not null as file_present, b.storage_path is not null as blob_present,
      exists(select 1 from policy_publications pp where pp.policy_id=p.id and pp.company_id=$1) as published
      from policies p left join files f on f.id=p.file_id left join file_blobs b on b.storage_path=f.storage_path
      where p.company_id=$1 or p.id in (select policy_id from policy_publications where company_id=$1)`, [company.id])).rows;
    const reviews = (await db.query('select id, status, objectives, achievements, development, feedback from reviews where company_id=$1', [company.id])).rows;
    const supervisions = (await db.query('select id, status, agenda, shared_notes from supervisions where company_id=$1', [company.id])).rows;
    const incomplete = (rows: any[], fields: readonly string[]) => rows.flatMap(r => {
      const missing = missingFields(r, fields);
      return missing.length ? [{ id: r.id, status: r.status, missing }] : [];
    });
    report.push({ company: company.code,
      policies: { total: policies.length, awaiting_approval: policies.filter(p => p.status === 'draft').length,
        published: policies.filter(p => p.published).length,
        no_original_attachment: policies.filter(p => !p.file_id).map(p => p.id),
        empty_content: policies.filter(p => !p.chapters && !p.file_id).map(p => p.id),
        broken_attachments: policies.filter(p => p.file_id && (!p.file_present || !p.blob_present)).map(p => p.id),
        missing_dates: policies.filter(p => !p.effective_on || !p.review_on).map(p => p.id) },
      reviews: { total: reviews.length, incomplete: incomplete(reviews, REVIEW_FIELDS) },
      supervisions: { total: supervisions.length, incomplete: incomplete(supervisions, SUPERVISION_FIELDS) },
    });
  }
  console.log(JSON.stringify({ snapshot: new Date().toISOString(), companies: report }, null, 2));
  await db.query('rollback');
} finally {
  db.release();
  await pool.end();
}

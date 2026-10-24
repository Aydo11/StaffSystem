import { beforeEach, expect, it } from 'vitest';
import { importValorHistory } from '../scripts/import-valor-history.ts';
import { P, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);
const sheet = (name: string, records: Record<string, string>[]) => ({ name, rows: records.map((r, i) => ({ row: i + 5, cells: Object.entries(r).map(([col, value]) => ({ref: `${col}${i + 5}`, value})) })) });
const sheets = [
  sheet('Meetings', [{A:'TEST-MTG', B:'46237', C:'10:00', D:'60', F:'Team meeting', G:'Office', H:'Alex', K:'Review work', L:'Discussion recorded', M:'Approved'}]),
  sheet('Attendance', [{A:'TEST-MTG', D:'Alex', E:'Chair', F:'Present'}]),
  sheet('Decisions', [{A:'TEST-DEC', B:'TEST-MTG', C:'46237', E:'Agree next steps', F:'Alex', G:'Agreed'}, {A:'TEST-MISSING', B:'TEST-MTG', C:'46237', E:'Unmatched authoriser', F:'Unknown Person', G:'Agreed'}]),
  sheet('Actions', [{A:'TEST-ACT', B:'TEST-MTG', C:'46237', D:'Review records', E:'Alex', F:'46244', G:'Complete', H:'46241'}]),
  sheet('Maintenance', [{A:'TEST-JOB', B:'46237', C:'Unknown Property', F:'Repair', G:'Routine'}]),
];

it('previews without writing, imports once and preserves dates without inventing approvals or mappings', async () => {
  const preview = await importValorHistory(pool, sheets, P.alex);
  expect(preview.eligible.Meetings).toBe(1);
  expect((await pool.query("select count(*)::int n from meetings where title like '%TEST-MTG%'")).rows[0].n).toBe(0);
  await importValorHistory(pool, sheets, P.alex, true);
  await importValorHistory(pool, sheets, P.alex, true);
  const meetings = (await pool.query("select * from meetings where title like '%TEST-MTG%'")).rows;
  expect(meetings).toHaveLength(1);
  expect(meetings[0].held_on).toBe('2026-08-03');
  expect(meetings[0].minutes_status).toBe('draft');
  expect(meetings[0].minutes).toContain('Source minutes status: Approved');
  expect(meetings[0].attendance[0].person_id).toBe(P.alex);
  expect((await pool.query('select count(*)::int n from decisions where meeting_id=$1', [meetings[0].id])).rows[0].n).toBe(1);
  expect((await pool.query('select status from improvement_actions where source_id=$1', [meetings[0].id])).rows[0].status).toBe('evidence_submitted');
  expect(preview.unresolved.map(r => r.ref)).toEqual(['TEST-MISSING', 'TEST-JOB']);
});

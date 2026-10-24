import { beforeEach, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { C, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);

it('imports the supplied properties once, preserves existing addresses and keeps approval state', async () => {
  const existing = (await pool.query(
    "insert into properties (company_id, ref, name, address_line1, city, postcode, notes) values ($1, 'OWN-REF', 'Our existing property', '62 LANSDOWNE ROAD', 'Birmingham', 'B219AT', 'Keep our notes') returning id",
    [C.WHS],
  )).rows[0];
  const migration = readFileSync(new URL('../db/migrations/026_wellbeing_housing_properties.sql', import.meta.url), 'utf8');
  await pool.query(migration);
  const imported = (await pool.query("select * from properties where company_id = $1 and notes like 'Imported from properties_list_221026_1817.csv%'", [C.WHS])).rows;
  expect(imported).toHaveLength(7);
  expect(imported.find(p => p.ref === 'WHS-45-WHITMORE').status).toBe('awaiting_approval');
  expect(imported.filter(p => p.status === 'active')).toHaveLength(6);
  expect(imported.every(p => p.room_refs.length === 0 && p.notes.includes('have not been verified'))).toBe(true);
  expect((await pool.query('select notes, ref from properties where id = $1', [existing.id])).rows[0]).toEqual({notes: 'Keep our notes', ref: 'OWN-REF'});
  await pool.query(migration);
  expect((await pool.query("select count(*)::int n from properties where notes like 'Imported from properties_list_221026_1817.csv%'")).rows[0].n).toBe(7);
});

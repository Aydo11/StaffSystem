// Removing a property: deleted when it has no history, offboarded (history kept) when it has.
import { beforeEach, describe, expect, it } from 'vitest';
import { as, C, pool, resetDb } from './helpers.ts';

beforeEach(resetDb);

describe('removing a property', () => {
  it('deletes an unused property, offboards one with history, and refuses staff', async () => {
    const alex = await as('alex'), sam = await as('sam');
    const fresh = (await alex.post('/api/properties').send({ company_id: C.VH, ref: 'VH-DUP-1', name: 'Duplicate (fictional)', address_line1: '1 Test Street', city: 'Birmingham', postcode: 'B1 1AA' })).body;
    expect((await sam.del(`/api/properties/${fresh.id}`)).status).toBeGreaterThanOrEqual(403);
    const r = await alex.del(`/api/properties/${fresh.id}`);
    expect(r.body).toEqual({ removed: 'deleted' });
    expect((await pool.query('select count(*)::int n from properties where id = $1', [fresh.id])).rows[0].n).toBe(0);
    const used = (await pool.query(`select property_id id from visits where company_id = $1 limit 1`, [C.VH])).rows[0].id;
    const r2 = await alex.del(`/api/properties/${used}`);
    expect(r2.body).toEqual({ removed: 'offboarded' });
    expect((await pool.query('select status from properties where id = $1', [used])).rows[0].status).toBe('offboarded');
    expect((await pool.query(`select count(*)::int n from appointment_properties where property_id = $1 and (to_date is null or to_date > current_date)`, [used])).rows[0].n).toBe(0);
    expect((await pool.query('select count(*)::int n from visits where property_id = $1', [used])).rows[0].n).toBeGreaterThan(0);
  });
});

// First-time setup on a new database: creates the three companies (names only, details unverified) and a super admin,
// then prints a one-time link (valid 7 days) for that person to choose a password.
// Usage (Render Shell or locally): npm run create-admin -- you@example.org "Your Full Name"
import { one, pool, q, tx } from '../server/db.ts';
import { issueAccessLink } from '../server/routes/account.ts';

const [email, fullName] = process.argv.slice(2);
if (!/^\S+@\S+\.\S+$/.test(email ?? '') || !fullName || fullName.trim().length < 2) {
  console.error('Usage: npm run create-admin -- you@example.org "Your Full Name"');
  process.exit(1);
}

const link = await tx(async (db) => {
  // Company numbers and addresses are left empty: enter and verify them in Admin Centre → Companies.
  await q(`insert into companies (code, name, legal_name) values ('VH','Valor Housing','Valor Housing Ltd'), ('WHM','Wellbeing Homes','Wellbeing Homes Ltd'), ('WHS','Wellbeing Housing','Wellbeing Housing Ltd')
           on conflict do nothing`, [], db);
  let p = await one<{ id: string; password_hash: string | null }>('select id, password_hash from people where lower(email) = lower($1)', [email], db);
  if (!p) {
    const ref = (await one<{ ref: string }>(`select 'VWH-' || lpad((coalesce(max(substring(staff_ref from 5)::int), 0) + 1)::text, 4, '0') as ref from people where staff_ref ~ '^VWH-\\d+$'`, [], db))!.ref;
    p = await one('insert into people (email, full_name, staff_ref, status) values ($1,$2,$3,$4) returning id, password_hash', [email, fullName.trim(), ref, 'invited'], db);
  }
  if (!(await one(`select 1 from role_grants where person_id = $1 and role_key = 'super_admin' and revoked_at is null`, [p!.id], db)))
    await q(`insert into role_grants (person_id, role_key, company_id, reason) values ($1, 'super_admin', null, 'First administrator (create-admin script)')`, [p!.id], db);
  return issueAccessLink(db, p!.id, p!.password_hash ? 'reset' : 'invite');
});

console.log(`\nSuper admin ready: ${email}\nOpen this link to choose a password (it works once; 7 days for a new account, 1 hour for an existing one):\n\n${process.env.APP_URL ?? 'http://localhost:5173'}${link}\n`);
console.log('After choosing a password you will be asked to set up an authenticator app (required for administrators).');
await pool.end();

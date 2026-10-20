# Administrator guide

This guide covers setting up, deploying and running the Hub. Items marked **Needs professional review** are decisions the software cannot make for you.

## 1. Environments

Keep three separate environments. Never share a database or Supabase project between them.

| Environment | Database | Sign-in | Data |
| --- | --- | --- | --- |
| Development | Local Postgres (`npm run db:local`) | Demo sign-in (`DEV_AUTH=true`) | Fictional seed only |
| Staging | Its own Supabase project | Supabase | Fictional or anonymised only |
| Production | Its own Supabase project | Supabase, invitation only | Real |

## 2. Supabase (staging and production)

1. Create a project in the **London (eu-west-2)** region.
2. **Authentication → Providers → Email**: enabled. Turn **off** "Allow new users to sign up" (invitation only).
3. **Authentication → Multi-Factor**: enable **TOTP**. Privileged roles (super administrator, company administrator, HR administrator, finance administrator) cannot use the Hub until they complete two-step verification.
4. **Authentication → URL configuration**: Site URL = your Hub address; add `https://<your-hub>/reset-password` to redirect URLs.
5. **Authentication → Email templates**: set the invite and reset emails to send people to `https://<your-hub>/reset-password`, where they choose a password.
6. **Settings → API**: copy the URL, the anon key and the service-role key. The service-role key is a secret: it goes only into Render's environment, never into the browser or the repository.
7. **Settings → Database**: copy the session-pooler connection string for `DATABASE_URL`. Under **SSL Configuration**, download the certificate and paste its contents into `DATABASE_CA` on Render. Production refuses to connect without it, so the server always verifies it is talking to your database.
8. Run migrations (Render does this automatically before each deploy). Migration 001 creates the private storage bucket `hub-private` with no storage policies, so only the server can read or write files.

## 3. Render

1. Push this folder to a **private** GitHub repository.
2. In Render: **New → Blueprint**, choose the repository. It reads `render.yaml`.
3. Fill in the secret environment variables (`DATABASE_URL`, `DATABASE_CA`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `HELP_CONTACT`).
4. Deploy. Render runs `npm run migrate` before starting the new version and checks `/health`.
5. Add your domain under **Settings → Custom domains**. Render provides HTTPS, which the PWA needs.

The server refuses to start in production if demo sign-in is switched on or Supabase is not configured. The seed script refuses to load fictional data in production.

## 4. The first administrator

There is no public administrator registration.

1. In Supabase **Authentication → Users → Invite user**, invite the first administrator's work email.
2. In the Supabase SQL editor, create their profile, an appointment and the super-administrator grant (replace the values):

```sql
insert into people (email, full_name, staff_ref, status) values ('name@yourorg.example', 'Full Name', 'VWH-0001', 'invited') returning id;
insert into appointments (person_id, company_id, relationship, legal_employer_company_id, job_title, start_date)
  select p.id, c.id, 'employee', c.id, 'Platform Administrator', current_date from people p, companies c where p.email = 'name@yourorg.example' and c.code = 'VH';
insert into role_grants (person_id, role_key, company_id, reason)
  select id, 'super_admin', null, 'First administrator' from people where email = 'name@yourorg.example';
```

3. They accept the invitation, choose a password, then set up two-step verification at first sign-in.
4. In production the three companies must exist first. Insert them once with their verified legal names only (`code`, `name`, `legal_name`); add company numbers and addresses in **Admin Centre → Companies** after checking them against Companies House.

Everyone else is invited from **People → Invite a person**, which creates the profile, the first appointment and sends the Supabase invitation.

## 5. Day-to-day administration

- **Permissions** (Admin Centre): grant roles per company. Use an end date for temporary delegation. Time-limited reviewers must have one. Review the list regularly; tick "Show revoked and expired" for history.
- **Ending an appointment** (person → Appointments): ends that appointment only, ends its property allocations, transfers open tasks, and removes that company's roles if no other appointment there remains. When it was the person's last appointment, their sign-in ends. Keys still held are listed so they can be recovered.
- **Clearance rule** (Admin Centre → Companies): "block" stops allocation and visits without clearance (an authorised exception can be recorded); "warn" allows them with a warning.
- **Audit** (Admin Centre → Audit): changes, approvals, exceptions, file downloads and views of restricted HR information.

## 6. Backups and recovery

- Supabase Pro includes daily backups; enable **Point-in-Time Recovery** for production.
- **Test a restore at least quarterly**: restore into a scratch Supabase project, point a staging Render service at it, sign in and check recent records. Record the date and result. Recovery times are not guaranteed until you have tested them.
- Storage files are backed up separately from the database; check Supabase's current storage backup terms.

## 7. Privacy and compliance — needs professional review

The software supports accountable practice. It does not make you compliant by itself.

- **Data protection impact assessment** for the Hub, including attendance and lone-worker features. Location checks are not built; if added later, they need their own assessment.
- **Processor agreements** with Supabase and Render (data processing addenda), and a record of where data is stored (UK/EU regions).
- **Retention schedule** for HR records, employment checks, visits, timesheets and audit logs. Retention and deletion tooling is not built yet (see tracker).
- **Employment checks**: the Hub stores dates, statuses and references only — never criminal-record details or certificate images. Confirm this matches your DBS code of practice obligations.
- **Lone working**: overdue check-ins appear in the named contact's review list. This is not a monitored emergency service; your lone-working policy must say who checks, how often, and when to call 999.
- **Malware scanning** of uploads is not integrated. Uploads are restricted by content type (JPEG, PNG, WebP, PDF) and size (10 MB).

## 8. Monitoring

- `/health` reports database reachability; Render uses it to restart unhealthy instances.
- Errors are logged as JSON lines without request bodies. Add a log drain in Render if you need retention or alerting.

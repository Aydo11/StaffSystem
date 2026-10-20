# Administrator guide

This guide covers setting up, deploying and running the Hub. Items marked **Needs professional review** are decisions the software cannot make for you.

## 1. Environments

Keep separate environments. Never share a database between them.

| Environment | Database | Sign-in | Data |
| --- | --- | --- | --- |
| Development | Local Postgres (`npm run db:local`) | Demo sign-in (`DEV_AUTH=true`) | Fictional seed only |
| Staging (optional) | Its own Render Postgres | Hub sign-in | Fictional or anonymised only |
| Production | Render Postgres `staffcrm-db` (Frankfurt) | Hub sign-in, invitation only | Real |

Everything lives in Render: the web service and one Postgres database holding the data, sign-in records and uploaded files. There is no other provider to set up. Email (Resend) and the AI assistant (Anthropic) are optional.

## 2. How sign-in works

- **Invitation only.** An administrator creates a person (People → Invite a person). The Hub makes a one-time link valid for 7 days. With email set up (`RESEND_API_KEY` and `EMAIL_FROM`), it is emailed; without it, the administrator sees the link and passes it on privately.
- **Passwords**: at least 12 characters, stored as scrypt hashes. Ten wrong attempts pause that account's sign-in for 15 minutes.
- **Two-step verification** with an authenticator app (Microsoft Authenticator, Google Authenticator and similar) is required for privileged roles (super administrator, company administrator, HR administrator, finance administrator). They set it up at first sign-in and enter a code at every sign-in.
- **Forgotten password**: with email set up, "Forgot your password?" sends a 1-hour link. Without email, an administrator opens the person's profile and uses **Send new sign-in link**. Only a super administrator can do this for someone with a privileged role, or reset a lost authenticator.
- **Sessions** last up to 14 days and end after 3 days unused. Changing or resetting a password signs out other devices. Only hashes of session tokens and links are stored.

## 3. Render

1. Push this folder to a **private** GitHub repository.
2. Either **New → Blueprint** with this repository (it reads `render.yaml` and creates the web service and the database together), or set up by hand:
   - Create **Postgres** (Frankfurt, Basic 256 MB or larger, no external access).
   - Create a **Web Service** from the repository. Build command `npm ci --include=dev && npm run build`, pre-deploy command `npm run migrate`, start command `npm start`, health check path `/health`.
   - In the web service's **Environment**, set `DATABASE_URL` to the database's **Internal Database URL** (database page → Connect → Internal). Set `NODE_ENV=production`, `APP_URL` (the Hub's address) and `HELP_CONTACT`.
3. Deploy. Render runs `npm run migrate` before starting each new version and checks `/health`.
4. Add your domain under **Settings → Custom domains**. Render provides HTTPS, which the PWA needs. Update `APP_URL` to match.

The server refuses to start in production if demo sign-in is switched on. The seed script refuses to load fictional data in production. The internal database address only works inside Render; a database reached over the internet is always connected with verified TLS (`DATABASE_CA` if its certificate is not publicly trusted).

## 4. The first administrator

There is no public registration. On a new database, open the web service's **Shell** tab in Render and run:

```
npm run create-admin -- name@yourorg.example "Full Name"
```

This creates the three companies (Valor Housing Ltd, Wellbeing Homes Ltd, Wellbeing Housing Ltd; names only, marked unverified), the person, and a super-administrator grant, and prints a one-time link. Open it, choose a password, then set up two-step verification. Add company numbers and addresses in **Admin Centre → Companies** after checking them against Companies House. Running the command again for the same email prints a fresh link.

Everyone else is invited from **People → Invite a person**, which creates the profile and the first appointment and gives the invitation link.

## 5. Day-to-day administration

- **Permissions** (Admin Centre): grant roles per company. Use an end date for temporary delegation. Time-limited reviewers must have one. Review the list regularly; tick "Show revoked and expired" for history.
- **Ending an appointment** (person → Appointments): ends that appointment only, ends its property allocations, transfers open tasks, and removes that company's roles if no other appointment there remains. When it was the person's last appointment, their sign-in ends. Keys still held are listed so they can be recovered.
- **Clearance rule** (Admin Centre → Companies): "block" stops allocation and visits without clearance (an authorised exception can be recorded); "warn" allows them with a warning.
- **Audit** (Admin Centre → Audit): changes, approvals, exceptions, file downloads and views of restricted HR information.

## 6. Backups and recovery

- Render's paid Postgres plans take daily backups with point-in-time recovery (check the retention period for your plan on the database's **Recovery** tab). Uploaded files are stored in the database, so they are included.
- **Test a restore at least quarterly**: restore to a new database from the Recovery tab, point a staging web service at it, sign in and check recent records. Record the date and result. Recovery times are not guaranteed until you have tested them.

## 7. Privacy and compliance — needs professional review

The software supports accountable practice. It does not make you compliant by itself.

- **Data protection impact assessment** for the Hub, including attendance and lone-worker features. Location checks are not built; if added later, they need their own assessment.
- **Processor agreements** with Render, and with Resend and Anthropic if you switch them on (data processing addenda), and a record of where data is stored (UK/EU regions).
- **Retention schedule** for HR records, employment checks, visits, timesheets and audit logs. Admin Centre → Retention lists what is past your period; super administrators can anonymise leavers.
- **Employment checks**: the Hub stores dates, statuses and references only — never criminal-record details or certificate images. Confirm this matches your DBS code of practice obligations.
- **Lone working**: overdue check-ins appear in the named contact's review list. This is not a monitored emergency service; your lone-working policy must say who checks, how often, and when to call 999.
- **Malware scanning** of uploads is not integrated. Uploads are restricted by content type (JPEG, PNG, WebP, PDF) and size (10 MB).

## 8. Monitoring

- `/health` reports database reachability; Render uses it to restart unhealthy instances.
- Errors are logged as JSON lines without request bodies. Add a log drain in Render if you need retention or alerting.

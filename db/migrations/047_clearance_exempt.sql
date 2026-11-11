-- Directors and administrators do not need deployment clearance (owner request, 11 Nov 2026).
-- Exempt in a company: a current role there whose job role is Director, or a current super-admin or company-admin grant.
-- No clearance decisions are created or changed; the exemption is worked out each time.
create or replace function clearance_exempt(p uuid, c uuid) returns boolean language sql stable as $$
  select exists (select 1 from appointments a where a.person_id = p and a.company_id = c and a.job_role_key = 'director' and a.status = 'active'
                   and a.start_date <= (now() at time zone 'Europe/London')::date
                   and (a.end_date is null or a.end_date >= (now() at time zone 'Europe/London')::date))
      or exists (select 1 from role_grants g where g.person_id = p and g.revoked_at is null and g.valid_from <= now() and (g.expires_at is null or g.expires_at > now())
                   and (g.role_key = 'super_admin' or (g.role_key = 'company_admin' and g.company_id = c)))
$$;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.clearance_exempt(uuid, uuid) from anon, authenticated, public';
  end if;
end $$;

-- Finance by calendar month (3 Nov 2026, owner request).
-- 1. Plans can be monthly. Valor Housing's 4-week plan is converted to months April–March: each 4-week amount is
--    shared over its days, so a month gets the days that fall in it. Yearly totals are unchanged (to the penny per line,
--    within rounding).
-- 2. Monthly figures: actual totals typed in by month and category. A typed figure replaces what the records
--    (invoices, bills, bank items) give for that month and category, so nothing is counted twice.
alter table finance_plans add column period_kind text not null default 'days' check (period_kind in ('days','month'));

create function plan_to_months(pid uuid) returns void language plpgsql as $$
declare pl finance_plans; m0 date; last_day date; nm int;
begin
  select * into pl from finance_plans where id = pid;
  if pl is null or pl.period_kind = 'month' then return; end if;
  m0 := date_trunc('month', pl.start_date)::date;
  last_day := pl.start_date + pl.periods * pl.period_days - 1;
  nm := ((extract(year from last_day) - extract(year from m0)) * 12 + extract(month from last_day) - extract(month from m0))::int + 1;
  with old as (delete from finance_plan_lines where plan_id = pid returning *)
  insert into finance_plan_lines (plan_id, period_no, direction, category, department, property_id, counterparty, label, amount)
  select pid, m.k, o.direction, o.category, o.department, o.property_id, o.counterparty, o.label,
         round(sum(o.amount * ((least(pr.pe, m.me) - greatest(pr.ps, m.ms) + 1)::numeric / pl.period_days)), 2)
    from old o
   cross join lateral (select pl.start_date + (o.period_no - 1) * pl.period_days as ps, pl.start_date + o.period_no * pl.period_days - 1 as pe) pr
   cross join lateral (select k, (m0 + make_interval(months => k - 1))::date as ms, (m0 + make_interval(months => k) - interval '1 day')::date as me
                         from generate_series(1, nm) k) m
   where greatest(pr.ps, m.ms) <= least(pr.pe, m.me)
   group by m.k, o.direction, o.category, o.department, o.property_id, o.counterparty, o.label;
  update finance_plans set period_kind = 'month', periods = nm, start_date = m0, period_days = 31,
         source_note = coalesce(source_note, '') || ' Converted from 4-week periods to calendar months on ' || to_char(now(), 'DD Mon YYYY') || ' (owner request).'
   where id = pid;
end $$;

select plan_to_months(id) from finance_plans where period_kind = 'days';

-- New installs and tests: loading the Valor plan now also converts it to months.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'load_valor_plan') then alter function load_valor_plan() rename to load_valor_plan_4w; end if;
end $$;
create function load_valor_plan() returns void language plpgsql as $$
begin
  perform load_valor_plan_4w();
  perform plan_to_months(p.id) from finance_plans p join companies c on c.id = p.company_id where c.code = 'VH' and p.period_kind = 'days';
end $$;

create table finance_monthly_figures (
  company_id uuid not null references companies,
  month date not null check (extract(day from month) = 1),
  category text not null,
  amount numeric(12,2) not null check (amount >= 0),
  updated_by uuid references people,
  updated_at timestamptz not null default now(),
  primary key (company_id, month, category)
);

alter table finance_monthly_figures enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;

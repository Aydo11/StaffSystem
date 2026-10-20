-- Stage 7a: finance documents (invoices, contractor invoices, payment statements, expense claims, credit notes),
-- payments, queries, budgets, cash flow and scenarios, continuity plans.

insert into permissions (key, description) values
  ('finance.view',      'See the company''s finance documents, budgets and cash flow'),
  ('finance.manage',    'Draft finance documents, record payments, manage budgets and cash flow'),
  ('finance.approve',   'Approve and issue finance documents (never your own)'),
  ('expenses.approve',  'Approve expense claims (never your own)'),
  ('continuity.manage', 'Write continuity plans and record recovery exercises')
on conflict do nothing;
insert into role_permissions (role_key, permission_key)
select r, p from (values
  ('super_admin','finance.view'),('super_admin','finance.manage'),('super_admin','finance.approve'),('super_admin','expenses.approve'),('super_admin','continuity.manage'),
  ('company_admin','finance.view'),('company_admin','finance.manage'),('company_admin','finance.approve'),('company_admin','expenses.approve'),('company_admin','continuity.manage'),
  ('finance_admin','finance.view'),('finance_admin','finance.manage'),('finance_admin','finance.approve'),('finance_admin','expenses.approve'),
  ('manager','expenses.approve'),
  ('quality_lead','continuity.manage'),('quality_lead','finance.view')
) v(r, p) on conflict do nothing;

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news'));

-- Each company's own numbering, payment instructions and tax position. Nothing is assumed: VAT is off until configured.
create table company_finance_settings (
  company_id uuid primary key references companies,
  invoice_prefix text not null default 'INV',
  next_invoice_number int not null default 1,
  credit_prefix text not null default 'CN',
  next_credit_number int not null default 1,
  statement_prefix text not null default 'PS',
  next_statement_number int not null default 1,
  payment_instructions text,                 -- entered and verified by finance; never invented
  payment_terms_days int not null default 30 check (payment_terms_days between 0 and 365),
  vat_registered boolean not null default false,
  vat_number text,
  self_billing_enabled boolean not null default false,
  self_billing_agreement_ref text,
  check (not vat_registered or vat_number is not null),
  check (not self_billing_enabled or self_billing_agreement_ref is not null)
);
insert into company_finance_settings (company_id) select id from companies on conflict do nothing;
-- Companies added later (including the real companies in production) get their settings row automatically.
create function add_finance_settings() returns trigger language plpgsql as $$
begin
  insert into company_finance_settings (company_id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger companies_finance_settings after insert on companies for each row execute function add_finance_settings();

create table finance_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  kind text not null check (kind in ('sales_invoice','contractor_invoice','payment_statement','expense_claim','credit_note')),
  direction text not null check (direction in ('receivable','payable')),   -- money coming in to the company, or going out
  number text,                                    -- assigned on issue from the company's own series
  issuer_name text not null,
  recipient_name text not null,
  recipient_person_id uuid references people,     -- staff/contractor who can view it in the Hub
  recipient_email text,
  recipient_address text,
  submitted_by uuid references people,            -- contractor invoices and expense claims
  issue_date date,
  due_date date,
  period_start date,
  period_end date,
  reference text,
  property_id uuid references properties,
  tax_treatment text not null default 'no_vat' check (tax_treatment in ('no_vat','outside_scope','exempt','zero_rated','standard_20','reduced_5')),
  subtotal numeric(12,2) not null default 0,
  tax_total numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  terms text,
  notes text,
  status text not null default 'draft' check (status in ('draft','submitted','awaiting_approval','approved','issued','part_paid','paid','rejected','credited','void')),
  credits_document_id uuid references finance_documents,
  source_timesheet_id uuid references timesheets,
  self_billing boolean not null default false,
  approved_by uuid references people,
  approved_at timestamptz,
  issued_at timestamptz,
  created_by uuid not null references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, number),
  check (kind <> 'credit_note' or credits_document_id is not null),
  check (approved_by is null or approved_by <> created_by),
  check (approved_by is null or submitted_by is null or approved_by <> submitted_by)
);
-- The same approved timesheet can never be paid or billed twice.
create unique index one_document_per_timesheet on finance_documents (source_timesheet_id) where source_timesheet_id is not null and status not in ('rejected','void');
create index finance_documents_company on finance_documents (company_id, status);

create table finance_lines (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references finance_documents on delete cascade,
  position int not null,
  description text not null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit text not null default 'item',
  rate numeric(12,2) not null check (rate >= 0),
  tax_rate numeric(5,2) not null default 0 check (tax_rate in (0, 5, 20)),
  amount numeric(12,2) not null           -- quantity × rate, rounded half-up to pence in SQL
);
create table finance_payments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references finance_documents,
  amount numeric(12,2) not null check (amount > 0),
  paid_on date not null,
  method text not null check (method in ('bank_transfer','card','cash','cheque','other')),
  reference text,
  manual boolean not null default true,  -- recorded by a person, not reconciled with a bank feed
  recorded_by uuid not null references people,
  created_at timestamptz not null default now()
);
create table finance_queries (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references finance_documents,
  raised_by uuid not null references people,
  body text not null,
  answer text,
  answered_by uuid references people,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

-- ───────────── Budgets, cash flow and scenarios ─────────────
create table budgets (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  month date not null check (extract(day from month) = 1),
  category text not null check (category in ('staffing','cover','training','premises','other')),
  amount numeric(12,2) not null check (amount >= 0),
  actual numeric(12,2),                   -- entered from the accounts; staffing estimate is shown alongside from timesheets
  note text,
  unique (company_id, month, category)
);
create table cashflow_lines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  month date not null check (extract(day from month) = 1),
  kind text not null check (kind in ('income','expense')),
  label text not null,
  forecast numeric(12,2) not null,
  actual numeric(12,2),
  note text
);
create table cashflow_settings (company_id uuid primary key references companies, opening_balance numeric(12,2) not null default 0, opening_month date not null check (extract(day from opening_month) = 1));
create table finance_scenarios (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null,
  kind text not null check (kind in ('delayed_income','cover_costs','unexpected_expenditure','supplier_increase','other')),
  assumptions text not null,
  adjustments jsonb not null default '[]',   -- [{month, label, amount}] (+ income / − cost) or [{percent_on_expenses}]
  supplier_increase_percent numeric(5,2),
  response text,                             -- what management would do
  created_by uuid references people,
  created_at timestamptz not null default now()
);

-- ───────────── Continuity ─────────────
create table continuity_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  scenario text not null check (scenario in ('staff_shortage','it_failure','office_loss','emergency','supplier_failure','other')),
  title text not null,
  plan text not null,
  deputies uuid[] not null default '{}',
  fallback text,
  next_test_on date,
  updated_by uuid references people,
  updated_at timestamptz not null default now()
);
create table continuity_exercises (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references continuity_plans,
  held_on date not null,
  participants text,
  what_happened text not null,
  outcome text not null check (outcome in ('worked','partly_worked','did_not_work')),
  lessons text,
  recorded_by uuid not null references people,
  created_at timestamptz not null default now()
);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;

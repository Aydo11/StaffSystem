-- Finance hub (2 Nov 2026, owner request): bank and cash accounts with transactions (the only source of cash figures),
-- recurring and scheduled commitments (payroll, tax, loans, bills), the plan/budget by 4-week period, forecast settings
-- with three scenarios, and saved views. Plan figures are a forecast and are never shown as actual results.

-- Categories, departments and properties on documents so invoices and bills feed budget v actual.
alter table finance_documents add column category text, add column department text;

-- Bank, cash, card and loan accounts. Balance = opening balance + every transaction dated on or after the opening date.
create table finance_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null check (length(name) between 2 and 120),
  kind text not null check (kind in ('bank','savings','cash','card','loan')),
  currency text not null default 'GBP' check (currency ~ '^[A-Z]{3}$'),
  opening_balance numeric(12,2) not null default 0,
  opening_fx_rate numeric(12,6) not null default 1 check (opening_fx_rate > 0),  -- to GBP; 1 for GBP accounts
  opening_date date not null,
  last_four text check (last_four ~ '^\d{4}$'),   -- for recognising the account; never the full number
  archived boolean not null default false,
  created_by uuid references people,
  created_at timestamptz not null default now()
);

-- Every real movement of money. amount is signed in the account's currency (+ in, − out); amount_gbp uses the rate
-- recorded on the day. A transfer is two rows sharing transfer_id and is never counted as income or spending.
create table finance_transactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  account_id uuid not null references finance_accounts,
  txn_date date not null,
  amount numeric(12,2) not null check (amount <> 0),
  fx_rate numeric(12,6) not null default 1 check (fx_rate > 0),
  amount_gbp numeric(12,2) generated always as (round(amount * fx_rate, 2)) stored,
  description text not null check (length(description) between 1 and 300),
  counterparty text check (length(counterparty) <= 200),
  category text,                                  -- null = not categorised yet
  department text,
  property_id uuid references properties,
  document_id uuid references finance_documents,  -- the invoice or bill this settles (a refund keeps its original's category)
  counterparty_company_id uuid references companies, -- another group company: left out of combined totals
  transfer_id uuid,
  reconciled boolean not null default false,
  reconciled_at timestamptz,
  reconciled_by uuid references people,
  source text not null default 'manual' check (source in ('manual','import','payment')),
  import_hash text,
  note text check (length(note) <= 1000),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, import_hash)
);
create index finance_transactions_company on finance_transactions (company_id, txn_date);
alter table finance_payments add column transaction_id uuid references finance_transactions;

-- Recurring and scheduled money: payroll, tax, loans, rent, bills, subscriptions and expected income.
-- certainty: committed (contracted or agreed) or estimate (expected but not agreed).
create table finance_commitments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  kind text not null check (kind in ('payroll','tax','loan','rent','supplier','subscription','insurance','income','other')),
  label text not null check (length(label) between 2 and 200),
  direction text not null check (direction in ('in','out')),
  amount numeric(12,2) not null check (amount > 0),
  frequency text not null check (frequency in ('once','weekly','four_weekly','monthly','quarterly','annually')),
  next_date date not null,
  end_date date,
  certainty text not null default 'committed' check (certainty in ('committed','estimate')),
  category text not null,
  department text,
  account_id uuid references finance_accounts,
  counterparty text,
  loan_balance numeric(12,2),        -- loans: amount still owed
  interest_rate numeric(6,3),        -- loans: yearly %, used to split interest from repayment
  active boolean not null default true,
  note text check (length(note) <= 1000),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The plan (budget) by 4-week period. Lines are amounts per period: + income, + expense (direction says which).
create table finance_plans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  name text not null,
  start_date date not null,
  period_days int not null default 28 check (period_days between 7 and 31),
  periods int not null default 13 check (periods between 1 and 53),
  source_note text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index one_active_plan on finance_plans (company_id) where active;
create table finance_plan_lines (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references finance_plans on delete cascade,
  period_no int not null check (period_no >= 1),
  direction text not null check (direction in ('income','expense')),
  category text not null,
  department text,
  property_id uuid references properties,
  counterparty text,
  label text not null,
  amount numeric(12,2) not null
);
create index finance_plan_lines_plan on finance_plan_lines (plan_id, period_no);

-- Forecast settings: minimum cash and the three scenarios' editable assumptions.
create table finance_hub_settings (
  company_id uuid primary key references companies,
  min_cash numeric(12,2) not null default 0 check (min_cash >= 0),
  scenarios jsonb not null default '{
    "base":        {"collect_delay_days": 0,  "pay_delay_days": 0, "revenue_pct": 0,  "cost_pct": 0,  "one_offs": []},
    "optimistic":  {"collect_delay_days": 0,  "pay_delay_days": 0, "revenue_pct": 2,  "cost_pct": -2, "one_offs": []},
    "pessimistic": {"collect_delay_days": 14, "pay_delay_days": 0, "revenue_pct": -5, "cost_pct": 3,  "one_offs": []}}',
  updated_by uuid references people,
  updated_at timestamptz not null default now()
);
create table finance_saved_views (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people on delete cascade,
  name text not null check (length(name) between 1 and 80),
  filters jsonb not null,
  created_at timestamptz not null default now()
);

alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint','finance_txn'));

-- Valor Housing's plan: "2.4 Cash Flow and P&L, 88% occupancy, rebalanced" (model dated 9 Sep 2026), 13 four-week
-- periods from 1 April 2026 (owner decision, 2 Nov 2026). Per-period figures copied from the workbook; per-line pennies
-- rounded so the period totals equal the model: income £135,919.42, payments £127,883.85, retained £8,035.57.
create function load_valor_plan() returns void language plpgsql as $$
declare vh uuid; pid uuid;
begin
  select id into vh from companies where code = 'VH';
  if vh is null or exists (select 1 from finance_plans where company_id = vh) then return; end if;
  insert into finance_plans (company_id, name, start_date, period_days, periods, source_note)
  values (vh, '2.4 Cash Flow & P&L – 88% occupancy (rebalanced)', date '2026-04-01', 28, 13,
          'Management forecast from "Valor_Housing_2.4_Cash_Flow_and_PnL_88pct_Occupancy_Rebalanced.xlsm" (model date 9 Sep 2026): 81 rooms, 16 properties, 88% occupancy, 2% collection risk, £27/week service charge separate, Dawson 12%, provider costs flexed to 88%. A forecast to reconcile against remittances, invoices and bank statements, not actual results.')
  returning id into pid;
  insert into finance_plan_lines (plan_id, period_no, direction, category, department, property_id, counterparty, label, amount)
  select pid, g, v.direction, v.category, v.department,
         (select p.id from properties p where p.company_id = vh and p.status <> 'offboarded' and v.prop is not null
             and regexp_replace(upper(p.name || ' ' || coalesce(p.address_line1, '')), '[^A-Z0-9]+', ' ', 'g') like '%' || v.prop || '%'
           order by p.created_at limit 1),
         v.counterparty, v.label, v.amount
    from generate_series(1, 13) g cross join (values
  ('income','rent','housing','11 CLARENCE',null,'Rent at 88% occupancy: 11 CLARENCE ROAD',6307.84),
  ('income','rent','housing','203 OXHILL',null,'Rent at 88% occupancy: 203 OXHILL ROAD',10775.00),
  ('income','rent','housing','119 GROVE',null,'Rent at 88% occupancy: 119 GROVE LANE',10775.00),
  ('income','rent','housing','32 CHURCH',null,'Rent at 88% occupancy: 32 CHURCH STREET',10775.00),
  ('income','rent','housing','62 MURDOCK',null,'Rent at 88% occupancy: 62 MURDOCK ROAD',9121.94),
  ('income','rent','housing','106 HOLLIDAY',null,'Rent at 88% occupancy: 106, HOLLIDAY ROAD, HANDSWORTH, BIRMINGHAM, B21 0UJ',9121.94),
  ('income','rent','housing','5 SHAKESPEARE',null,'Rent at 88% occupancy: 5 Shakespeare Crescent, B18 5BT',9170.94),
  ('income','rent','housing','179A HAGLEY',null,'Rent at 88% occupancy: 179A, HAGLEY ROAD, BIRMINGHAM, B16 8UQ',4740.91),
  ('income','rent','housing','26 RICKYARD',null,'Rent at 88% occupancy: 26 Rickyard Piece, Quinton, B32 2QW (eligible rent not supplied in the model)',0.00),
  ('income','rent','housing','177 SHELDON',null,'Rent at 88% occupancy: 177 Sheldon Heath Road, Garetts Green, B26 2DP',10787.04),
  ('income','rent','housing','33 CROMPTON',null,'Rent at 88% occupancy: 33 Crompton Road, Handsworth, Birmingham, B20 3QD',9121.94),
  ('income','rent','housing','37 LUDLOW',null,'Rent at 88% occupancy: 37 Ludlow Road, Saltley, Birmingham, B8 3BN',6307.84),
  ('income','rent','housing','52 FARMER',null,'Rent at 88% occupancy: 52, FARMER ROAD, BIRMINGHAM, B10 9JB',9109.90),
  ('income','rent','housing','227 WEST BOULEVARD',null,'Rent at 88% occupancy: 227 West Boulevard, Quinton, Birmingham, B32 2DE',6307.84),
  ('income','rent','housing','FLAT 1 JACKSONS',null,'Rent at 88% occupancy: FLAT 1 JACKSONS GARAGE',2839.37),
  ('income','rent','housing','FLAT 2 JACKSONS',null,'Rent at 88% occupancy: FLAT 2 JACKSONS GARAGE',7101.42),
  ('income','rent','housing',null,null,'Remittance control adjustment (model uses the remittance total, not the property schedule)',8474.02),
  ('income','rent','housing',null,null,'Less: payment / collection risk (2%)',-2616.76),
  ('income','service_charge','housing',null,null,'Service charge £27/week at 88% occupancy (separate payment)',7698.24),
  ('expense','managing_agent_fee','management',null,'Dawson','Dawson fee at 12% of collected rent',15386.54),
  ('expense','provider_costs','support',null,'Wellbeing Homes','Wellbeing Homes: Support & TIC (88% utilisation)',24579.87),
  ('expense','provider_costs','housing',null,'Wellbeing Homes','Wellbeing Homes: Housing management / IHM (88% utilisation)',8193.29),
  ('expense','provider_costs','property',null,'Wellbeing Homes','Wellbeing Homes: Maintenance / property services (88% utilisation)',4096.65),
  ('expense','provider_costs','lettings',null,'Wellbeing Homes','Wellbeing Homes: Brokers / estate agents (88% utilisation)',2048.32),
  ('expense','provider_costs','admin',null,'Wellbeing Homes','Wellbeing Homes: Admin / reporting (88% utilisation)',2048.32),
  ('expense','provider_costs','support',null,'Safe Space','Safe Space: Support & TIC (88% utilisation)',4104.87),
  ('expense','provider_costs','housing',null,'Safe Space','Safe Space: Housing management / IHM (88% utilisation)',2280.48),
  ('expense','provider_costs','property',null,'Safe Space','Safe Space: Maintenance / property services (88% utilisation)',1824.39),
  ('expense','provider_costs','lettings',null,'Safe Space','Safe Space: Brokers / estate agents (88% utilisation)',456.10),
  ('expense','provider_costs','admin',null,'Safe Space','Safe Space: Admin / reporting (88% utilisation)',456.10),
  ('expense','provider_costs','support',null,'We Can Provide','We Can Provide: Support & TIC (88% utilisation)',4851.74),
  ('expense','provider_costs','housing',null,'We Can Provide','We Can Provide: Housing management / IHM (88% utilisation)',3465.53),
  ('expense','provider_costs','property',null,'We Can Provide','We Can Provide: Maintenance / property services (88% utilisation)',3465.53),
  ('expense','provider_costs','lettings',null,'We Can Provide','We Can Provide: Brokers / estate agents (88% utilisation)',693.11),
  ('expense','provider_costs','admin',null,'We Can Provide','We Can Provide: Admin / reporting (88% utilisation)',1386.21),
  ('expense','provider_costs','support',null,'Support Circle Ltd','Support Circle Ltd: Support & TIC (88% utilisation)',3706.56),
  ('expense','provider_costs','housing',null,'Support Circle Ltd','Support Circle Ltd: Housing management / IHM (88% utilisation)',926.64),
  ('expense','provider_costs','property',null,'Support Circle Ltd','Support Circle Ltd: Maintenance / property services (88% utilisation)',926.64),
  ('expense','provider_costs','lettings',null,'Support Circle Ltd','Support Circle Ltd: Brokers / estate agents (88% utilisation)',308.88),
  ('expense','provider_costs','admin',null,'Support Circle Ltd','Support Circle Ltd: Admin / reporting (88% utilisation)',308.88),
  ('expense','provider_costs','support',null,'Property Plus','Property Plus: Support & TIC (88% utilisation)',3119.14),
  ('expense','provider_costs','housing',null,'Property Plus','Property Plus: Housing management / IHM (88% utilisation)',3119.14),
  ('expense','provider_costs','property',null,'Property Plus','Property Plus: Maintenance / property services (88% utilisation)',7797.84),
  ('expense','provider_costs','lettings',null,'Property Plus','Property Plus: Brokers / estate agents (88% utilisation)',779.78),
  ('expense','provider_costs','admin',null,'Property Plus','Property Plus: Admin / reporting (88% utilisation)',779.78),
  ('expense','provider_costs','support',null,'Ikon Housing','Ikon Housing: Support & TIC (88% utilisation)',3641.09),
  ('expense','provider_costs','housing',null,'Ikon Housing','Ikon Housing: Housing management / IHM (88% utilisation)',2275.68),
  ('expense','provider_costs','property',null,'Ikon Housing','Ikon Housing: Maintenance / property services (88% utilisation)',2275.68),
  ('expense','provider_costs','lettings',null,'Ikon Housing','Ikon Housing: Brokers / estate agents (88% utilisation)',455.14),
  ('expense','provider_costs','admin',null,'Ikon Housing','Ikon Housing: Admin / reporting (88% utilisation)',455.14),
  ('expense','provider_costs','support',null,'Zeo Services','Zeo Services: Support & TIC (88% utilisation)',2207.74),
  ('expense','provider_costs','housing',null,'Zeo Services','Zeo Services: Housing management / IHM (88% utilisation)',1892.35),
  ('expense','provider_costs','property',null,'Zeo Services','Zeo Services: Maintenance / property services (88% utilisation)',1261.57),
  ('expense','provider_costs','lettings',null,'Zeo Services','Zeo Services: Brokers / estate agents (88% utilisation)',315.39),
  ('expense','provider_costs','admin',null,'Zeo Services','Zeo Services: Admin / reporting (88% utilisation)',630.78),
  ('expense','staffing','management',null,null,'Staffing: Director',1500.00),
  ('expense','staffing','support',null,null,'Staffing: Safeguarding Lead',600.00),
  ('expense','staffing','support',null,null,'Staffing: Safeguarding Board Manager / Support Worker',450.00),
  ('expense','staffing','support',null,null,'Staffing: Lead Support Worker',900.00),
  ('expense','staffing','support',null,null,'Staffing: Support Worker sessions',4062.96),
  ('expense','staffing','admin',null,null,'Staffing: Administrator / Support Worker',900.00),
  ('expense','staffing','housing',null,null,'Staffing: Housing Officer',700.00),
  ('expense','staffing','property',null,null,'Staffing: Maintenance Operative',500.00),
  ('expense','staffing','property',null,null,'Staffing: Cleaner',400.00),
  ('expense','staffing','compliance',null,null,'Staffing: Compliance Officer',550.00),
  ('expense','staffing','finance',null,null,'Staffing: Finance / Payroll Administrator',350.00),
  ('expense','staffing','support',null,null,'Staffing: Out of Hours On-call Cover',450.00)
    ) v(direction, category, department, prop, counterparty, label, amount);
  insert into finance_hub_settings (company_id) values (vh) on conflict do nothing;
end $$;
select load_valor_plan();

alter table finance_accounts enable row level security;
alter table finance_transactions enable row level security;
alter table finance_commitments enable row level security;
alter table finance_plans enable row level security;
alter table finance_plan_lines enable row level security;
alter table finance_hub_settings enable row level security;
alter table finance_saved_views enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;

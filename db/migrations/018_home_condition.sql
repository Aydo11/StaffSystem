-- House mood rating: staff rate each part of a home (1–5 stars) when they finish a visit.
-- A null aspect means "not checked / not applicable". The property score uses the latest rating of each aspect.
create table condition_ratings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  visit_id uuid unique references visits,
  rated_by uuid not null references people,
  kitchen smallint check (kitchen between 1 and 5),
  bathroom smallint check (bathroom between 1 and 5),
  bedrooms smallint check (bedrooms between 1 and 5),
  living_areas smallint check (living_areas between 1 and 5),
  garden smallint check (garden between 1 and 5),
  communal smallint check (communal between 1 and 5),
  note text check (length(note) <= 1000),          -- what needs improving
  created_at timestamptz not null default now(),
  check (coalesce(kitchen, bathroom, bedrooms, living_areas, garden, communal) is not null)
);
create index condition_ratings_property on condition_ratings (property_id, created_at desc);

-- One row per property: the latest star rating of each aspect from the last 12 months, and the overall score (0–100).
create view property_condition as
select x.property_id, jsonb_object_agg(x.aspect, x.stars) as aspects, round(avg(x.stars) * 20)::int as score, max(x.rated_at) as rated_at
  from (select distinct on (r.property_id, a.aspect) r.property_id, a.aspect, a.stars, r.created_at as rated_at
          from condition_ratings r
          cross join lateral (values ('kitchen', r.kitchen), ('bathroom', r.bathroom), ('bedrooms', r.bedrooms), ('living_areas', r.living_areas), ('garden', r.garden), ('communal', r.communal)) a(aspect, stars)
         where a.stars is not null and r.created_at > now() - interval '12 months'
         order by r.property_id, a.aspect, r.created_at desc) x
 group by x.property_id;

-- Complaints made about or within a property, logged by any staff member. Each one becomes a task for the
-- company's complaints lead (Governance → Accountability → Complaints oversight); completing the task resolves it.
create table property_complaints (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  visit_id uuid references visits,
  raised_by uuid not null references people,
  source text not null check (source in ('resident','neighbour','visitor','staff','other')),
  category text not null check (category in ('noise','cleanliness','repairs','behaviour','staff_conduct','safety','other')),
  summary text not null check (length(summary) between 3 and 4000),
  task_id uuid references tasks,
  created_at timestamptz not null default now()
);
create index property_complaints_property on property_complaints (property_id, created_at desc);

alter table condition_ratings enable row level security;
alter table property_complaints enable row level security;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;

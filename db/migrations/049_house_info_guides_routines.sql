-- House info packs, staff guides, property routines and policy reading (11 Nov 2026, owner request).

-- ── Policies: the owner confirmed that every current member of staff has read every current policy (they were read
-- before the policies were added to the Hub). Record it once, dated today; staff are no longer asked to press Acknowledge.
insert into policy_receipts (policy_id, company_id, person_id)
select distinct pp.policy_id, pp.company_id, a.person_id
  from policy_publications pp join policies p on p.id = pp.policy_id
  join appointments a on a.company_id = pp.company_id and a.status = 'active'
       and a.start_date <= (now() at time zone 'Europe/London')::date
       and (a.end_date is null or a.end_date >= (now() at time zone 'Europe/London')::date)
 where p.status = 'approved'
   and not exists (select 1 from policies p2 join policy_publications pp2 on pp2.policy_id = p2.id
                    where p2.root_id = p.root_id and p2.version > p.version and pp2.company_id = pp.company_id)
on conflict do nothing;
with done as (
  update policy_receipts set opened_at = coalesce(opened_at, now()), acknowledged_at = now()
   where acknowledged_at is null returning company_id)
insert into audit_log (company_id, entity, action, detail)
select company_id, 'policy', 'recorded_as_read', jsonb_build_object('receipts', count(*), 'reason', 'Owner confirmed all current staff have read all current policies')
  from done group by company_id;

-- ── House info pack: what staff need to know about a house. `access` (key safe, door and alarm codes) is only for
-- people who manage the property; everything else is for anyone who can see the property.
create table property_info (
  property_id uuid primary key references properties,
  company_id uuid not null references companies,
  sections jsonb not null default '{}',     -- { section key: text }, keys from INFO_SECTIONS in routes/houseinfo.ts
  access text check (length(access) <= 4000),
  updated_by uuid references people,
  updated_at timestamptz not null default now()
);
create table property_info_photos (
  file_id uuid primary key references files on delete cascade,
  property_id uuid not null references properties,
  section text not null check (length(section) <= 40)
);
create index property_info_photos_property on property_info_photos (property_id, section);
alter table files drop constraint files_entity_type_check;
alter table files add constraint files_entity_type_check check (entity_type in ('task','property','person_photo','qualification','visit','course','policy','training_record','meeting','action','case','safety_check','repair','agent','audit','finance','message','news','person_doc','story','complaint','finance_txn','compliance','inspection_item','risk','quiz_attempt','property_info'));

-- ── Property routines: repeating jobs at a house (bins out, fire alarm test, communal clean). Each one becomes a task
-- on the day it is due (`runRoutines`, hourly), so missed ones show as overdue.
create table property_routines (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies,
  property_id uuid not null references properties,
  title text not null check (length(title) between 3 and 200),
  details text check (length(details) <= 2000),
  frequency text not null check (frequency in ('daily','weekly','fortnightly','monthly')),
  weekday int check (weekday between 1 and 7),            -- ISO: 1 Monday … 7 Sunday (weekly, fortnightly)
  month_day int check (month_day between 1 and 28),       -- monthly
  start_on date not null default (now() at time zone 'Europe/London')::date,
  owner_id uuid references people,                        -- null: the property manager
  checklist jsonb not null default '[]',
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  created_by uuid references people,
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_by uuid references people,
  check ((frequency in ('weekly','fortnightly')) = (weekday is not null)),
  check ((frequency = 'monthly') = (month_day is not null))
);
create index property_routines_property on property_routines (property_id) where ended_at is null;
alter table tasks add column routine_id uuid references property_routines, add column routine_date date;
create unique index tasks_routine_day on tasks (routine_id, routine_date) where routine_id is not null;

-- ── Staff guides ("How do I…?"). company_id null = every company.
insert into permissions (key, description) values ('guides.manage', 'Write and publish staff guides') on conflict do nothing;
insert into role_permissions (role_key, permission_key) values
  ('super_admin', 'guides.manage'), ('company_admin', 'guides.manage'), ('hr_admin', 'guides.manage'), ('manager', 'guides.manage'), ('quality_lead', 'guides.manage')
on conflict do nothing;
create table guides (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies,
  category text not null check (category in ('getting_started','visits_time','houses','repairs_complaints','training','emergencies','other')),
  title text not null check (length(title) between 3 and 200),
  summary text check (length(summary) <= 300),
  body text not null check (length(body) between 3 and 20000),
  status text not null default 'draft' check (status in ('draft','published')),
  created_by uuid references people,
  updated_by uuid references people,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz
);
create index guides_status on guides (status, category);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on property_info, property_info_photos, property_routines, guides from anon, authenticated, public';
  end if;
end $$;
alter table property_info enable row level security;
alter table property_info_photos enable row level security;
alter table property_routines enable row level security;
alter table guides enable row level security;

-- Starter guides. How-to guides describe the Hub as built and are published. The emergency guides are general first
-- steps written by Claude, kept as drafts for a manager to check against Valor's own policies before publishing.
insert into guides (category, title, summary, body, status, published_at) values
('getting_started', 'Your first day on the Hub', 'Where things are and what to check each shift.',
'My Day is your home page. Start every shift there.

What you will see:
- Your shift today: visits planned for today, tasks due or overdue, today''s handover notes and any alerts at your houses.
- My visit plan: your planned visits for the week, with a Start Visit button on the day.
- Priority checklist: your open tasks, most urgent first.
- Today''s handover: notes left by colleagues for today.
- Quick tools: log a visit, log other time, your timesheet and your profile.

Other places you will use:
- Properties: every house you work at, with its info pack, routines, repairs and visits.
- Guides: how to do things on the Hub, and what to do in an emergency.
- Chat: messages with colleagues and groups.
- Training & coaching: your courses, record and certificates.

If something looks wrong or you are stuck, use Request Help on My Day or ask your manager.', 'published', now()),

('getting_started', 'Complete your profile', 'What to add to your profile and why it matters.',
'Open My Profile from My Day (Quick tools) or the menu.

Add or check:
1. Your preferred name and photo, so colleagues recognise you.
2. Your work phone and usual working hours, so managers know when you are available.
3. Your skills and languages.
4. Your qualifications and documents. Just upload them; they do not need to be verified.

Managers can see your profile. Personal contact details and your home address are restricted to HR.', 'published', now()),

('visits_time', 'Starting and finishing a visit', 'Use the timer so your time is recorded and paid correctly.',
'1. Go to My Day and press Start Visit next to the planned visit, or open the property and press Start Visit.
2. The Hub may ask to use your location when you press the button. It is only taken at that moment. If you say no, the visit still starts.
3. Do the visit. The timer keeps running if you lock your phone.
4. Press Finish Visit when you leave.
5. Rate the parts of the house you checked, add a short note, and add photos if useful.
6. If there is a repair or a complaint, add it on the same screen. It goes straight to the right person.

Support work is approved automatically when you finish. Other visits go to your manager to review.', 'published', now()),

('visits_time', 'Forgot to start the timer?', 'How to log a visit after it has happened.',
'1. On My Day, press Log Completed Visit (Quick tools).
2. Choose the property and the type of visit.
3. If you have only just finished, press I''ve just finished to fill in the times; otherwise enter the real start and finish times.
4. Add a short note, the house rating and any photos, then save.

Always record the real times. Never round up or guess.', 'published', now()),

('visits_time', 'Logging other time and submitting your timesheet', 'Training, meetings and office time, and sending your timesheet.',
'Time that is not a visit (training, meetings, office work, travel between houses) is logged separately.

1. On My Day press Log other time, or open Timesheets.
2. Choose the date, the times and what it was for, then save.
3. At the end of the period open My timesheet, check every day is right, and press Submit timesheet.

Your manager approves it. If they send something back, you will get a notification saying what to fix.', 'published', now()),

('visits_time', 'Requesting leave', 'How to book time off and hand over your work.',
'1. Open Leave and press Request leave.
2. Choose the dates and add a handover note for whoever covers you.
3. Your manager approves or declines it, and you get a notification.

When leave is approved, your open tasks due while you are away are handed to colleagues who are working, with your handover note.', 'published', now()),

('visits_time', 'Leaving a handover note', 'Tell the next shift what they need to know.',
'Open Handover from the menu, choose the date and the house, and write a short note: what happened, what is outstanding, and anything the next person must do.

Handover notes show on everyone''s My Day for that date. Keep them about the house and the work. Do not include residents'' personal details or sensitive staff matters.', 'published', now()),

('houses', 'Using the house info pack', 'Stopcock, fuse board, boiler, bin days and more for every house.',
'Every property page has an Info pack tab. It tells you where things are and how the house works:
- Water: where the stopcock is
- Electrics: fuse board and trip switches
- Heating and hot water: boiler and thermostat
- Meters, bin days, wifi, the fire alarm and escape routes, house rules and emergency contacts

Many sections have photos. Check the info pack before your first visit to a house.

Key safe, door and alarm codes are in a separate section that only managers can see. Ask your manager if you need access.

Managers: keep the info pack up to date. Press Edit info pack on the property''s Info pack tab.', 'published', now()),

('houses', 'House routines', 'Regular jobs at each house and how they reach you.',
'Each house can have routines: regular jobs such as putting the bins out, testing the fire alarm or cleaning communal areas.

On the day a routine is due, the Hub creates a task for the person responsible (or the property manager). It shows in your Priority checklist on My Day. Open it, tick the checklist and mark it complete.

A routine task that is not completed shows as overdue.

Managers set routines on the property''s Routines tab.', 'published', now()),

('repairs_complaints', 'Reporting a repair', 'Get repairs to the right person quickly.',
'1. Open the property and go to the Repairs tab, then press Report a repair. You can also report one when you finish a visit.
2. Say what is wrong, where it is, and what it is affecting.
3. The Hub suggests a priority from your words. You can raise it if it is more serious. Only a manager can lower it.
4. Add photos if you can.

If anyone is in danger (gas smell, fire, electrical danger, major leak) deal with the emergency first. See the emergency guides.

You can follow the repair''s progress on the Repairs tab.', 'published', now()),

('repairs_complaints', 'Logging a complaint', 'Any complaint, however it reaches you.',
'If a resident, neighbour or anyone else complains, log it the same day.

1. Open the property and press Log a complaint. You can also add one when you finish a visit.
2. Say how it reached you (phone call, in person, email, text or letter).
3. Write what the complaint is about in plain words. Do not write anyone''s full name or personal details.

It goes straight to the complaints lead, who acknowledges it and keeps the person updated.', 'published', now()),

('repairs_complaints', 'Recording how a house is without a visit', 'House mood findings from a phone call or a drop-in.',
'If you learn how a house is without a full visit, open the property and press Record findings. Rate what you know about and add a short note. It updates the house mood score that managers watch.', 'published', now()),

('training', 'Your training and certificates', 'Courses, your record and certificates.',
'Open Training & coaching.
- Dashboard: what is due and what to do next.
- Course library: every course, with filters.
- My record: what you have completed. Hub courses have a Certificate button, and you can save it as a PDF.

Got a certificate from outside the Hub? On My record press Add an external certificate and upload it. A trainer checks it.

Hub certificates are issued by the company. They are not accredited qualifications.', 'published', now()),

('getting_started', 'Asking the Hub', 'Quick answers about your day.',
'On My Day, type a question into Ask the Hub, for example "What is due today?" or "Who is off this week?".

It answers from your tasks, your plan, handover notes, who is away and these guides. It shows where each answer came from. Always check anything important.', 'published', now()),

('getting_started', 'Chat', 'Messages and groups.',
'Open Chat from the menu. Press New chat to message a colleague or start a group.

You can send photos, react to messages and forward messages. Do not share residents'' personal details in chat.', 'published', now()),

-- Drafts: general first steps, for a manager to check against Valor's own policies before publishing.
('emergencies', 'Fire alarm sounding', 'First steps if the fire alarm goes off.',
'1. If you see or suspect fire, leave the building now by the nearest safe route. Do not stop to collect belongings.
2. Raise the alarm and help others to leave if it is safe to do so.
3. Call 999 and ask for the fire service.
4. Go to the assembly point and do not go back in until the fire service says it is safe.
5. Tell your manager as soon as you can, then record what happened on the Hub.

If it was a false alarm, do not reset the panel unless you have been shown how. Tell your manager so it can be checked.

See the house info pack (fire alarm and escape route) for this house.', 'draft', null),

('emergencies', 'Gas smell', 'What to do if you smell gas.',
'1. Do not use light switches, phones or anything that could make a spark inside the house.
2. Open doors and windows.
3. Turn off the gas at the meter if it is safe to do so (see the house info pack for where the meter is).
4. Get everyone out of the house.
5. From outside, call the National Gas Emergency Service on 0800 111 999.
6. Tell your manager and report it on the Hub as an emergency repair.', 'draft', null),

('emergencies', 'Water leak or burst pipe', 'Stop the water and report it.',
'1. Turn off the water at the stopcock (the house info pack shows where it is).
2. If water is near electrics or light fittings, do not touch them. Turn off the power at the fuse board only if you can do it without touching water.
3. Move belongings away from the water if it is safe.
4. Report it on the Hub as an urgent or emergency repair, with photos.
5. Tell your manager.', 'draft', null),

('emergencies', 'Power cut', 'Check the house first, then report it.',
'1. Check whether neighbours have power too.
2. If only this house is affected, check the fuse board for a tripped switch (see the house info pack). Reset it once. If it trips again, leave it off and report a repair.
3. If the whole street is off, call 105 to report the power cut.
4. Check residents are safe and warm, and tell your manager.', 'draft', null),

('emergencies', 'Resident missing or not seen', 'First steps if you are worried about a resident.',
'1. If you believe someone is at immediate risk, call 999.
2. Otherwise tell your manager straight away and follow Valor''s missing person procedure.
3. Note when the resident was last seen and anything relevant, and record it on the Hub as your manager directs.

Do not put the resident''s personal details in chat or handover notes.', 'draft', null),

('emergencies', 'Lone working', 'Staying safe when you work alone.',
'1. Make sure someone knows where you are. Your visits on the Hub show this.
2. Keep your phone charged and with you.
3. If you feel unsafe, leave and call your manager. In an emergency call 999.
4. Use Request Help on My Day to ask for support.', 'draft', null);

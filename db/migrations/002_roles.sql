-- Reference data: roles and permissions. Administrators can change role_permissions later.
insert into permissions (key, description) values
  ('company.combined_view', 'See the combined management view across permitted companies'),
  ('company.manage',        'Edit company details, branding and settings'),
  ('staff.view',            'See staff directory and professional profiles'),
  ('staff.create',          'Invite people and create profiles'),
  ('staff.edit',            'Edit profiles and verify proposed changes'),
  ('staff.restricted',      'See personal contacts, home address and emergency contacts'),
  ('appointments.view',     'See company appointments'),
  ('appointments.manage',   'Create, change and end appointments and property allocations'),
  ('rates.view',            'See pay and charge rates (restricted)'),
  ('rates.manage',          'Set effective-dated rates (restricted)'),
  ('checks.view',           'See DBS, right-to-work and other employment checks (restricted)'),
  ('checks.manage',         'Record employment checks (restricted)'),
  ('clearance.view',        'See deployment clearance status'),
  ('clearance.decide',      'Record deployment clearance decisions'),
  ('clearance.override',    'Authorise an exception when clearance is missing'),
  ('properties.view',       'See all company properties (staff always see their allocated ones)'),
  ('properties.manage',     'Create and edit properties, keys and allocations'),
  ('visits.view_all',       'See everyone''s visits in the company'),
  ('visits.approve',        'Approve visits, corrections, splits and time entries'),
  ('tasks.view_all',        'See all tasks in the company'),
  ('tasks.manage',          'Create, assign and review tasks'),
  ('timesheets.view_all',   'See all timesheets in the company'),
  ('timesheets.approve',    'Approve or reject timesheets'),
  ('audit.view',            'Read the audit log'),
  ('access.manage',         'Grant, delegate and revoke roles')
on conflict do nothing;

insert into roles (key, label, description, privileged) values
  ('super_admin',       'Super administrator',          'Everything, in every company. Keep to as few people as possible.', true),
  ('company_admin',     'Company administrator',        'Runs one company''s settings, people and access.', true),
  ('hr_admin',          'HR administrator',             'Profiles, appointments, checks, clearance and rates.', true),
  ('manager',           'Manager',                      'Oversees staff, approves visits, tasks and timesheets.', false),
  ('staff',             'Staff member',                 'Own work: properties, visits, tasks, timesheets.', false),
  ('property_officer',  'Property officer',             'Manages properties, keys and property tasks.', false),
  ('maintenance',       'Maintenance / cleaning worker','Own visits and tasks at allocated properties.', false),
  ('finance_admin',     'Finance administrator',        'Rates and timesheet costs.', true),
  ('quality_lead',      'Quality / governance lead',    'Read access for assurance and audit.', false),
  ('agent_user',        'Managing-agent user',          'Limited to permitted properties (later stage).', false),
  ('reviewer',          'Time-limited reviewer',        'Read-only, must have an expiry date.', false)
on conflict do nothing;

insert into role_permissions (role_key, permission_key)
select 'super_admin', key from permissions
union all select 'company_admin', key from permissions where key not in ('rates.manage')
union all select 'hr_admin', unnest(array['staff.view','staff.create','staff.edit','staff.restricted','appointments.view','appointments.manage','rates.view','rates.manage','checks.view','checks.manage','clearance.view','clearance.decide','clearance.override','properties.view','audit.view'])
union all select 'manager', unnest(array['staff.view','appointments.view','clearance.view','properties.view','visits.view_all','visits.approve','tasks.view_all','tasks.manage','timesheets.view_all','timesheets.approve'])
union all select 'staff', unnest(array['staff.view'])
union all select 'property_officer', unnest(array['staff.view','properties.view','properties.manage','tasks.view_all','tasks.manage'])
union all select 'maintenance', unnest(array['staff.view'])
union all select 'finance_admin', unnest(array['staff.view','appointments.view','rates.view','rates.manage','timesheets.view_all'])
union all select 'quality_lead', unnest(array['staff.view','appointments.view','clearance.view','properties.view','visits.view_all','tasks.view_all','timesheets.view_all','audit.view','company.combined_view'])
union all select 'reviewer', unnest(array['staff.view','properties.view','visits.view_all','tasks.view_all'])
on conflict do nothing;

-- A reviewer grant without an end date is not allowed.
alter table role_grants add constraint reviewer_must_expire check (role_key <> 'reviewer' or expires_at is not null);

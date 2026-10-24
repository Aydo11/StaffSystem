-- User confirmed on 24 October 2026 that workbook sample labels were stale.
-- Publish aggregate source summaries without resident details or merging overlapping datasets.
insert into news_posts (company_ids,category,title,summary,body,cover_asset,image_alt,status,author_id,published_at)
select array[c.id], 'operations', s.title,s.summary,s.body,'daily-work','Illustration of colleagues reviewing housing work.','published',a.id,now()
from companies c cross join (select person_id id from role_grants where role_key='super_admin' and revoked_at is null and valid_from <= now() and (expires_at is null or expires_at > now()) order by valid_from limit 1) a
cross join (values
('August 2026: Valor operations update', '10 recorded meetings and 38 support activities, with separate figures from the KPI tracker.', 'August 2026: operational update from the supplied records.

Meetings and activity workbook

10 meetings, 23 decision entries and 25 action entries are recorded. The same workbook records 38 individual support activities totalling 20 hours 30 minutes, 24 maintenance jobs and 32 property visits. These are recorded entries, not a statement that every action is complete or every visit has been approved.

KPI operations tracker

The separate tracker records 22 repairs reported, 4 incidents raised and 3 complaints received in this month. Monthly delivered support hours are 959.5 across 44 resident-month rows. The tracker report date is 9 October 2026; October figures are partial. The activity workbook covers records through 23 October.

Reading these figures

The two workbooks use different record types, identifiers and coverage. Their counts and hours are reported separately and have not been added together or treated as duplicate-free company totals. A resident-month support-hours total is different from a list of individual activities. No collection, satisfaction or compliance percentage is inferred from these counts.

Source and entry date

Valor_Housing_Meetings_Sample_Data_Aug-Oct_2026.xlsx and Valor_Housing_KPI_Operations_Tracker_Updated.xlsm. On 24 October 2026 the director confirmed that the entries are actual records and that the sample labels were left over from the template. This retrospective update is published on its entry date. Individual names and resident details are not included here.'),
('September 2026: Valor operations update', '9 recorded meetings and 43 support activities, with separate figures from the KPI tracker.', 'September 2026: operational update from the supplied records.

Meetings and activity workbook

9 meetings, 23 decision entries and 20 action entries are recorded. The same workbook records 43 individual support activities totalling 23 hours 55 minutes, 20 maintenance jobs and 39 property visits. These are recorded entries, not a statement that every action is complete or every visit has been approved.

KPI operations tracker

The separate tracker records 20 repairs reported, 8 incidents raised and 2 complaints received in this month. Monthly delivered support hours are 954.75 across 42 resident-month rows. The tracker report date is 9 October 2026; October figures are partial. The activity workbook covers records through 23 October.

Reading these figures

The two workbooks use different record types, identifiers and coverage. Their counts and hours are reported separately and have not been added together or treated as duplicate-free company totals. A resident-month support-hours total is different from a list of individual activities. No collection, satisfaction or compliance percentage is inferred from these counts.

Source and entry date

Valor_Housing_Meetings_Sample_Data_Aug-Oct_2026.xlsx and Valor_Housing_KPI_Operations_Tracker_Updated.xlsm. On 24 October 2026 the director confirmed that the entries are actual records and that the sample labels were left over from the template. This retrospective update is published on its entry date. Individual names and resident details are not included here.'),
('October 2026 — progress recorded so far: Valor operations update', '8 recorded meetings and 32 support activities, with separate figures from the KPI tracker.', 'October 2026 — progress recorded so far: operational update from the supplied records.

Meetings and activity workbook

8 meetings, 19 decision entries and 18 action entries are recorded. The same workbook records 32 individual support activities totalling 16 hours 45 minutes, 24 maintenance jobs and 25 property visits. These are recorded entries, not a statement that every action is complete or every visit has been approved.

KPI operations tracker

The separate tracker records 7 repairs reported, 2 incidents raised and 1 complaints received in this month. Monthly delivered support hours are not supplied for October. The tracker report date is 9 October 2026; October figures are partial. The activity workbook covers records through 23 October.

Reading these figures

The two workbooks use different record types, identifiers and coverage. Their counts and hours are reported separately and have not been added together or treated as duplicate-free company totals. A resident-month support-hours total is different from a list of individual activities. No collection, satisfaction or compliance percentage is inferred from these counts.

Source and entry date

Valor_Housing_Meetings_Sample_Data_Aug-Oct_2026.xlsx and Valor_Housing_KPI_Operations_Tracker_Updated.xlsm. On 24 October 2026 the director confirmed that the entries are actual records and that the sample labels were left over from the template. This retrospective update is published on its entry date. Individual names and resident details are not included here.')
) s(title,summary,body)
where c.code='VH' and not exists(select 1 from news_posts n where n.title=s.title and n.company_ids=array[c.id]);

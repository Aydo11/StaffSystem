-- Current company information and a retrospective account supplied by the director.
-- This creates no visits, attendance, decisions, approvals, hours or KPI results.
-- Publish on the real entry date; never backdate the article to August.
insert into news_posts (company_ids, category, title, summary, cover_asset, body, image_alt, pinned, status, author_id, published_at)
select array[c.id], s.category, s.title, s.summary, s.cover, s.body,
  case s.cover when 'welcome' then 'Illustration of colleagues exploring the staff Hub together.'
    when 'daily-work' then 'Illustration of housing colleagues reviewing work outside a property.'
    else 'Illustration of colleagues learning and preparing together.' end,
  s.pinned, 'published', a.id, now()
from companies c
cross join (select person_id id from role_grants where role_key = 'super_admin' and revoked_at is null
  and valid_from <= now() and (expires_at is null or expires_at > now()) order by valid_from limit 1) a
cross join (values
('announcement', 'Valor Housing: who we are and how we work', 'An introduction to Valor Housing, our supported accommodation work in Birmingham and how the staff Hub supports the team.', 'welcome', 'Valor Housing Ltd provides supported accommodation in Birmingham. Our work brings together housing management, practical support and coordination with the people and organisations involved in maintaining residents'' homes.

Leadership and purpose

Ayden Yafai is Valor Housing''s director. Our focus is on housing quality, reliable services and clear responsibility for the work we do. The Hub helps the team organise staff activity, property work, learning and governance information in one place.

How the work connects

Staff use the Hub to organise visits and tasks, find property information, keep their professional records current and follow relevant training and policies. Managers use the records available to their role to review progress, follow up outstanding work and support colleagues.

Working with other organisations

Valor Housing works with managing agents and other delivery partners. Responsibilities should be clear in the relevant agreements and property records. Confirm which organisation and property a record concerns before adding an update, and use the agreed route when work needs another organisation''s response.

Housing records and support records

The Hub is a staff and operational platform. Resident case notes, individual support plans and confidential support information belong in the designated support system. Keep general News and Chat posts free of resident information.

Getting started

Read the staff welcome guides, check your profile and organisation access, and agree your current responsibilities with your manager. Use the current policy documents for procedures and ask for help where a task or responsibility is unclear.

About this introduction

Prepared on 24 October 2026 from company information supplied by the director. It does not assert an accreditation award, regulatory registration or independently verified company-registration details.', true),
('update', 'Our operating history from August 2026', 'The director confirms ongoing support delivery and fortnightly meetings from 1 August 2026. This update records that account without inventing individual activity records.', 'daily-work', 'The director has confirmed that Valor Housing has been providing support and holding meetings every two weeks during the period beginning 1 August 2026.

This is an overview of the operating history reported by the director. It was entered on 24 October 2026. The date of this article is the date the account was recorded, not the date of a historical meeting or visit.

Support delivery

Support has been ongoing during this period. Individual activity needs to be recorded against the correct date, worker and property using the appropriate system. This overview does not give a total for visits, residents supported, hours delivered or completed outcomes because the underlying activity records have not yet been supplied for import.

Fortnightly meetings

The reported meeting cycle is every two weeks from August. Each meeting record should contain its actual date, attendance, agenda, discussion, decisions and agreed actions. The recurrence alone is not a record of who attended or what was agreed. Exact historical meeting dates and minutes will be added from the team''s records.

Bringing the history into the Hub

Historical records should retain the date the work happened and identify the source used to enter them. A retrospective entry should show when it was created. Existing records should be matched before import so that visits, tasks and meetings are not counted twice.

What colleagues can do

Keep your current records accurate and give your manager any outstanding activity notes or meeting papers through the appropriate channel. Do not upload confidential resident notes to News or Chat.

Source

Director''s account supplied on 24 October 2026: support has been provided and meetings held every two weeks since 1 August. Supporting logs, attendance lists, minutes and decisions are separate records and are not represented as verified by this article.', false),
('operations', 'Fortnightly meetings: a practical guide for the team', 'How to prepare for a meeting and turn discussion into clear follow-up. This is working guidance, not historical minutes.', 'learning', 'The director has confirmed a fortnightly meeting cycle. This guide explains how the Hub can support those meetings and their follow-up.

Before the meeting

Check the previous meeting''s outstanding actions. Prepare factual updates on the work you are responsible for, bring relevant records and identify decisions or support you need. Keep personal information in the appropriate restricted system.

A useful agenda

The chair can use an agenda covering outstanding actions, support delivery, staffing and learning, property conditions and repairs, concerns and feedback, and quality improvement. These are suggested topics for planning; they do not describe what was discussed at any past meeting.

During the meeting

Record the actual date and attendees. Separate information updates from decisions, and make clear what action is needed, who owns it and when it is due. Record conflicts of interest where relevant. Do not infer an approval from a general conversation.

After the meeting

Save draft minutes for review and use the Hub''s approval process when the authorised person has checked them. Add agreed actions to the appropriate records so that owners can follow them up. An approved version should remain available if minutes are later amended.

Bringing older minutes across

Use the actual notes or papers for each meeting. Preserve the historical meeting date and the current entry date. Ask the chair to resolve missing information rather than copying a generic agenda into the minutes as if it happened.

Purpose of this guide

This is practical guidance prepared on 24 October 2026. It does not certify that particular actions, discussions, approvals or meetings took place.', false)
) s(category, title, summary, cover, body, pinned)
where c.code = 'VH'
  and not exists (select 1 from news_posts n where n.title = s.title and n.company_ids = array[c.id]);


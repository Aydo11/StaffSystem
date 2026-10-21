-- News: an "update" category, a short summary for cards, and sample posts to start with.
alter table news_posts drop constraint news_posts_category_check;
alter table news_posts add constraint news_posts_category_check check (category in ('update','announcement','policy','training','celebration','operations','other'));
alter table news_posts add column summary text check (char_length(summary) <= 300);

-- Sample posts (marked "Sample") for every company, written as a super admin (or the first person).
-- Skipped on an empty database, e.g. before seeding. Archive or edit them from the News page.
insert into news_posts (company_ids, category, title, summary, body, pinned, status, author_id, published_at)
select c.ids, s.category, s.title, s.summary, s.body, s.pinned, 'published', a.id, now() - s.ago
  from (select array_agg(id order by code) ids from companies) c,
       (select coalesce((select person_id from role_grants where role_key = 'super_admin' and revoked_at is null order by valid_from limit 1),
                        (select id from people order by created_at limit 1)) id) a,
       (values
         ('update', 'Sample: Tell your story on your profile', 'Every profile now has a "My story" tab: a short book about you, your journey and why you do this work.',
          E'Every profile now has a "My story" tab. Write a few chapters about where you come from, what shaped you and why you do this work, and add a photo to each one.\n\nYou choose who can read it: only you, managers and HR, or all your colleagues. Nobody else can edit it.\n\nOpen My Profile, choose My story and press Start writing.', true, interval '1 hour'),
         ('update', 'Sample: Chat is here', 'Message colleagues one to one or in groups, share photos, add emoji and react to messages.',
          E'Chat now lives in the sidebar. Start a one-to-one chat or a group for a team or a property, share photos from visits, and react to messages with emoji.\n\nPlease never share resident details in chat; use the support system for those.', false, interval '3 hours'),
         ('update', 'Sample: A tidier profile page', 'Your photo, roles and contact details now sit in one card at the top, with clear tabs underneath.',
          E'Profiles have been reorganised. Your photo, current roles and contact details sit in one card at the top. Underneath are tabs for Overview, My story, Skills & documents, Roles and Development.\n\nWe now say "role" instead of "appointment" for the job you hold in each company.', false, interval '1 day'),
         ('training', 'Sample: Safeguarding refresher dates', 'Book your place on this term''s safeguarding adults refresher. Sessions run monthly.',
          E'Safeguarding adults refresher sessions run monthly. Everyone needs a refresher at least every year; check your CPD roadmap on your profile to see when yours is due.\n\nBook through the Training page and upload your certificate afterwards so the step is ticked.', false, interval '2 days'),
         ('celebration', 'Sample: Thank you to the property team', 'A big thank you for a busy month of inspections, repairs and move-ins.',
          E'A big thank you to everyone who covered visits, inspections and move-ins this month. Your notes and photos after each visit make a real difference to how quickly repairs get done.\n\nKeep the photos coming: you can add them when you finish a visit.', false, interval '4 days'),
         ('operations', 'Sample: Logging visits with photos', 'Finish a visit and add photos in one go, so the property record stays up to date.',
          E'When you finish a visit you can now add photos straight away. They appear on the visit and on the property page, so everyone can see the latest condition.\n\nSupport work is approved automatically; other visits still go to your manager for review.', false, interval '6 days')
       ) s(category, title, summary, body, pinned, ago)
 where a.id is not null and c.ids is not null;

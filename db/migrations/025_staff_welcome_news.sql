-- Permanent staff welcome guides. Static illustrations contain no staff or resident data.
alter table news_posts add column cover_asset text
  check (cover_asset in ('welcome', 'daily-work', 'learning'));

-- Archive only unchanged samples supplied by 017; preserve posts that staff have edited.
update news_posts set status = 'archived'
where title in (
  'Sample: Tell your story on your profile', 'Sample: Chat is here',
  'Sample: A tidier profile page', 'Sample: Safeguarding refresher dates',
  'Sample: Thank you to the property team', 'Sample: Logging visits with photos'
) and summary in (
  'Every profile now has a "My story" tab: a short book about you, your journey and why you do this work.',
  'Message colleagues one to one or in groups, share photos, add emoji and react to messages.',
  'Your photo, roles and contact details now sit in one card at the top, with clear tabs underneath.',
  'Book your place on this term''s safeguarding adults refresher. Sessions run monthly.',
  'A big thank you for a busy month of inspections, repairs and move-ins.',
  'Finish a visit and add photos in one go, so the property record stays up to date.'
) and body in (
  E'Every profile now has a "My story" tab. Write a few chapters about where you come from, what shaped you and why you do this work, and add a photo to each one.\n\nYou choose who can read it: only you, managers and HR, or all your colleagues. Nobody else can edit it.\n\nOpen My Profile, choose My story and press Start writing.',
  E'Chat now lives in the sidebar. Start a one-to-one chat or a group for a team or a property, share photos from visits, and react to messages with emoji.\n\nPlease never share resident details in chat; use the support system for those.',
  E'Profiles have been reorganised. Your photo, current roles and contact details sit in one card at the top. Underneath are tabs for Overview, My story, Skills & documents, Roles and Development.\n\nWe now say "role" instead of "appointment" for the job you hold in each company.',
  E'Safeguarding adults refresher sessions run monthly. Everyone needs a refresher at least every year; check your CPD roadmap on your profile to see when yours is due.\n\nBook through the Training page and upload your certificate afterwards so the step is ticked.',
  E'A big thank you to everyone who covered visits, inspections and move-ins this month. Your notes and photos after each visit make a real difference to how quickly repairs get done.\n\nKeep the photos coming: you can add them when you finish a visit.',
  E'When you finish a visit you can now add photos straight away. They appear on the visit and on the property page, so everyone can see the latest condition.\n\nSupport work is approved automatically; other visits still go to your manager for review.'
) and image_file_id is null;

-- Skip an empty installation. Never invent an author or grant access.
insert into news_posts (company_ids, category, title, summary, body, cover_asset, image_alt, pinned, status, author_id, published_at)
select c.ids, s.category, s.title, s.summary, s.body, s.cover, s.alt, s.pinned, 'published', a.id, now() - s.position * interval '1 minute'
from (select array_agg(id order by code) ids from companies) c,
     (select person_id id from role_grants where role_key = 'super_admin' and revoked_at is null and valid_from <= now() and (expires_at is null or expires_at > now()) order by valid_from limit 1) a,
     (values
('announcement', 'Welcome to your Hub: start here', 'Your guide to the staff platform: one place for your working day, your development and the teams you work with.', 'Welcome to the Hub. This is our shared staff platform for organising work, keeping professional records up to date and staying connected across Valor Housing, Wellbeing Homes and Wellbeing Housing.

Find your way around

Start with My Day to see the work that needs your attention. Use the calendar and visit records to organise activity, People to find colleagues, and Properties to find the locations you work with. Training, development and policy pages help you keep track of learning and responsibilities. Chat and News & updates keep everyday communication together.

What you see depends on your role

Your account can belong to more than one organisation. Check the selected company before adding a record. Your role and access determine which pages and actions are available; colleagues may see different options. If an organisation, property or feature is missing, ask your manager or an administrator to check your access.

Start with the essentials

Open your profile and check your name, contact details and current roles. Agree your priorities with your manager, review assigned tasks and training, and read the policies relevant to your work. The other welcome guides on this page walk through these steps.

Keep the right information in the right place

Use the designated support system for resident case notes and confidential support records. Keep resident details out of News and Chat. A message or news post does not replace a formal report, an approval or a required record.

Need a hand?

Ask your manager for help with work priorities and local processes. Ask an administrator about account access or incorrect organisation details. When reporting a technical issue, say which page you were using and what happened, without including confidential information.', 'welcome', 'Illustration of colleagues exploring the staff Hub together around a laptop.', true, 0),
('update', 'Your first week: make the Hub yours', 'Check your profile, confirm your organisation and agree your first priorities with your manager.', 'A few checks at the start will help you use the Hub confidently and make it easier for colleagues to work with you.

Check your account and organisation

If you joined through self-sign-up, verify your email and wait for administrator approval before expecting staff access. Signing up does not grant an organisation role automatically. Once you are in, check your current organisation and roles. Tell your manager if anything looks wrong.

Update your profile

Open your profile and check your contact information. Add a suitable profile photo if you want colleagues to recognise you. Review the skills and documents sections and keep relevant professional evidence current. Only upload documents requested for your work, and check who can access them.

Set your availability

Keep your usual working hours and availability accurate where these options are available to you. Discuss changes with your manager so that planning reflects the time you can actually work. A profile update does not replace your organisation''s process for agreeing leave or changes to working arrangements.

Share your story if you choose

My story is an optional space to introduce your background, interests and motivation. Choose the visibility setting that feels right for you. You do not need to share personal or sensitive experiences to complete your induction.

Agree your first priorities

Review your tasks, required policies and learning with your manager. Confirm which properties or teams you support, who to contact for day-to-day questions and how concerns should be raised. If something important is missing from the Hub, ask for it to be checked rather than creating a duplicate account.

Protect your sign-in

Use a unique password of at least eight characters. Keep verification and reset links private. If your role requires multi-factor authentication, complete the setup and keep your recovery information secure.', 'welcome', 'Illustration of colleagues exploring the staff Hub together around a laptop.', false, 1),
('operations', 'Your working day: visits, tasks and useful records', 'Plan your day, record what actually happened and leave clear information for the next colleague.', 'The Hub helps turn a busy working day into a clear record of what was planned, what happened and what still needs attention.

Start with My Day

Review your upcoming work, open tasks and any items needing a response. Check the calendar for timing and confirm the organisation and property before opening or adding a visit. Ask your manager about anything that overlaps or looks unfamiliar.

Record the work you actually did

Use the visit record for the correct activity and location. Enter accurate start and finish times and describe the work factually. Do not copy planned hours into a completed record if the actual times were different. Check that your changes have saved and look at the resulting status; some activities need review.

Make notes useful to the next person

Explain the action taken, any outstanding issue and the next step. Keep language clear and professional. Put confidential resident case notes in the designated support system. Avoid including personal information in general property notes, photos or task titles.

Use photos with care

Where a photo is useful and permitted, show the relevant condition or completed work. Check the background for people, names, letters, screens and other identifying details before uploading. Follow your organisation''s photography and information-handling procedures.

Give tasks a clear next step

Check the responsible person, due date and property or company context. Update the task when progress changes and close it only when the work is complete. If you cannot finish on time, tell the responsible manager and record what is outstanding.

Before you finish

Check that visits, notes and evidence are saved, outstanding tasks have an owner, and anything urgent has been reported through the appropriate process. A saved record helps colleagues pick up the work without having to guess.', 'daily-work', 'Illustration of housing colleagues checking a tablet outside a property.', false, 2),
('training', 'Learning and policies: build a clear development record', 'Find assigned learning, keep evidence current and discuss the support you need to work confidently.', 'Your learning record helps you and your manager understand what you have completed, what is due and where further support would help.

Review your learning

Open Training and the development sections available on your profile. Review assigned learning, current progress and any due dates shown. Confirm with your manager which requirements apply to your role. Requirements and refresher arrangements can differ between roles and organisations.

Keep evidence together

Upload relevant certificates or evidence in the appropriate learning or document section. Check that the file is readable and shows the right course, person and completion date. Avoid uploading unrelated personal documents. If evidence needs review, check its status rather than assuming that an upload means it has been accepted.

Record continuing development

Use CPD and development records to capture useful learning, reflection and agreed next steps where available. Explain what you learned and how it relates to your work. Discuss gaps, confidence and opportunities to practise with your manager.

Read the current policy

Use the policy pages to find the version relevant to your organisation and role. Read the document before acknowledging it. If a section is unclear or you cannot access the file, ask for help before recording an acknowledgement.

Completion and competence

A completed course or an acknowledgement records a step in your learning. Your manager can help confirm any supervision, assessment or practical experience needed for the work you are being asked to do.

Make it part of your routine

Check learning and policy tasks regularly, keep evidence current and raise access problems early. Agree realistic priorities with your manager if several requirements are due together.', 'learning', 'Illustration of colleagues learning together with workbooks and a laptop.', false, 3),
('update', 'Stay connected: Chat, News and asking for help', 'Choose the right channel, write clearly and keep confidential information in the systems intended for it.', 'The Hub brings everyday staff communication closer to the work. Choosing the right place for an update helps colleagues find it and act on it.

Use Chat for everyday coordination

Chat can support one-to-one and group conversations with colleagues. Check the participants before posting, keep messages professional and share only information appropriate for everyone in that conversation. Use clear descriptions so that colleagues understand the action or question.

Use News for shared guidance

News & updates is the place for welcome guides, team announcements, policy updates and useful learning information. Read the full article when a summary is relevant to you. Publishers should check the audience, wording and images before sharing a post.

Keep records in their proper place

A chat message does not update a visit, complete a task or approve a record. Make the change on the relevant page as well. Keep resident case notes and confidential support information in the designated support system, not in News or Chat.

Do not rely on a message for urgent action

Follow your organisation''s established reporting and escalation procedures for urgent concerns. News and Chat may not be read immediately. Know who to contact and which reporting process your team uses before you need it.

Ask for the right help

For work priorities, responsibilities or local procedures, speak to your manager. For account access and organisation membership, contact an administrator. For a technical issue, explain the page, the action you tried and the error shown. Remove personal or confidential information from screenshots.

Stay considerate

Keep group messages relevant, make requests clear and allow for colleagues'' working hours. Use the formal record or agreed process when a decision needs to be documented.', 'welcome', 'Illustration of colleagues exploring the staff Hub together around a laptop.', false, 4),
('operations', 'Working well together: quality, ownership and support', 'Understand how shared records, clear responsibilities and regular conversations help the team work well.', 'The Hub works best when records are accurate, responsibilities are clear and people feel able to ask for help.

Know your responsibilities

Check the roles shown on your profile and confirm your remit with your manager. Having access to a page does not tell you everything about your responsibilities. Agree what you are expected to record, review or approve and which decisions need someone else''s authorisation.

Keep property information useful

Before working at a property, check the relevant record and current tasks available to you. Add factual updates in the right place and flag incorrect information so it can be corrected. Use approved processes for reporting repairs, hazards or other concerns; a general note may not trigger a response.

Keep evidence understandable

Good evidence explains what happened, when it happened and what remains to be done. Use clear descriptions, accurate dates and relevant attachments. Avoid duplicate records and unnecessary personal information.

Make reviews a conversation

Use development, feedback and review features available to your role to prepare for discussions with your manager. Bring examples, questions and ideas. A record supports the conversation; it does not replace the support and decisions you need from people.

Ask early when something is wrong

If the wrong organisation or role is attached to your account, ask an administrator to correct it. If you cannot see work you expect, explain what is missing. If a task is outside your experience or you need guidance, speak to your manager before proceeding.

Keep improving the Hub

Share useful feedback about unclear steps or information that is hard to find. Tell the team what you were trying to do and what would have helped. Clear feedback and reliable records make the platform more useful for everyone.', 'daily-work', 'Illustration of housing colleagues checking a tablet outside a property.', false, 5)
     ) s(category, title, summary, body, cover, alt, pinned, position)
where c.ids is not null;


# Record completeness

Run `npx tsx --env-file-if-exists=.env scripts/audit-records.ts VH` against the intended database to list missing source attachments, broken file references, missing policy dates and incomplete review/supervision sections. Omit the company code to audit every company. This command opens a read-only transaction and outputs record IDs and missing field names, without staff notes or document contents.

The audit detects completeness, not factual accuracy or legal compliance. Compare records to the supplied source documents and actual session notes. A draft may legitimately be unfinished. A policy with readable chapters can be valid without an original attachment; attaching the original improves source traceability.

Policy attachments accept PDF and Word `.docx` files. Attaching a source preserves its readable chapters and draft status. An independent authorised approver must approve the policy; source approval wording does not create a Hub publication or staff acknowledgement. Approved policy versions cannot be replaced in place.

Reviews require objectives, achievements, development and feedback before publication, and their reporting period must have ended. Supervision requires an agenda and shared notes and cannot be completed before the session date. Drafts allow preparation before those conditions are met. Staff cannot view or acknowledge their own unpublished review even if they also hold a management role.

Never invent attendance, staff reflections, training certificates, approval decisions, signatures or outcomes to clear audit findings. Preserve published records and use an attributed follow-up action or a new draft when further facts arrive. Confirm ambiguous company appointments, staff aliases and property addresses before linking historical records.

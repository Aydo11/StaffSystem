# Valor workbook import review

Updated 24 October 2026 after the director explicitly confirmed that both workbooks contain actual records and that the sample labels remained from the template. This confirmation supersedes the earlier classification based on the labels. Original source labels are retained for provenance.

Migration 028 imports the supplied 15-property register and its stated 75 bed spaces. This is a subset, not a full-portfolio or August occupancy claim. It does not change existing records or import access codes.

Migration 029 publishes three monthly source summaries. Counts from the meetings workbook and KPI tracker remain separate because identifiers and coverage differ. They must not be added together. October tracker figures are partial (report date 9 October); activity records run through 23 October. No October monthly support-hours figure was supplied.

The meetings workbook contains 27 meetings, 65 decisions, 63 actions, 113 support activities, 68 maintenance jobs and 96 property visits from August. The history importer handles meetings/attendance, decisions, meeting actions and repairs, using actual occurrence dates and current entry dates. Preview is the default and apply runs in one transaction. Deterministic source IDs prevent duplicate imports.

Source minutes marked approved retain that fact in their text but require review because approval identity/time were not supplied. Completed actions and repairs retain source completion details without inventing independent verification. Unmatched decision authorisers and properties are flagged instead of substituted. No staff accounts are created.

Support-activity outcomes/resident identifiers remain in the original private workbook. They are not posted to News or Chat or converted into timed visits: exact start/end timestamps are missing. Aggregate support minutes are reported as source totals. Property visits likewise lack the start/end data required by the visit recorder.

Staff S-xx IDs in the KPI tracker must be mapped to actual people before training or employment checks can be imported. Do not infer identities or grant permissions from job titles.

Nine rent references are effective 5 October 2026; six give 2026/27 without an exact start date. They do not establish August rates. Budgets and blank actual-input cells are not receipts, spend or completed financial results.

Raw workbook data and extracted personal information stay outside git. Run the importer with the private extracted meetings JSON and an existing authorised administrator UUID. Preview and resolve mappings before applying to production.

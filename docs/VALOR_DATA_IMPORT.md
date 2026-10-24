# Valor workbook import review

Reviewed 24 October 2026 for the request to populate StaffSystem from August.

`Valor_Housing_KPI_Operations_Tracker_Updated.xlsm` explicitly describes the operational logs as illustrative. The KPI Scorecard and Monthly Trends say the records are fictional. The Properties and Rent Allocations sections separately describe a verified register and reference budgets. That classification comes from the workbook; the underlying PDFs were not independently inspected.

Migration 028 imports only 15 property identities and the source register's stated 75 bed spaces. These are a supplied subset, not a claim about Valor's full portfolio or August occupancy. Bed-space counts remain source notes; no room identifiers are invented. Existing properties match by reference or normalised street and postcode and are never overwritten.

Excluded: sample tenant records, support hours, outcomes, repairs, incidents, complaints, voids, key details, inspection results, training/compliance claims, actual income and expenditure. No historical visits, approved minutes, attendance, decisions or KPI results are created.

Nine rent references are effective 5 October 2026. Six state 2026/27 without an exact start date. None establishes an August rate. Rates are not imported as receipts, expenditure or historical cash flow. Budget inputs are distinct from actual results.

`Valor_Housing_Meetings_Sample_Data_Aug-Oct_2026.xlsx` labels its records fictional and says not to use them as audit, board, BVSC or funder evidence. None of its meetings, attendance, decisions, actions, support activities, maintenance or visits is imported into live operational tables.

To import actual August-onwards history, obtain the genuine dated source records. Preserve occurrence dates separately from entry dates; retain source references and actual approval status. Do not use the sample data's names, dates or outcomes to fill gaps.

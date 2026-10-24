-- Import the eight Wellbeing Housing properties supplied on 22 October 2026.
-- Preserve the source approval state. Counts are source notes, not verified evidence.
alter table properties drop constraint properties_status_check;
alter table properties add constraint properties_status_check
  check (status in ('active', 'awaiting_approval', 'void', 'under_works', 'offboarded'));

-- No existing property is overwritten. Match within the same company by reference
-- or normalised street address and postcode; repeated runs do not duplicate rows.
insert into properties (company_id, ref, name, address_line1, address_line2, city, postcode, status, notes)
select c.id, s.ref, s.street, s.street, nullif(s.locality, ''), 'Birmingham', s.postcode, s.status, s.notes
from companies c
cross join (values
('WHS-45-WHITMORE', '45 Whitmore Street', '', 'B18 5BP', 'awaiting_approval', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 45 WHITMORE STREET, BIRMINGHAM B18 5BP.
Council: Birmingham City Council. Property group: SEA. Property type: Shared.
Source status: Awaiting Approval. Active rooms: 3; inactive rooms: 0; rooms allowed: 3.
Source reports 17 certificates and 1 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 15-Sep-2026 15:30; last updated: 13-Oct-2026 12:56 by AKIRANK1.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-62-LANSDOWNE', '62 Lansdowne Road', '', 'B21 9AT', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 62 LANSDOWNE ROAD, LOZELLS AND EAST HANDSWORTH B21 9AT.
Council: Birmingham City Council. Property group: SEA. Property type: Ensuite.
Source status: Active. Active rooms: 6; inactive rooms: 0; rooms allowed: 6.
Source reports 20 certificates and 0 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 03-Jun-2026 11:26; last updated: 12-Oct-2026 10:44 by MAJMALA.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-60-MURDOCK', '60 Murdock Road', '', 'B21 9LQ', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 60 MURDOCK ROAD, BIRMINGHAM B21 9LQ.
Council: Birmingham City Council. Property group: SEA. Property type: not supplied.
Source status: Active. Active rooms: 7; inactive rooms: 0; rooms allowed: 7.
Source reports 20 certificates and 3 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 27-Mar-2026 15:11; last updated: 12-Oct-2026 10:33 by MAJMALA.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-28-RIDGEWAY', '28 Ridgeway', 'Harborne', 'B17 8JA', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 28 RIDGEWAY, HARBORNE, BIRMINGHAM B17 8JA.
Council: Birmingham City Council. Property group: SEA. Property type: SC-Shared.
Source status: Active. Active rooms: 6; inactive rooms: 0; rooms allowed: 6.
Source reports 20 certificates and 3 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 14-Jul-2026 11:29; last updated: 12-Oct-2026 08:37 by PBARIBA.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-52-SHENSTONE', '52 Shenstone Road', 'Soho', 'B16 0NT', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 52 SHENSTONE ROAD, SOHO, BIRMINGHAM B16 0NT.
Council: Birmingham City Council. Property group: SEA. Property type: SC-Shared.
Source status: Active. Active rooms: 6; inactive rooms: 0; rooms allowed: 6.
Source reports 20 certificates and 0 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 03-Jun-2026 11:52; last updated: 12-Oct-2026 08:27 by MAJMALA.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-177-HEATH', '177 Heath Street', '', 'B18 4DA', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 177 Heath Street, Birmingham B18 4DA.
Council: Birmingham City Council. Property group: SEA. Property type: Shared.
Source status: Active. Active rooms: 3; inactive rooms: 0; rooms allowed: 3.
Source reports 20 certificates and 0 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 03-Jun-2026 09:50; last updated: 10-Oct-2026 10:39 by MAJMALA.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-10-RAVENSDALE', '10 Ravensdale Road', '', 'B10 9HU', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 10 RAVENSDALE ROAD, BIRMINGHAM B10 9HU.
Council: Birmingham City Council. Property group: SEA. Property type: not supplied.
Source status: Active. Active rooms: 4; inactive rooms: 0; rooms allowed: 4.
Source reports 20 certificates and 1 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 09-Apr-2026 10:27; last updated: 10-Oct-2026 08:53 by MAJMALA.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.'),
('WHS-223-HUBERT', '223 Hubert Road', '', 'B29 6ES', 'active', 'Imported from properties_list_221026_1817.csv (22 October 2026).
Source organisation: WELLBEING HOUSING LTD. Source address: 223 HUBERT ROAD, BIRMINGHAM B29 6ES.
Council: Birmingham City Council. Property group: SEA. Property type: Shared.
Source status: Active. Active rooms: 6; inactive rooms: 0; rooms allowed: 6.
Source reports 20 certificates and 0 maintenance items; supporting documents and item details were not included in this export and have not been verified or created.
Source created: 17-Aug-2026 21:47; last updated: 06-Oct-2026 12:08 by ACONCIERGE.
Room identifiers and occupancy details were not supplied; no room labels or resident records have been invented.')
) s(ref, street, locality, postcode, status, notes)
where c.code = 'WHS'
and not exists (
  select 1 from properties p where p.company_id = c.id
  and (upper(p.ref) = upper(s.ref)
    or (regexp_replace(upper(p.postcode), '[^A-Z0-9]', '', 'g') = regexp_replace(upper(s.postcode), '[^A-Z0-9]', '', 'g')
      and (regexp_replace(lower(split_part(p.address_line1, ',', 1)), '[^a-z0-9]', '', 'g') = regexp_replace(lower(s.street), '[^a-z0-9]', '', 'g')
        or regexp_replace(lower(split_part(p.name, ',', 1)), '[^a-z0-9]', '', 'g') = regexp_replace(lower(s.street), '[^a-z0-9]', '', 'g'))))
)
on conflict (company_id, ref) do nothing;


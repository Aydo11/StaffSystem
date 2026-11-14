-- Support hours for 31 Oct–13 Nov 2026, added at the owner's request (14 Nov 2026): staff worked their usual weekly hours
-- but had not yet learned to log them. Same mechanism as migration 030 (entry mode `schedule`, approved, idempotent;
-- a day someone already logged a visit or was on approved leave is skipped).
-- The owner's weekly pattern; a day's hours are split evenly across that person's properties, placed one after another.
-- Natalie: 4h Mon, Tue, Wed (12h a week, owner confirmed 12). Phillip: Mon 5, Tue 6, Wed 5, Thu 4, Fri 5, one property a day.
-- Daniel: Wed 6, Thu 5, Fri 2. Mubashir: Mon, Tue, Wed 4, Thu 1. Everyone else: their weekly hours on Monday.
-- Petrina Morgan, Aji Bajen and Florent: no hours given, nothing added.
select sum(add_schedule_visits(name, ref, dow, minutes, slot, date '2026-10-31', date '2026-11-13'))
from (values
  ('Natalie Clark', 'VH-MURDOCK-62', 1, 120, 0), ('Natalie Clark', 'VH-GROVE-119', 1, 120, 120),
  ('Natalie Clark', 'VH-MURDOCK-62', 2, 120, 0), ('Natalie Clark', 'VH-GROVE-119', 2, 120, 120),
  ('Natalie Clark', 'VH-MURDOCK-62', 3, 120, 0), ('Natalie Clark', 'VH-GROVE-119', 3, 120, 120),
  ('Phil smith', 'VH-CLARENCE-11', 1, 300, 0), ('Phil smith', 'VH-OXHILL-203', 2, 360, 0), ('Phil smith', 'VH-SHELDON-177', 3, 300, 0),
  ('Phil smith', 'VH-FARMER-52', 4, 240, 0), ('Phil smith', 'VH-FOXWELL-8', 5, 300, 0),
  ('Daniel Wasowicz', 'VH-CHURCH-32', 3, 120, 0), ('Daniel Wasowicz', 'VH-JAC1', 3, 120, 120), ('Daniel Wasowicz', 'VH-JAC2', 3, 120, 240),
  ('Daniel Wasowicz', 'VH-CHURCH-32', 4, 100, 0), ('Daniel Wasowicz', 'VH-JAC1', 4, 100, 100), ('Daniel Wasowicz', 'VH-JAC2', 4, 100, 200),
  ('Daniel Wasowicz', 'VH-CHURCH-32', 5, 40, 0), ('Daniel Wasowicz', 'VH-JAC1', 5, 40, 40), ('Daniel Wasowicz', 'VH-JAC2', 5, 40, 80),
  ('Mubashir Chikhliwala', 'VH-CROMPTON-33', 1, 80, 0), ('Mubashir Chikhliwala', 'VH-DAVEY-96', 1, 80, 80), ('Mubashir Chikhliwala', 'VH-ARTHUR-6', 1, 80, 160),
  ('Mubashir Chikhliwala', 'VH-CROMPTON-33', 2, 80, 0), ('Mubashir Chikhliwala', 'VH-DAVEY-96', 2, 80, 80), ('Mubashir Chikhliwala', 'VH-ARTHUR-6', 2, 80, 160),
  ('Mubashir Chikhliwala', 'VH-CROMPTON-33', 3, 80, 0), ('Mubashir Chikhliwala', 'VH-DAVEY-96', 3, 80, 80), ('Mubashir Chikhliwala', 'VH-ARTHUR-6', 3, 80, 160),
  ('Mubashir Chikhliwala', 'VH-CROMPTON-33', 4, 20, 0), ('Mubashir Chikhliwala', 'VH-DAVEY-96', 4, 20, 20), ('Mubashir Chikhliwala', 'VH-ARTHUR-6', 4, 20, 40),
  ('Do Kieu', 'VH-RICKYARD-26', 1, 300, 0),
  ('Miraj Ali', 'VH-CHERRY-82', 1, 300, 0),
  ('Sunny Johal', 'VH-HOLLIDAY-106', 1, 360, 0),
  ('Marc Ganza', 'VH-HAGLEY-179A', 1, 270, 0), ('Marc Ganza', 'VH-SHA005', 1, 270, 270),
  ('Thania Begum', 'VH-WEST-227', 1, 240, 0),
  ('Elina Veismane', 'VH-LUDLOW-37', 1, 240, 0)
) as t(name, ref, dow, minutes, slot);

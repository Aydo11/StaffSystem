-- One person cannot be in two places at once: the database refuses overlapping live visits,
-- so two simultaneous requests cannot both pass the check-then-write in the API (audit finding 5).
alter table visits add constraint visits_no_overlap
  exclude using gist (person_id with =, tstzrange(started_at, coalesce(ended_at, 'infinity')) with &&)
  where (status not in ('cancelled', 'rejected'));

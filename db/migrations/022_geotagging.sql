-- Where each property is (from its postcode, or set by hand), and where staff were when they started and finished a visit.
-- Location is taken only at the moment Start or Finish is pressed, never continuously. A refused location is recorded as null.
alter table properties add column latitude double precision check (latitude between -90 and 90);
alter table properties add column longitude double precision check (longitude between -180 and 180);
alter table properties add column location_source text check (location_source in ('postcode','manual'));

alter table visits add column start_lat double precision check (start_lat between -90 and 90);
alter table visits add column start_lng double precision check (start_lng between -180 and 180);
alter table visits add column start_accuracy_m int check (start_accuracy_m >= 0);
alter table visits add column start_distance_m int check (start_distance_m >= 0);   -- from the property, when both are known
alter table visits add column finish_lat double precision check (finish_lat between -90 and 90);
alter table visits add column finish_lng double precision check (finish_lng between -180 and 180);
alter table visits add column finish_accuracy_m int check (finish_accuracy_m >= 0);
alter table visits add column finish_distance_m int check (finish_distance_m >= 0);

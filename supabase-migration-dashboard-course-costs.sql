alter table usage_events
  alter column course_id type varchar(120)
  using course_id::text;

create index if not exists idx_usage_events_course_id_created_at
  on usage_events(course_id, created_at desc);

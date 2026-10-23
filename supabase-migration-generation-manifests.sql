set lock_timeout = '5s';

create table if not exists public.course_generation_manifests (
  id                      serial primary key,
  course_id               integer not null references public.courses(id) on delete cascade,
  blueprint_id            integer not null,
  rules_version           integer not null check (rules_version >= 1),
  manifest_schema_version integer not null default 1,
  manifest_json           jsonb   not null,
  manifest_sha256         char(64) not null,
  blueprint_sha256        char(64) not null,
  module_count            integer not null check (module_count >= 1),
  chapter_count           integer not null check (chapter_count >= 1),
  content_count           integer not null check (content_count >= 1),
  scorm_count             integer not null check (scorm_count >= 1),
  video_count             integer not null check (video_count >= 0),
  exam_count              integer not null check (exam_count >= 0),
  total_jobs              integer not null check (total_jobs >= 2),
  created_at              timestamptz not null default now(),
  created_by              varchar(36),
  constraint cgm_blueprint_fk foreign key (blueprint_id, course_id)
    references public.course_blueprints (id, course_id) on delete cascade,
  constraint cgm_blueprint_rules_key unique (blueprint_id, rules_version),
  constraint cgm_counts_consistent check (
    content_count = chapter_count and scorm_count = chapter_count
    and video_count <= chapter_count and exam_count <= module_count
    and total_jobs = content_count + scorm_count + video_count + exam_count)
);
create index if not exists idx_cgm_course on public.course_generation_manifests(course_id);

create or replace function public.course_generation_manifests_forbid_update() returns trigger
language plpgsql as $$
begin
  raise exception 'course_generation_manifests es inmutable (id=%)', old.id using errcode = 'P0001';
end $$;

drop trigger if exists course_generation_manifests_immutable on public.course_generation_manifests;
create trigger course_generation_manifests_immutable before update on public.course_generation_manifests
  for each row execute function public.course_generation_manifests_forbid_update();

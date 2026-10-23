-- SOLO TESTS LOCALES: filas V2 sembradas para scripts/ops/v2-health-report.js.
-- Se aplica DESPUÉS del runner (tablas V2 ya creadas). Valores esperados en
-- run-local-pg-tests.js: 6 items fallidos 24h, 1 lease vencido de item + 1 de
-- job, 1 fallo dynamic_package + 1 run con 2 empaquetados activos, 1 run
-- activo hace 8h, Videogen real $20 (24h) / $35 (7d) con 3 videos (1 sin
-- costo) y tarifa $10/video, 3 GiB de artifacts dynamic.
do $$
declare
  v_course int;
  v_bp int;
  v_man int;
  v_run uuid;
  v_mod uuid := gen_random_uuid();
  v_ch uuid := gen_random_uuid();
  i int;
  v_item uuid;
begin
  insert into public.courses (owner_id, title, structure_version)
    values ('00000000-0000-0000-0000-00000000bbbb', 'Curso dynamic (health)', 'dynamic') returning id into v_course;
  insert into public.course_blueprints (course_id, blueprint_number, snapshot_json, snapshot_sha256, structure_counter_at_lock, module_count, chapter_count)
    values (v_course, 1, '{}', repeat('a', 64), 1, 1, 1) returning id into v_bp;
  insert into public.course_generation_manifests (course_id, blueprint_id, rules_version, manifest_json, manifest_sha256, blueprint_sha256,
      module_count, chapter_count, content_count, scorm_count, video_count, exam_count, total_jobs)
    values (v_course, v_bp, 1, '{}', repeat('b', 64), repeat('a', 64), 1, 1, 1, 1, 1, 1, 4) returning id into v_man;

  -- Run activo hace 8 h con lease de job vencido hace 30 min.
  insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload, lease_until, created_at)
    values ('00000000-0000-0000-0000-00000000bbbb', v_course, 'dynamic_generation', 'running', 'running',
            jsonb_build_object('manifestId', v_man::text), now() - interval '30 minutes', now() - interval '8 hours')
    returning id into v_run;

  -- dynamic_package: 1 fallido hace 1 h + 2 activos para el mismo run (M9).
  insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload, error_message, updated_at)
    values ('00000000-0000-0000-0000-00000000bbbb', v_course, 'dynamic_package', 'failed', 'failed',
            jsonb_build_object('runId', v_run::text), 'mbz build failed: boom', now() - interval '1 hour');
  insert into public.production_jobs (owner_id, course_id, execution_mode, status, worker_status, input_payload)
    values ('00000000-0000-0000-0000-00000000bbbb', v_course, 'dynamic_package', 'queued', 'queued', jsonb_build_object('runId', v_run::text)),
           ('00000000-0000-0000-0000-00000000bbbb', v_course, 'dynamic_package', 'queued', 'queued', jsonb_build_object('runId', v_run::text));

  -- 6 items fallidos en 24 h (3 content, 3 scorm) + 1 fallido hace 3 días (fuera de ventana).
  for i in 1..3 loop
    insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
        status, error, idempotency_key, finished_at)
      values (v_run, v_course, v_bp, v_man, 'content:c' || i, 1, 'content', v_mod, v_ch, 'failed',
              'llm_timeout req 0123456789abcdef0123', md5('c' || i) || md5('c' || i || 'x'), now() - interval '2 hours');
    insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
        status, error, idempotency_key, finished_at)
      values (v_run, v_course, v_bp, v_man, 'scorm:c' || i, 1, 'scorm', v_mod, v_ch, 'failed',
              'invalid_json', md5('s' || i) || md5('s' || i || 'x'), now() - interval '3 hours');
  end loop;
  insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
      status, error, idempotency_key, finished_at, updated_at)
    values (v_run, v_course, v_bp, v_man, 'content:old', 1, 'content', v_mod, v_ch, 'failed', 'old', md5('old') || md5('oldx'),
            now() - interval '3 days', now() - interval '3 days');

  -- Item video 'running' con lease vencido hace 20 min.
  insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
      status, worker_id, lease_until, idempotency_key)
    values (v_run, v_course, v_bp, v_man, 'video:stuck', 1, 'video', v_mod, v_ch, 'running', 'exec-1',
            now() - interval '20 minutes', md5('vs') || md5('vsx'));

  -- Videos reales completados: $20 hace 1 h, $15 hace 2 días, 1 sin costUsd hace 3 días; 1 mock (no cuenta).
  insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
      status, idempotency_key, output_summary, finished_at)
    values (v_run, v_course, v_bp, v_man, 'video:r1', 1, 'video', v_mod, v_ch, 'completed', md5('r1') || md5('r1x'),
            '{"mode":"real","costUsd":20}', now() - interval '1 hour')
    returning id into v_item;
  insert into public.generation_item_runs (job_id, course_id, blueprint_id, manifest_id, item_key, generation, type, module_id, chapter_id,
      status, idempotency_key, output_summary, finished_at)
    values (v_run, v_course, v_bp, v_man, 'video:r2', 1, 'video', v_mod, v_ch, 'completed', md5('r2') || md5('r2x'),
            '{"mode":"real","costUsd":15.0}', now() - interval '2 days'),
           (v_run, v_course, v_bp, v_man, 'video:r3', 1, 'video', v_mod, v_ch, 'completed', md5('r3') || md5('r3x'),
            '{"mode":"real","costUsd":null}', now() - interval '3 days'),
           (v_run, v_course, v_bp, v_man, 'video:m1', 1, 'video', v_mod, v_ch, 'completed', md5('m1') || md5('m1x'),
            '{"mode":"mock","costUsd":0}', now() - interval '1 hour');

  insert into public.cost_rates (provider, service, model, unit_type, rate_usd, is_active)
    values ('video_engine', 'video_generation', null, 'per_video', 10, true);

  -- 3 GiB de artifacts dynamic (1 vinculado a un item run, 1 solo a manifest) + 1 legacy (no cuenta).
  insert into public.artifacts (owner_id, course_id, type, storage_path, size_bytes, manifest_id, item_run_id)
    values ('00000000-0000-0000-0000-00000000bbbb', v_course::text, 'dynamic_video', 'u/dynamic/v.json', 1073741824, v_man, v_item),
           ('00000000-0000-0000-0000-00000000bbbb', v_course::text, 'dynamic_mbz', 'u/dynamic/c.mbz', 2147483648, v_man, null);

  insert into public.usage_events (user_id, event_type, component, cost_type, real_cost_usd)
    values ('00000000-0000-0000-0000-00000000bbbb', 'video_job_completed', 'video', 'real', 3.5);
end $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SCHEMA_SUPABASE.sql — Esquema completo para Cursia Backend en Supabase
-- ══════════════════════════════════════════════════════════════════════════════
-- Ejecutar en: Supabase Dashboard → SQL Editor → pegar todo → Run
--
-- Versión: 1.1 (corregido — idempotente, incluye ALTER TABLE)
-- Tablas:  courses, course_versions, youtube_connections,
--          usage_events, cost_rates, traditional_cost_benchmarks
--
-- IDEMPOTENTE:
--   • CREATE TABLE IF NOT EXISTS  → seguro si la tabla no existe
--   • ALTER TABLE ADD COLUMN IF NOT EXISTS → seguro si la tabla ya existe
--     pero le faltan columnas (caso de primer run parcial o schema anterior)
--   • CREATE INDEX IF NOT EXISTS  → seguro siempre
--   • INSERT … ON CONFLICT DO NOTHING → seguro para seed data
--
-- ══════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 0 — ROLLBACK (DESCOMENTARY SOLO SI NECESITAS EMPEZAR DE CERO)
-- ════════════════════════════════════════════════════════════════════════════
-- Si el primer intento falló a medias y quieres limpiar todo:
-- 1. Descomenta las líneas DROP debajo
-- 2. Ejecuta solo esa sección en SQL Editor
-- 3. Vuelve a ejecutar el script completo desde la Sección 1
--
-- ADVERTENCIA: esto borra todos los datos. Solo usar en una DB vacía/de prueba.
--
-- DROP TABLE IF EXISTS usage_events              CASCADE;
-- DROP TABLE IF EXISTS course_versions           CASCADE;
-- DROP TABLE IF EXISTS youtube_connections       CASCADE;
-- DROP TABLE IF EXISTS cost_rates               CASCADE;
-- DROP TABLE IF EXISTS traditional_cost_benchmarks CASCADE;
-- DROP TABLE IF EXISTS courses                   CASCADE;
--
-- ════════════════════════════════════════════════════════════════════════════


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 1 — courses
-- Entidad: src/modules/courses/entities/course.entity.ts
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS courses (
  id                  SERIAL         PRIMARY KEY,
  owner_id            VARCHAR(36),                          -- UUID Supabase auth.users.id
  owner_email         VARCHAR(255),
  title               VARCHAR(255)   NOT NULL,
  description         TEXT,
  sector              VARCHAR(100),
  level               VARCHAR(100),
  status              VARCHAR(50)    NOT NULL DEFAULT 'draft',
  metadata            JSONB,
  storage_provider    VARCHAR(50),
  storage_folder_id   TEXT,
  storage_folder_url  TEXT,
  created_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

-- Si la tabla ya existía con un schema anterior (sin estas columnas), las agrega:
ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_id           VARCHAR(36);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS owner_email        VARCHAR(255);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS description        TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS sector             VARCHAR(100);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS level              VARCHAR(100);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS status             VARCHAR(50) NOT NULL DEFAULT 'draft';
ALTER TABLE courses ADD COLUMN IF NOT EXISTS metadata           JSONB;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS storage_provider   VARCHAR(50);
ALTER TABLE courses ADD COLUMN IF NOT EXISTS storage_folder_id  TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS storage_folder_url TEXT;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE courses ADD COLUMN IF NOT EXISTS updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_courses_owner_id ON courses (owner_id);


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 2 — course_versions
-- Entidad: src/modules/course-versions/entities/course-version.entity.ts
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS course_versions (
  id                    SERIAL        PRIMARY KEY,
  course_id             INT           NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version_number        INT           NOT NULL DEFAULT 1,
  status                VARCHAR(50)   NOT NULL DEFAULT 'draft',
  notes                 TEXT,
  snapshot_json         JSONB,
  storage_provider      VARCHAR(50),
  storage_file_id       TEXT,
  storage_file_url      TEXT,
  storage_folder_id     TEXT,
  storage_path          TEXT,
  snapshot_strategy     VARCHAR(50),
  snapshot_size_bytes   BIGINT,
  snapshot_size_human   VARCHAR(30),
  manifest_json         JSONB,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS notes               TEXT;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS snapshot_json       JSONB;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS storage_provider    VARCHAR(50);
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS storage_file_id     TEXT;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS storage_file_url    TEXT;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS storage_folder_id   TEXT;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS storage_path        TEXT;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS snapshot_strategy   VARCHAR(50);
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS snapshot_size_bytes BIGINT;
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS snapshot_size_human VARCHAR(30);
ALTER TABLE course_versions ADD COLUMN IF NOT EXISTS manifest_json       JSONB;

CREATE INDEX IF NOT EXISTS idx_course_versions_course_id ON course_versions (course_id);


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 3 — youtube_connections
-- Entidad: src/youtube/entities/youtube-connection.entity.ts
-- Nota: user_id es UNIQUE (un usuario = una conexión activa)
--       columna "scopes" con 's' (no "scope")
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS youtube_connections (
  id                        SERIAL        PRIMARY KEY,
  user_id                   VARCHAR(36)   NOT NULL,         -- UNIQUE: una conexión por usuario
  user_email                VARCHAR(255),
  google_subject            VARCHAR(255),
  channel_id                VARCHAR(100)  NOT NULL,
  channel_title             VARCHAR(255),
  channel_thumbnail_url     TEXT,
  encrypted_refresh_token   TEXT          NOT NULL,
  token_iv                  VARCHAR(32)   NOT NULL,
  scopes                    TEXT,                           -- "scopes" con 's'
  status                    VARCHAR(50)   NOT NULL DEFAULT 'active',
  connected_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  last_used_at              TIMESTAMPTZ,
  revoked_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS user_email             VARCHAR(255);
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS google_subject         VARCHAR(255);
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS channel_thumbnail_url  TEXT;
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS scopes                 TEXT;
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS connected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS last_used_at           TIMESTAMPTZ;
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS revoked_at             TIMESTAMPTZ;
ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Índice único en user_id (un usuario = una conexión activa)
CREATE UNIQUE INDEX IF NOT EXISTS idx_youtube_connections_user_id_unique
  ON youtube_connections (user_id);


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 4 — usage_events
-- Entidad: src/events/entities/usage-event.entity.ts
-- Nota: PK es UUID, no SERIAL — no usar esta tabla con synchronize:true
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS usage_events (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               VARCHAR(36)   NOT NULL,
  user_email            VARCHAR(255),
  event_type            VARCHAR(60)   NOT NULL,
  failed                BOOLEAN       NOT NULL DEFAULT FALSE,
  error_message         TEXT,
  tokens_input          INT,
  tokens_output         INT,
  ai_model              VARCHAR(100),
  ai_provider           VARCHAR(50),
  estimated_cost_usd    NUMERIC(12,8),
  video_job_id          VARCHAR(100),
  video_batch_id        VARCHAR(100),
  video_count           INT,
  course_id             INT,
  duration_ms           INT,
  metadata              JSONB,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS user_email          VARCHAR(255);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS failed              BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS error_message       TEXT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS tokens_input        INT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS tokens_output       INT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ai_model            VARCHAR(100);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS ai_provider         VARCHAR(50);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS estimated_cost_usd  NUMERIC(12,8);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS video_job_id        VARCHAR(100);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS video_batch_id      VARCHAR(100);
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS video_count         INT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS course_id           INT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS duration_ms         INT;
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS metadata            JSONB;

-- Índices compuestos para las queries del admin dashboard
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
  ON usage_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_type_created
  ON usage_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_id
  ON usage_events (user_id);

CREATE INDEX IF NOT EXISTS idx_usage_events_event_type
  ON usage_events (event_type);


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 5 — cost_rates
-- Entidad: src/admin/entities/cost-rate.entity.ts
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cost_rates (
  id              SERIAL        PRIMARY KEY,
  provider        VARCHAR(50)   NOT NULL,
  service         VARCHAR(80)   NOT NULL,
  model           VARCHAR(100),                             -- nullable: aplica a todo el servicio
  unit_type       VARCHAR(30)   NOT NULL,
  rate_usd        NUMERIC(12,8) NOT NULL,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  effective_from  DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE cost_rates ADD COLUMN IF NOT EXISTS model          VARCHAR(100);
ALTER TABLE cost_rates ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE cost_rates ADD COLUMN IF NOT EXISTS effective_from DATE;
ALTER TABLE cost_rates ADD COLUMN IF NOT EXISTS notes          TEXT;
ALTER TABLE cost_rates ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Índice no-único sobre provider/service/model/unit_type (para queries de lookup)
CREATE INDEX IF NOT EXISTS idx_cost_rates_lookup
  ON cost_rates (provider, service, unit_type);


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 6 — traditional_cost_benchmarks
-- Entidad: src/admin/entities/traditional-cost-benchmark.entity.ts
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS traditional_cost_benchmarks (
  id                  SERIAL        PRIMARY KEY,
  benchmark_key       VARCHAR(80)   NOT NULL UNIQUE,
  label               VARCHAR(150)  NOT NULL,
  description         TEXT,
  typical_cost_usd    NUMERIC(10,2) NOT NULL,
  unit                VARCHAR(50),
  source              VARCHAR(200),
  is_active           BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

ALTER TABLE traditional_cost_benchmarks ADD COLUMN IF NOT EXISTS description      TEXT;
ALTER TABLE traditional_cost_benchmarks ADD COLUMN IF NOT EXISTS unit             VARCHAR(50);
ALTER TABLE traditional_cost_benchmarks ADD COLUMN IF NOT EXISTS source           VARCHAR(200);
ALTER TABLE traditional_cost_benchmarks ADD COLUMN IF NOT EXISTS is_active        BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE traditional_cost_benchmarks ADD COLUMN IF NOT EXISTS updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 7 — SEED DATA
-- Tarifas y benchmarks iniciales (idempotente gracias a ON CONFLICT DO NOTHING)
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO cost_rates (provider, service, model, unit_type, rate_usd, is_active, notes)
VALUES
  ('anthropic', 'chat_completion', 'claude-opus-4-5',    'per_1k_input_tokens',  0.01500000, TRUE, 'Opus 4.5 input'),
  ('anthropic', 'chat_completion', 'claude-opus-4-5',    'per_1k_output_tokens', 0.07500000, TRUE, 'Opus 4.5 output'),
  ('anthropic', 'chat_completion', 'claude-sonnet-4-5',  'per_1k_input_tokens',  0.00300000, TRUE, 'Sonnet 4.5 input'),
  ('anthropic', 'chat_completion', 'claude-sonnet-4-5',  'per_1k_output_tokens', 0.01500000, TRUE, 'Sonnet 4.5 output'),
  ('anthropic', 'chat_completion', 'claude-haiku-3-5',   'per_1k_input_tokens',  0.00080000, TRUE, 'Haiku 3.5 input'),
  ('anthropic', 'chat_completion', 'claude-haiku-3-5',   'per_1k_output_tokens', 0.00400000, TRUE, 'Haiku 3.5 output')
ON CONFLICT DO NOTHING;

INSERT INTO traditional_cost_benchmarks (benchmark_key, label, typical_cost_usd, unit, source, description)
VALUES
  ('course_creation',         'Creación de curso completo',  2500.00, 'por curso',   'Freelance / agencias eLearning', 'Diseño instruccional + guión + revisión'),
  ('video_production_minute', 'Producción de video',          150.00, 'por minuto',  'Estudio de grabación estándar',  'Grabación, edición y post-producción'),
  ('quiz_design',             'Diseño de quiz / evaluación',   80.00, 'por quiz',    'Diseñador instruccional',        'Quiz de 10 preguntas con retroalimentación'),
  ('voiceover_minute',        'Locución profesional',           30.00, 'por minuto', 'Plataforma de locución',         'Voz grabada, editada y masterizada'),
  ('instructional_design_h',  'Diseño instruccional / hora',   75.00, 'por hora',   'Consultoría eLearning',          'Análisis, diseño y estructuración de contenido')
ON CONFLICT DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- SECCIÓN 8 — VERIFICACIÓN FINAL
-- Ejecutar esto después del script para confirmar que todo quedó bien.
-- Debe devolver 6 filas, una por tabla.
-- ════════════════════════════════════════════════════════════════════════════

SELECT
  t.table_name,
  COUNT(c.column_name) AS total_columns
FROM information_schema.tables t
JOIN information_schema.columns c
  ON c.table_name = t.table_name AND c.table_schema = t.table_schema
WHERE t.table_schema = 'public'
  AND t.table_name IN (
    'courses',
    'course_versions',
    'youtube_connections',
    'usage_events',
    'cost_rates',
    'traditional_cost_benchmarks'
  )
GROUP BY t.table_name
ORDER BY t.table_name;

-- Resultado esperado:
-- table_name                    | total_columns
-- ──────────────────────────────┼──────────────
-- cost_rates                    | 10
-- course_versions               | 16
-- courses                       | 14
-- traditional_cost_benchmarks   | 9
-- usage_events                  | 18
-- youtube_connections           | 16

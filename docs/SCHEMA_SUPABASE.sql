-- ══════════════════════════════════════════════════════════════════════════════
-- SCHEMA_SUPABASE.sql — Esquema completo para Cursia Backend en Supabase
-- ══════════════════════════════════════════════════════════════════════════════
-- Ejecutar en: Supabase Dashboard → SQL Editor
-- Orden: respetar el orden del script (FK constraints)
-- Seguro: todos los CREATE usan IF NOT EXISTS
-- ══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. courses
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS courses (
  id                  SERIAL PRIMARY KEY,
  owner_id            VARCHAR(36),
  owner_email         VARCHAR(255),
  title               VARCHAR(255) NOT NULL,
  description         TEXT,
  sector              VARCHAR(100),
  level               VARCHAR(100),
  status              VARCHAR(50) NOT NULL DEFAULT 'draft',
  metadata            JSONB,
  storage_provider    VARCHAR(50),
  storage_folder_id   TEXT,
  storage_folder_url  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_courses_owner_id ON courses (owner_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. course_versions
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS course_versions (
  id                    SERIAL PRIMARY KEY,
  course_id             INT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  version_number        INT NOT NULL DEFAULT 1,
  status                VARCHAR(50) NOT NULL DEFAULT 'draft',
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
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_course_versions_course_id ON course_versions (course_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. youtube_connections
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS youtube_connections (
  id                        SERIAL PRIMARY KEY,
  user_id                   VARCHAR(36) NOT NULL,
  user_email                VARCHAR(255),
  google_subject            VARCHAR(255),
  channel_id                VARCHAR(100) NOT NULL,
  channel_title             VARCHAR(255),
  channel_thumbnail_url     TEXT,
  encrypted_refresh_token   TEXT NOT NULL,
  token_iv                  VARCHAR(32) NOT NULL,
  scope                     TEXT,
  status                    VARCHAR(50) NOT NULL DEFAULT 'active',
  connected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at              TIMESTAMPTZ,
  revoked_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_youtube_connections_user_id ON youtube_connections (user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. usage_events
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usage_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               VARCHAR(36) NOT NULL,
  user_email            VARCHAR(255),
  event_type            VARCHAR(60) NOT NULL,
  failed                BOOLEAN NOT NULL DEFAULT FALSE,
  error_message         TEXT,
  tokens_input          INT,
  tokens_output         INT,
  ai_model              VARCHAR(100),
  ai_provider           VARCHAR(50),
  estimated_cost_usd    NUMERIC(12, 8),
  video_job_id          VARCHAR(100),
  video_batch_id        VARCHAR(100),
  video_count           INT,
  course_id             INT,
  duration_ms           INT,
  metadata              JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_id_created ON usage_events (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_event_type_created ON usage_events (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_id ON usage_events (user_id);
CREATE INDEX IF NOT EXISTS idx_usage_events_event_type ON usage_events (event_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. cost_rates
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cost_rates (
  id              SERIAL PRIMARY KEY,
  provider        VARCHAR(50) NOT NULL,
  service         VARCHAR(80) NOT NULL,
  model           VARCHAR(100),
  unit_type       VARCHAR(30) NOT NULL,
  rate_usd        NUMERIC(12, 8) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from  DATE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cost_rates_provider_service ON cost_rates (provider, service, model, unit_type);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. traditional_cost_benchmarks
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traditional_cost_benchmarks (
  id                  SERIAL PRIMARY KEY,
  benchmark_key       VARCHAR(80) NOT NULL UNIQUE,
  label               VARCHAR(150) NOT NULL,
  description         TEXT,
  typical_cost_usd    NUMERIC(10, 2) NOT NULL,
  unit                VARCHAR(50),
  source              VARCHAR(200),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: tarifas base Anthropic (ajustar según precios actuales)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO cost_rates (provider, service, model, unit_type, rate_usd, is_active, notes)
VALUES
  ('anthropic', 'chat_completion', 'claude-opus-4-5',           'per_1k_input_tokens',  0.01500000, TRUE, 'Opus 4.5 input'),
  ('anthropic', 'chat_completion', 'claude-opus-4-5',           'per_1k_output_tokens', 0.07500000, TRUE, 'Opus 4.5 output'),
  ('anthropic', 'chat_completion', 'claude-sonnet-4-5',         'per_1k_input_tokens',  0.00300000, TRUE, 'Sonnet 4.5 input'),
  ('anthropic', 'chat_completion', 'claude-sonnet-4-5',         'per_1k_output_tokens', 0.01500000, TRUE, 'Sonnet 4.5 output'),
  ('anthropic', 'chat_completion', 'claude-haiku-3-5',          'per_1k_input_tokens',  0.00080000, TRUE, 'Haiku 3.5 input'),
  ('anthropic', 'chat_completion', 'claude-haiku-3-5',          'per_1k_output_tokens', 0.00400000, TRUE, 'Haiku 3.5 output')
ON CONFLICT DO NOTHING;

INSERT INTO traditional_cost_benchmarks (benchmark_key, label, typical_cost_usd, unit, source, description)
VALUES
  ('course_creation',         'Creación de curso completo',   2500.00, 'por curso',      'Mercado freelance / agencias eLearning', 'Diseño instruccional + guión + revisión'),
  ('video_production_minute', 'Producción de video',          150.00,  'por minuto',     'Estudio de grabación estándar',          'Grabación, edición y post-producción'),
  ('quiz_design',             'Diseño de quiz/evaluación',    80.00,   'por quiz',       'Diseñador instruccional freelance',      'Quiz de 10 preguntas con retroalimentación'),
  ('voiceover_minute',        'Locución profesional',         30.00,   'por minuto',     'Plataforma de locución',                 'Voz grabada, editada y masterizada'),
  ('instructional_design_h',  'Diseño instruccional/hora',    75.00,   'por hora',       'Consultoría eLearning',                  'Análisis, diseño y estructuración de contenido')
ON CONFLICT DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN FINAL
-- Ejecutar esto al final para confirmar que todas las tablas existen:
-- ─────────────────────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('courses','course_versions','youtube_connections',
--                      'usage_events','cost_rates','traditional_cost_benchmarks')
-- ORDER BY table_name;
-- Debe devolver 6 filas.

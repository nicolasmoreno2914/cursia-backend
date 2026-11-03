import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Course } from '../modules/courses/entities/course.entity';
import { CourseVersion } from '../modules/course-versions/entities/course-version.entity';
import { YoutubeConnection } from '../youtube/entities/youtube-connection.entity';
import { UsageEvent } from '../events/entities/usage-event.entity';
import { CostRate } from '../admin/entities/cost-rate.entity';
import { TraditionalCostBenchmark } from '../admin/entities/traditional-cost-benchmark.entity';
import { ProductionJob } from '../modules/production-jobs/entities/production-job.entity';
import { ProductionStep } from '../modules/production-jobs/entities/production-step.entity';
import { Artifact } from '../modules/artifacts/entities/artifact.entity';
import { Institution } from '../modules/institutions/entities/institution.entity';
import { BrandProfile } from '../modules/brand-profiles/entities/brand-profile.entity';
import { CourseModule as CourseModuleEntity } from '../modules/course-structure/entities/course-module.entity';
import { CourseChapter } from '../modules/course-structure/entities/course-chapter.entity';
import { CourseBlueprint } from '../modules/course-blueprints/entities/course-blueprint.entity';
import { CourseGenerationManifest } from '../modules/generation-manifests/entities/course-generation-manifest.entity';
import { GenerationItemRun } from '../modules/dynamic-generation/entities/generation-item-run.entity';

import { Logger } from '@nestjs/common';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  dbAcquireRetryPlan,
  dbApplicationName,
  dbBootstrapRetryPlan,
  dbConnectionOverrides,
  dbPoolConfig,
} from './db-pool-config';
import { initializeWithBackoff, installAcquireRetry } from './db-connect-resilience';

const dbLogger = new Logger('Database');

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        // r83: DB_HOST_WORKER / DB_PORT_WORKER (y _API) permiten mandar un rol al pooler en modo transacción
        // (puerto 6543) sin tocar el otro; ausentes → DB_HOST / DB_PORT de siempre.
        host: dbConnectionOverrides().host ?? config.get<string>('DB_HOST', 'localhost'),
        port: dbConnectionOverrides().port ?? config.get<number>('DB_PORT', 5432),
        applicationName: dbApplicationName(),
        username: config.get<string>('DB_USER', 'postgres'),
        password: config.get<string>('DB_PASS', 'postgres'),
        database: config.get<string>('DB_NAME', 'orbia'),
        entities: [Course, CourseVersion, YoutubeConnection, UsageEvent, CostRate, TraditionalCostBenchmark, ProductionJob, ProductionStep, Artifact, Institution, BrandProfile, CourseModuleEntity, CourseChapter, CourseBlueprint, CourseGenerationManifest, GenerationItemRun],
        synchronize: config.get<string>('NODE_ENV', 'development') === 'development',
        logging: config.get<string>('DB_LOGGING', 'false') === 'true',
        ssl: config.get<string>('DB_SSL', 'false') === 'true'
          ? { rejectUnauthorized: false }
          : false,
        // Resiliencia de conexión: los crashes observados en producción ("Fatal
        // bootstrap error: ECONNRESET/ETIMEDOUT") ocurren durante el arranque del
        // proceso — retryAttempts/retryDelay reintentan el bootstrap en vez de
        // matar el proceso al primer timeout transitorio de Supabase. El resto de
        // `extra` reduce conexiones idle que Supabase puede cortar del lado servidor.
        // r83: el reintento del arranque lo hace `dataSourceFactory` (abajo): pooler lleno / red transitoria → backoff
        // exponencial con jitter hasta DB_BOOTSTRAP_RETRY_MAX_MS[_WORKER]; otros errores → 10 × 3 s como antes.
        // Nest no agrega una segunda capa de reintentos encima.
        retryAttempts: 1,
        retryDelay: 0,
        // V2.1 calibración #2: tamaño del pool POR PROCESO (api vs worker), configurable por
        // entorno; sin variables = los valores de siempre (max 5, idle 20 s). Ver db-pool-config.ts.
        extra: {
          max: dbPoolConfig().max,
          min: 0,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10000,
          idleTimeoutMillis: dbPoolConfig().idleTimeoutMillis,
          connectionTimeoutMillis: 10000,
        },
      }),
      dataSourceFactory: async (options?: DataSourceOptions) => {
        if (!options) throw new Error('DatabaseModule: opciones de TypeORM ausentes');
        const ds = await initializeWithBackoff(() => new DataSource(options), dbBootstrapRetryPlan(), dbLogger);
        installAcquireRetry(ds, dbAcquireRetryPlan(), dbLogger);
        return ds;
      },
    }),
  ],
})
export class DatabaseModule {}

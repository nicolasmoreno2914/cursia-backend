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

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 5432),
        username: config.get<string>('DB_USER', 'postgres'),
        password: config.get<string>('DB_PASS', 'postgres'),
        database: config.get<string>('DB_NAME', 'orbia'),
        entities: [Course, CourseVersion, YoutubeConnection, UsageEvent, CostRate, TraditionalCostBenchmark, ProductionJob, ProductionStep, Artifact, Institution, BrandProfile],
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
        retryAttempts: 10,
        retryDelay: 3000,
        extra: {
          max: 5,
          min: 0,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10000,
          idleTimeoutMillis: 20000,
          connectionTimeoutMillis: 10000,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}

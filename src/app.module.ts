import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { CoursesModule } from './modules/courses/courses.module';
import { CourseVersionsModule } from './modules/course-versions/course-versions.module';
import { YoutubeModule } from './youtube/youtube.module';
import { EventsModule } from './events/events.module';
import { AdminModule } from './admin/admin.module';
import { VideoEngineModule } from './video-engine/video-engine.module';
import { TtsModule } from './tts/tts.module';
import { ProductionJobsModule } from './modules/production-jobs/production-jobs.module';
import { ArtifactsModule } from './modules/artifacts/artifacts.module';
import { ContentGenerationModule } from './modules/content-generation/content-generation.module';
import { PackageModule } from './package/package.module';
import { InstitutionsModule } from './modules/institutions/institutions.module';
import { BrandProfilesModule } from './modules/brand-profiles/brand-profiles.module';
import { CourseSetupModule } from './modules/course-setup/course-setup.module';
import { CourseStructureModule } from './modules/course-structure/course-structure.module';
import { CourseBlueprintsModule } from './modules/course-blueprints/course-blueprints.module';
import { GenerationManifestsModule } from './modules/generation-manifests/generation-manifests.module';
import { DynamicGenerationModule } from './modules/dynamic-generation/dynamic-generation.module';
import { DynamicPackagingModule } from './modules/dynamic-packaging/dynamic-packaging.module';
import { FeaturesModule } from './modules/features/features.module';
import { CoherenceModule } from './modules/coherence/coherence.module';
import { InvalidationModule } from './modules/invalidation/invalidation.module';
import { CourseProfilesModule } from './modules/course-profiles/course-profiles.module';
import { FinopsModule } from './modules/finops/finops.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    AuthModule,
    CoursesModule,
    CourseVersionsModule,
    ProductionJobsModule,
    ArtifactsModule,
    ContentGenerationModule,
    YoutubeModule,
    EventsModule,
    AdminModule,
    VideoEngineModule,
    TtsModule,
    PackageModule,
    InstitutionsModule,
    BrandProfilesModule,
    CourseSetupModule,
    CourseStructureModule,
    CourseBlueprintsModule,
    GenerationManifestsModule,
    DynamicGenerationModule,
    DynamicPackagingModule,
    FeaturesModule,
    CoherenceModule,
    InvalidationModule,
    CourseProfilesModule, // V2.1 (R3): perfiles de curso (presentation / assessment)
    FinopsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PROVIDER_BASE_URL_GUARD, assertProviderBaseUrlsSafe } from './config/provider-base-url-guard';
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
import { CourseMediaModule } from './modules/course-media/course-media.module';
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
import { VisualDesignModule } from './modules/visual-design/visual-design.module';
import { PedagogyModule } from './modules/pedagogy/pedagogy.module';
import { AcademicContextModule } from './modules/academic-context/academic-context.module';
import { CourseFactsModule } from './modules/course-facts/course-facts.module';
import { CourseDesignModule } from './modules/course-design/course-design.module';
import { PrebriefModule } from './modules/prebrief/prebrief.module';
import { FinopsModule } from './modules/finops/finops.module';
import { AuthzModule } from './modules/authz/authz.module';
import { AccessModule } from './modules/access/access.module';
import { BudgetsModule } from './modules/budgets/budgets.module';

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
    CourseMediaModule,
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
    // r75 (B): AccountAccessGuard (APP_GUARD) DESPUÉS de DynamicFeatureGuard (FeaturesModule) → una ruta V2 apagada
    // sigue dando su 404 nativo. Flags CURSIA_ACCOUNT_GUARD / CURSIA_RBAC_MODE (default off). Assert de arranque D-26.
    AuthzModule,
    CoherenceModule,
    InvalidationModule,
    CourseProfilesModule, // V2.1 (R3): perfiles de curso (presentation / assessment / pedagogy / academic)
    VisualDesignModule,   // r76: «Diseño visual» (contexto + vista previa real del diseño)
    PedagogyModule, // Motor pedagógico V1: catálogo, «No estoy seguro», dry-run (sin escrituras ni proveedores)
    CourseFactsModule, // LOOP 8.1: pedido del curso + «Lo que sabemos del curso» (fuente única)
    CourseDesignModule, // LOOP 8.3: «Cursia recomienda»
    PrebriefModule, // Prebrief pedagógico: propuesta versionada, aprobación y PDF
    AcademicContextModule, // Fase 3: contexto académico (extracción determinista + diseño desde el contexto; sin proveedores)
    FinopsModule,
    AccessModule, // r75 (A): instituciones multi-miembro, membresías, usuarios SA, suspensiones, auditoría, /me/context
    BudgetsModule, // r75 (C): presupuesto mensual por usuario, solicitudes y gasto por institución (CURSIA_USER_BUDGETS)
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // r58 (AU1 R3): en producción, una URL base de proveedor no oficial impide arrancar (la API y TODOS los
    // workers cargan AppModule). Corre al inicializar el módulo, con el .env ya volcado en process.env.
    { provide: PROVIDER_BASE_URL_GUARD, useFactory: () => (assertProviderBaseUrlsSafe(process.env), true) },
  ],
})
export class AppModule {}

// P0.4 deploy trigger — force CI redeploy after events DTO fix (73c9ab3)
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { warnIfNearMissDynamicFlag } from './modules/features/dynamic-features';
import { RunsService } from './modules/dynamic-generation/runs.service';
import { startAutoHealTimer } from './modules/dynamic-generation/auto-heal';
import { AutoPackageService } from './modules/dynamic-packaging/auto-package.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  warnIfNearMissDynamicFlag(logger);
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // Body size limit — 9 chapters of libro guía can exceed the 100KB default
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Security
  app.use(helmet());

  // CORS
  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    // Task 4 (rendimiento): cada request con Authorization lleva un preflight OPTIONS (~200 ms de
    // ida y vuelta desde LatAm). Cachearlo 10 min en el navegador (Chrome topa en 2 h).
    maxAge: 600,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global exception filter
  app.useGlobalFilters(new AllExceptionsFilter());

  // Global response interceptor
  app.useGlobalInterceptors(new ResponseInterceptor());

  // Global prefix
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`🚀 Cursia Backend running on http://localhost:${port}`);
  logger.log(`   Health:  GET /health`);
  logger.log(`   API:     GET /api/v1`);

  // R16 (#2): auto-healer de items dinámicos fallidos por errores transitorios. Solo en la API (los
  // workers cargan el mismo AppModule y no barren). Apagado con DYNAMIC_AUTO_HEAL_ENABLED=false.
  // EV6 DoD BE-B: el mismo tick corre el reintento automático SEGURO (rechazos definitivos sin gasto, una
  // vez) y el barrido del empaque final automático (DYNAMIC_AUTO_PACKAGE_ENABLED=false lo apaga).
  const runsService = app.get(RunsService);
  const autoPackage = app.get(AutoPackageService);
  startAutoHealTimer(runsService, new Logger('DynamicAutoHeal'), process.env, [
    { name: 'reintento automático seguro', run: () => runsService.autoRetrySafeRejections() },
    // #583 (decisión del usuario): UN reenvío automático de un audio con resultado incierto (≤ USD 0.10).
    { name: 'reenvío de audio incierto', run: () => runsService.autoResubmitAmbiguousAudio() },
    // REL CREDIT: sonda del proveedor tras crédito/cuota agotados (un canario por run y proveedor; legacy la apaga).
    { name: 'sonda de crédito del proveedor', run: () => runsService.autoProbeProviderCredit() },
    { name: 'empaque automático', run: () => autoPackage.sweep() },
  ]);
}

bootstrap();

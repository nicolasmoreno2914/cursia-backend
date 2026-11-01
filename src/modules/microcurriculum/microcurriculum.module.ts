import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { FinopsModule } from '../finops/finops.module';
import { MicrocurriculumController } from './microcurriculum.controller';
import { MicrocurriculumService } from './microcurriculum.service';

/**
 * r81 · «Crear microcurrículo»: cuestionario → microcurrículo (IA con herramienta forzada + validador V1–V8) → revisión,
 * PDF y puente al contexto académico. Para todos los usuarios con MICROCURRICULUM_ENABLED='true'. El generador real
 * (Anthropic) es el default del servicio; las pruebas inyectan uno falso con el token MICROCURRICULUM_GENERATOR.
 */
@Module({
  imports: [
    AuthModule,   // SupabaseJwtGuard
    FinopsModule, // cada llamada a la IA queda en el ledger (llm.microcurriculo)
  ],
  controllers: [MicrocurriculumController],
  providers: [MicrocurriculumService],
})
export class MicrocurriculumModule {}

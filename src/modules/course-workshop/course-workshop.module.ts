import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { FinopsModule } from '../finops/finops.module';
import { CourseWorkshopController } from './course-workshop.controller';
import { CourseWorkshopService } from './course-workshop.service';
import { WorkshopPlanService } from './plan/workshop-plan.service';
import { WorkshopApplyService } from './apply/workshop-apply.service';

/**
 * r107 · «Taller de cursos» (B1: ingesta + identificación … B5: pedidos, preguntas y plan; B6: aplicar + versiones; el cliente real de IA es el
 * default de WorkshopPlanService y las pruebas inyectan uno simulado con el token WORKSHOP_AI_CLIENT). PermissionService llega del AuthzModule global.
 * Flag COURSE_WORKSHOP (apagado por defecto); tabla workshop_sessions solo en staging (migración r107).
 */
@Module({
  imports: [AuthModule, ArtifactsModule, FinopsModule], // B5: ledger + compuertas de presupuesto de cada llamada a la IA
  controllers: [CourseWorkshopController],
  providers: [CourseWorkshopService, WorkshopPlanService, WorkshopApplyService], // B6: aplicar + versiones (trabajo en el proceso de la API)
})
export class CourseWorkshopModule {}

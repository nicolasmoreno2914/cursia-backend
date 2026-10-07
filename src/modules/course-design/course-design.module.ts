import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { PedagogyModule } from '../pedagogy/pedagogy.module';
import { CourseDesignController } from './course-design.controller';
import { CourseDesignService } from './course-design.service';
import { GenerationDesignGate } from './generation-design-gate';

/** LOOP 8.3 · «Cursia recomienda»: el diseño que se ve es el que se aplica (mismo dry-run, misma huella). */
@Module({
  imports: [CoursesModule, AuthModule, PedagogyModule],
  controllers: [CourseDesignController],
  providers: [CourseDesignService, GenerationDesignGate],
  // R68: la generación (dynamic-generation) usa el gate de verificación del diseño.
  exports: [GenerationDesignGate],
})
export class CourseDesignModule {}

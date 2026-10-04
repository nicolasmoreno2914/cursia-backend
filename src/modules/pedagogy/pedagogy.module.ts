import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CoursesModule } from '../courses/courses.module';
import { PedagogyController } from './pedagogy.controller';
import { PedagogyService } from './pedagogy.service';

/** Motor pedagógico V1 (catálogo, «No estoy seguro», dry-run). Sin escrituras ni proveedores. */
@Module({
  imports: [
    CoursesModule, // CoursesService.findOne para ownership
    AuthModule,    // SupabaseJwtGuard
  ],
  controllers: [PedagogyController],
  providers: [PedagogyService],
})
export class PedagogyModule {}

import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { CourseProfilesModule } from '../course-profiles/course-profiles.module';
import { VisualDesignController } from './visual-design.controller';
import { VisualDesignService } from './visual-design.service';

/** r76 «Diseño visual»: contexto + vista previa real del diseño de un curso (USD 0). */
@Module({
  imports: [AuthModule, CourseProfilesModule],
  controllers: [VisualDesignController],
  providers: [VisualDesignService],
  exports: [VisualDesignService],
})
export class VisualDesignModule {}

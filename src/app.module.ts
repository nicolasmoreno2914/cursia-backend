import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DatabaseModule } from './database/database.module';
import { CoursesModule } from './modules/courses/courses.module';
import { CourseVersionsModule } from './modules/course-versions/course-versions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    DatabaseModule,
    CoursesModule,
    CourseVersionsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

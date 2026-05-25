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
    YoutubeModule,
    EventsModule,
    AdminModule,
    VideoEngineModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

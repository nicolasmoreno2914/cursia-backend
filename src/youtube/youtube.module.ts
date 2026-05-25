import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YoutubeController } from './youtube.controller';
import { YoutubeService } from './youtube.service';
import { YoutubeTokenService } from './youtube-token.service';
import { YoutubeUploadService } from './youtube-upload.service';
import { YoutubeConnection } from './entities/youtube-connection.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([YoutubeConnection]),
  ],
  controllers: [YoutubeController],
  providers: [YoutubeService, YoutubeTokenService, YoutubeUploadService],
  exports: [YoutubeService, YoutubeTokenService, YoutubeUploadService],
})
export class YoutubeModule {}

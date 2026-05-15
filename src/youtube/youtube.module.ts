import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { YoutubeController } from './youtube.controller';
import { YoutubeService } from './youtube.service';
import { YoutubeTokenService } from './youtube-token.service';
import { YoutubeConnection } from './entities/youtube-connection.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([YoutubeConnection]),
  ],
  controllers: [YoutubeController],
  providers: [YoutubeService, YoutubeTokenService],
  // Exportar para que fases futuras (Y5 upload) puedan inyectarlos
  exports: [YoutubeService, YoutubeTokenService],
})
export class YoutubeModule {}

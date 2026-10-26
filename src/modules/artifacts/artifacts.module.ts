import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Artifact } from './entities/artifact.entity';
import { ArtifactsController } from './artifacts.controller';
import { ArtifactsService } from './artifacts.service';
import { ArtifactAccessService } from '../authz/artifact-access.service';

@Module({
  imports: [TypeOrmModule.forFeature([Artifact])],
  controllers: [ArtifactsController],
  providers: [ArtifactsService, ArtifactAccessService],
  exports: [ArtifactsService],
})
export class ArtifactsModule {}

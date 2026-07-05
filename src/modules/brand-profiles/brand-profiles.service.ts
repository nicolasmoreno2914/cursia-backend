import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BrandProfile } from './entities/brand-profile.entity';
import { InstitutionsService } from '../institutions/institutions.service';
import { CreateBrandProfileDto } from './dto/create-brand-profile.dto';
import { ConfirmBrandProfileDto } from './dto/confirm-brand-profile.dto';
import { ProductionJob } from '../production-jobs/entities/production-job.entity';

@Injectable()
export class BrandProfilesService {
  constructor(
    @InjectRepository(BrandProfile)
    private readonly brandProfilesRepo: Repository<BrandProfile>,
    private readonly institutionsService: InstitutionsService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Fase 1: creación manual. Se guarda directo como active,
   * archivando atómicamente la versión activa anterior si existe.
   */
  async createManual(
    institutionId: string,
    ownerId: string,
    dto: CreateBrandProfileDto,
  ): Promise<BrandProfile> {
    const institution = await this.institutionsService.findOne(
      institutionId,
      ownerId,
    );

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BrandProfile);
      const version = (await this.maxVersion(institutionId)) + 1;

      await repo.update(
        { institutionId, status: 'active' },
        { status: 'archived' },
      );

      const palette = {
        id: `brand-${institution.slug}-v${version}`,
        name: dto.name,
        desc: 'Manual de marca oficial',
        cat: 'marca',
        m1: dto.m1,
        m1a: dto.m1a,
        m2: dto.m2,
        m2a: dto.m2a,
        m3: dto.m3,
        m3a: dto.m3a,
        accent: dto.accent,
        dark: dto.dark,
        logoUrl: dto.logoUrl || null,
        source: 'brand_profile',
        brandProfileId: null as string | null,
      };

      const profile = repo.create({
        institutionId,
        version,
        status: 'active',
        palette,
        logoArtifactId: dto.logoArtifactId || null,
        typography: dto.typography || null,
        usageRules: dto.usageRules || null,
        reviewedBy: ownerId,
        reviewedAt: new Date(),
      });
      const saved = await repo.save(profile);

      saved.palette.brandProfileId = saved.id;
      return repo.save(saved);
    });
  }

  /**
   * Fase 2: sube el manual de marca (PDF ya registrado como artifact) y
   * encola un job de extracción por IA. El perfil queda en `draft` hasta
   * que el worker lo pase a `pending_review`.
   */
  async startExtraction(
    institutionId: string,
    ownerId: string,
    dto: { sourceArtifactId: string; name?: string },
  ): Promise<{ profile: BrandProfile; jobId: string }> {
    const institution = await this.institutionsService.findOne(
      institutionId,
      ownerId,
    );

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BrandProfile);
      const version = (await this.maxVersion(institutionId)) + 1;

      const profile = repo.create({
        institutionId,
        version,
        status: 'draft',
        sourceArtifactId: dto.sourceArtifactId,
        palette: {
          id: `brand-${institution.slug}-v${version}`,
          name: dto.name || institution.name,
          desc: 'Manual de marca oficial',
          cat: 'marca',
          source: 'brand_profile',
        },
      });
      const savedProfile = await repo.save(profile);

      const jobRepo = manager.getRepository(ProductionJob);
      const job = jobRepo.create({
        ownerId,
        status: 'queued',
        currentStep: 'brand_extraction',
        executionMode: 'brand_extraction',
        workerStatus: 'queued',
        inputPayload: {
          type: 'brand_extraction',
          brandProfileId: savedProfile.id,
          institutionId,
          sourceArtifactId: dto.sourceArtifactId,
          ownerId,
        },
        outputSummary: {},
      });
      const savedJob = await jobRepo.save(job);

      return { profile: savedProfile, jobId: savedJob.id };
    });
  }

  /** Paleta activa de una institución, en forma PALETTES[] lista para el frontend. */
  async findActive(
    institutionId: string,
    ownerId: string,
  ): Promise<BrandProfile | null> {
    await this.institutionsService.findOne(institutionId, ownerId);
    return this.brandProfilesRepo.findOne({
      where: { institutionId, status: 'active' },
    });
  }

  async findAllVersions(
    institutionId: string,
    ownerId: string,
  ): Promise<BrandProfile[]> {
    await this.institutionsService.findOne(institutionId, ownerId);
    return this.brandProfilesRepo.find({
      where: { institutionId },
      order: { version: 'DESC' },
    });
  }

  async findOne(id: string, ownerId: string): Promise<BrandProfile> {
    const profile = await this.brandProfilesRepo.findOne({ where: { id } });
    if (!profile) {
      throw new NotFoundException(`Brand profile ${id} no encontrado`);
    }
    await this.institutionsService.findOne(profile.institutionId, ownerId);
    return profile;
  }

  /**
   * Fase 2: confirmación humana de un perfil pending_review → active,
   * archivando la versión activa anterior en la misma transacción.
   */
  async confirm(
    id: string,
    ownerId: string,
    dto: ConfirmBrandProfileDto,
  ): Promise<BrandProfile> {
    const profile = await this.findOne(id, ownerId);
    if (profile.status !== 'pending_review' && profile.status !== 'draft') {
      throw new BadRequestException(
        `Solo se puede confirmar un perfil en draft/pending_review (actual: ${profile.status})`,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(BrandProfile);
      await repo.update(
        { institutionId: profile.institutionId, status: 'active' },
        { status: 'archived' },
      );

      if (dto.palette) {
        profile.palette = { ...profile.palette, ...dto.palette };
      }
      if (dto.typography) profile.typography = dto.typography;
      if (dto.usageRules) profile.usageRules = dto.usageRules;
      profile.status = 'active';
      profile.reviewedBy = ownerId;
      profile.reviewedAt = new Date();
      return repo.save(profile);
    });
  }

  async reject(id: string, ownerId: string): Promise<BrandProfile> {
    const profile = await this.findOne(id, ownerId);
    if (profile.status === 'active') {
      throw new BadRequestException(
        'No se puede rechazar el perfil activo; sube una versión nueva',
      );
    }
    profile.status = 'archived';
    return this.brandProfilesRepo.save(profile);
  }

  private async maxVersion(institutionId: string): Promise<number> {
    const result = await this.brandProfilesRepo
      .createQueryBuilder('bp')
      .select('COALESCE(MAX(bp.version), 0)', 'max')
      .where('bp.institution_id = :institutionId', { institutionId })
      .getRawOne();
    return parseInt(result.max, 10) || 0;
  }
}

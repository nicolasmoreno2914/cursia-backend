import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Institution } from './entities/institution.entity';

@Injectable()
export class InstitutionsService {
  constructor(
    @InjectRepository(Institution)
    private readonly institutionsRepo: Repository<Institution>,
  ) {}

  async create(name: string, ownerId: string): Promise<Institution> {
    const slug = this.slugify(name);
    const existing = await this.institutionsRepo.findOne({ where: { slug } });
    if (existing) {
      throw new ConflictException(`Ya existe una institución con slug "${slug}"`);
    }
    const institution = this.institutionsRepo.create({ name, slug, ownerId });
    return this.institutionsRepo.save(institution);
  }

  async findAll(ownerId: string): Promise<Institution[]> {
    return this.institutionsRepo.find({
      where: { ownerId },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(id: string, ownerId: string): Promise<Institution> {
    const institution = await this.institutionsRepo.findOne({
      where: { id, ownerId },
    });
    if (!institution) {
      throw new NotFoundException(`Institución ${id} no encontrada`);
    }
    return institution;
  }

  async update(
    id: string,
    ownerId: string,
    changes: { name?: string },
  ): Promise<Institution> {
    const institution = await this.findOne(id, ownerId);
    if (changes.name) {
      institution.name = changes.name;
    }
    return this.institutionsRepo.save(institution);
  }

  async remove(id: string, ownerId: string): Promise<void> {
    const institution = await this.findOne(id, ownerId);
    await this.institutionsRepo.remove(institution);
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
  }
}

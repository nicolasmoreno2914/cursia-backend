import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Course } from './entities/course.entity';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';

@Injectable()
export class CoursesService {
  constructor(
    @InjectRepository(Course)
    private readonly courseRepo: Repository<Course>,
  ) {}

  async create(dto: CreateCourseDto): Promise<Course> {
    const course = this.courseRepo.create(dto);
    return this.courseRepo.save(course);
  }

  async findAll(): Promise<Course[]> {
    return this.courseRepo.find({ order: { createdAt: 'DESC' } });
  }

  async findOne(id: number): Promise<Course> {
    const course = await this.courseRepo.findOne({
      where: { id },
      relations: ['versions'],
    });
    if (!course) {
      throw new NotFoundException(`Course #${id} not found`);
    }
    return course;
  }

  async update(id: number, dto: UpdateCourseDto): Promise<Course> {
    const course = await this.findOne(id);
    Object.assign(course, dto);
    return this.courseRepo.save(course);
  }

  async remove(id: number): Promise<void> {
    const course = await this.findOne(id);
    await this.courseRepo.remove(course);
  }
}

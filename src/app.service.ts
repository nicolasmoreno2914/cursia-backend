import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      version: process.env.npm_package_version || '1.0.0',
    };
  }

  getRoot() {
    return {
      name: 'Orbia Backend API',
      version: '1.0.0',
      description: 'API REST para CampusCloud / Orbia',
      endpoints: {
        health: 'GET /health',
        courses: 'GET /api/v1/courses',
        courseVersions: 'GET /api/v1/courses/:courseId/versions',
      },
    };
  }
}

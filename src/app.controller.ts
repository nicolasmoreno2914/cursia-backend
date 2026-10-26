import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './modules/authz/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  @Public()
  getHealth() {
    return this.appService.getHealth();
  }

  @Get()
  @Public()
  getRoot() {
    return this.appService.getRoot();
  }
}

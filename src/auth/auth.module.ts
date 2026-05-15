import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SupabaseJwtGuard } from './supabase-jwt.guard';

@Module({
  controllers: [AuthController],
  providers: [SupabaseJwtGuard],
  exports: [SupabaseJwtGuard],
})
export class AuthModule {}

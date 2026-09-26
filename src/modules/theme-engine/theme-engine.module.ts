import { Module } from '@nestjs/common';

/**
 * The Theme Engine is pure functions (resolveTheme, validateTheme,
 * moduleColor, themeSha256) — no DB, no HTTP, no DI needed. This module
 * exists only so Nest consumers (R2 renderer, R9 Gamma mapping, R12
 * shell/packaging) can `imports: [ThemeEngineModule]` for discoverability;
 * it declares no providers/controllers of its own.
 */
@Module({})
export class ThemeEngineModule {}

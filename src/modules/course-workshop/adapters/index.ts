/** r107 B2 · adaptadores por familia de formato (identify.ts `familyOf`). */
import { WorkshopFamily } from '../identify';
import { FamilyAdapter } from '../course-model';
import { v1LegacyAdapter } from './v1-legacy';
import { v1LegacyHvpAdapter } from './v1-legacy-hvp';
import { v2DynamicAdapter } from './v2-dynamic';
import { moodleReexportAdapter } from './moodle-reexport';
import { prototypeAdapter } from './prototype';

export const FAMILY_ADAPTERS: Readonly<Record<WorkshopFamily, FamilyAdapter>> = Object.freeze({
  'v1-legacy': v1LegacyAdapter,
  'v1-legacy-hvp': v1LegacyHvpAdapter,
  'v2-dynamic': v2DynamicAdapter,
  'moodle-reexport': moodleReexportAdapter,
  prototype: prototypeAdapter,
});

export function adapterFor(family: WorkshopFamily): FamilyAdapter {
  return FAMILY_ADAPTERS[family] ?? prototypeAdapter;
}

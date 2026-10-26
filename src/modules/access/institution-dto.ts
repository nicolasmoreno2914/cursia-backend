import { iso } from './access-schema';

/** r75 · 02 §B `Institution`. Puro (lo usan AccessModule e InstitutionsService sin DI cruzada). */
export interface InstitutionDto {
  id: string;
  name: string;
  slug: string;
  kind: 'organization' | 'personal';
  status: 'active' | 'suspended' | 'archived';
  createdAt: string;
  memberCount?: number;
}

export const INSTITUTION_COLUMNS = `i.id::text as id, i.name, i.slug, i.kind, i.status, i.created_at`;

export function toInstitutionDto(r: any): InstitutionDto {
  const dto: InstitutionDto = {
    id: r.id, name: r.name, slug: r.slug, kind: r.kind === 'personal' ? 'personal' : 'organization',
    status: r.status === 'suspended' || r.status === 'archived' ? r.status : 'active', createdAt: iso(r.created_at) ?? '',
  };
  if (r.member_count !== undefined && r.member_count !== null) dto.memberCount = Number(r.member_count);
  return dto;
}

export function slugify(name: string): string {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

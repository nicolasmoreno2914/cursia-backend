/**
 * EV6 DoD fix round 3 (N2) — reglas mínimas de los paquetes QA / degradados NUEVOS (sin dependencias:
 * las importa también ArtifactsController).
 *
 * Primer segmento del storage path de un paquete QA / degradado NUEVO. Las políticas de Storage de
 * `authenticated` (supabase-migration-storage-artifacts-policies.sql) solo cubren
 * `foldername[1] = auth.uid()`, así que este prefijo queda fuera del alcance del dueño (sin DDL).
 */
export const QA_INTERNAL_STORAGE_PREFIX = 'qa-internal';

/** ¿El artifact es un .mbz QA / degradado NUEVO (declarado en su metadata; solo SUPER_ADMIN)? */
export function isAdminOnlyPackageArtifact(a: { type?: string | null; metadata?: any } | null | undefined): boolean {
  const k = a?.metadata?.packageKind;
  return a?.type === 'dynamic_mbz' && (k === 'qa_preview' || k === 'degraded');
}

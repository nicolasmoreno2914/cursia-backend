// ── Tipos de autenticación ──────────────────────────────────────────────────
// El usuario se extrae del JWT de Supabase.
// No existe tabla users en este backend — auth vive en Supabase.

export interface AuthUser {
  /** UUID del usuario en Supabase auth.users (claim 'sub') */
  id: string;

  /** Email del usuario */
  email: string;

  /** Role de Supabase ('authenticated' para usuarios normales) */
  role: string;

  /** Payload completo del JWT (para debugging o claims futuros) */
  raw: Record<string, any>;
}

// r75 · Agente E — sonda H2 para la consola de la pestaña LOGUEADA de https://staging.orbia.pages.dev (NUNCA producción).
// Intenta escribir una fila SINTÉTICA en authorized_users con el JWT del usuario y la borra si la escritura pasa.
// No toca ninguna fila existente. Resultado esperado tras la migración r75-access: insert rechazado (42501 / RLS).
(async () => {
  if (location.host !== 'staging.orbia.pages.dev' || !/ljdtmkwuhkvtmlhugjrv/.test(SB.supabaseUrl)) throw new Error('solo staging');
  const PROBE = 'qa-r75-h2-probe@example.com', out = {};
  const pre = await SB.from('authorized_users').select('id').eq('email', PROBE);
  if ((pre.data || []).length) throw new Error('la fila sonda ya existe: revisar a mano antes de seguir');
  const ins = await SB.from('authorized_users').insert({ email: PROBE, is_admin: false }).select('id');
  out.insert = { status: ins.status, code: ins.error && ins.error.code, allowed: !ins.error && (ins.data || []).length === 1 };
  if (out.insert.allowed) {
    const id = ins.data[0].id;
    const upd = await SB.from('authorized_users').update({ is_admin: false }).eq('id', id).select('id');
    out.update = { status: upd.status, allowed: (upd.data || []).length === 1 };
    const del = await SB.from('authorized_users').delete().eq('id', id).eq('email', PROBE).select('id');
    out.delete = { status: del.status, allowed: (del.data || []).length === 1 };
  }
  out.remaining = ((await SB.from('authorized_users').select('id').eq('email', PROBE)).data || []).length;
  out.writeAllowed = !!out.insert.allowed;
  return out;
})();

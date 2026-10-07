'use strict';
// R68 (piloto, 2026-10-07): el servidor ya no genera un diseño sin verificación aprobable (Blueprint vigente, estructura
// sin cambios desde que se aprobó, diseño aplicable, sin críticos y SIN cambios recomendados por aplicar). Los escenarios
// E2E arman su estructura por HTTP (como un docente en «Avanzado») para probar empaque, exámenes, videos… Antes de aprobar,
// este helper hace lo que haría ese docente en la interfaz para CONSERVAR su estructura: fija el video y la Actividad de
// Aplicación de cada capítulo (editor V2: pinVideo / pinApplication) y elige las horas que su estructura ya tiene
// («Ajustar» → horas). Nada de la estructura cambia; si aun así quedan cambios o críticos, falla fuerte (nunca se
// saltea el gate). Si la estructura ya tiene el diseño verificado (escenarios que «Usan este diseño»), no hace nada.

function pendingOf(card) {
  const d = card && card.design;
  if (!d) return Infinity;
  const proposed = (d.modules || []).reduce((n, m) => n + (m.chapters || []).filter((c) => c.proposed).length, 0);
  return Math.max((d.changes || []).length, proposed);
}
// Re-review piloto P1: el servidor exige además que el diseño verificado sea el GUARDADO (profileChanged false), como deja
// «Usar este diseño» (que guarda el perfil de la tarjeta).
const approvable = (card, allowCritical) => !!(card && card.design && card.verification && card.design.applicable === true && (allowCritical || !card.verification.blocking) && pendingOf(card) === 0 && card.profileChanged === false);
// Hacia ARRIBA: unas horas por debajo de lo que ya suman los contenidos serían un crítico («ya suman más de lo pedido»).
const halfStepUp = (n) => Math.min(500, Math.max(1, Math.ceil(Number(n) * 2) / 2));

/**
 * @param api  (method, path, body) → { status, data, error } (el cliente HTTP del escenario)
 * @param opts.allowCritical  E18: conservar la estructura aunque Verificación tenga críticos (para probar que el servidor los bloquea)
 * @returns { kept: boolean, pinned: number, targetHours: number|null }
 */
async function keepTeacherDesign(api, courseId, label, opts = {}) {
  const rec = async () => {
    const r = await api('POST', `/courses/${courseId}/design/recommendation`, {});
    if (r.status !== 200 && r.status !== 201) throw new Error(`${label}: «Cursia recomienda» → ${r.status} ${r.error}`);
    return r.data;
  };
  const saveProfile = async (data) => {
    const cur = await api('GET', `/courses/${courseId}/profiles/pedagogy`);
    const version = cur.status === 200 && cur.data && !cur.data.isDefault ? Number(cur.data.version) : 0;
    const sv = await api('POST', `/courses/${courseId}/profiles/pedagogy`, { data, expectedVersion: version });
    if (sv.status !== 201 && sv.status !== 200) throw new Error(`${label}: guardar el perfil → ${sv.status} ${sv.error}`);
  };
  let card = await rec();
  if (approvable(card, opts.allowCritical)) return { kept: false, pinned: 0, targetHours: null };
  // Mismo orden que la interfaz, hasta que el diseño quede estable y aprobable (máx. 6 pasos):
  //   1. fijar el video y la Actividad de Aplicación de cada capítulo (editor V2);
  //   2. «Usar este diseño»: guardar el perfil de la tarjeta (enfoque/audiovisual que propone Cursia);
  //   3. «Ajustar» → horas: las que su estructura ya suma (hacia arriba; +1 h si aun así no alcanza el mínimo).
  let pinned = 0;
  let targetHours = null;
  for (let step = 0; step < 6 && !approvable(card, opts.allowCritical); step++) {
    if (!pinned) {
      const st = await api('GET', `/courses/${courseId}/modules`);
      if (st.status !== 200) throw new Error(`${label}: GET modules → ${st.status} ${st.error}`);
      let counter = st.data.structureVersionCounter;
      for (const m of st.data.modules) {
        for (const c of m.chapters) {
          const body = { videoEnabled: !!c.videoEnabled, pinVideo: true, expectedCounter: counter };
          if (c.applicationMinutes !== undefined) Object.assign(body, { applicationMinutes: c.applicationMinutes ?? null, pinApplication: true });
          const r = await api('PATCH', `/courses/${courseId}/modules/${m.id}/chapters/${c.id}`, body);
          if (r.status !== 200) throw new Error(`${label}: fijar el capítulo ${c.id} → ${r.status} ${r.error}`);
          counter = r.data.structureVersionCounter;
          pinned++;
        }
      }
    } else if (card.profileChanged === true) {
      await saveProfile(card.profile);
    } else {
      const d = card.design;
      // Cambios por aplicar (Cursia agregaría práctica para llegar a sus horas): las que el contenido vivo ya suma.
      // Diseño no aplicable (el mínimo supera la meta): una hora más en cada paso.
      if (d.applicable === true) targetHours = halfStepUp(Number(d.baseHours) || 1);
      else targetHours = halfStepUp((targetHours !== null ? targetHours : Number(d.baseHours) || 1) + 1);
      await saveProfile({ ...card.profile, targetHours });
    }
    card = await rec();
  }
  if (!approvable(card, opts.allowCritical)) {
    const crit = (card.verification && card.verification.checks || []).filter((c) => c.severity === 'critical').map((c) => c.title);
    throw new Error(`${label}: el diseño del docente no queda aprobable (cambios ${pendingOf(card)}, aplicable ${card.design && card.design.applicable}, perfil sin guardar ${card.profileChanged}, críticos ${JSON.stringify(crit)}, cambios ${JSON.stringify((card.design && card.design.changes || []).slice(0, 5))})`);
  }
  return { kept: true, pinned, targetHours };
}

module.exports = { keepTeacherDesign, pendingOf, approvable };

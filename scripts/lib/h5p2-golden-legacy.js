/* eslint-disable */
// EV6 H5P v2 (H1) — huellas sha256 de paquetes LEGACY (antes de H5P v2): los
// builders v1 (QS, SCS, DragText, Blanks, IV vía buildVideoActivity) y los .mbz
// v3 de la matriz de fixtures de check-v21-packaging-v3 + un curso EV5-C
// (activityTypeRules=1). `scripts/check-ev6-h5p2-contracts.js` las recalcula y
// exige igualdad byte a byte: H5P v2 no cambia nada de lo ya existente.
//
// Uso (captura, solo en el commit base): node scripts/lib/h5p2-golden-legacy.js
'use strict';

const path = require('path');
const crypto = require('crypto');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const MBZ_CONFIGS = [
  { id: 'h5p-final-light', engine: 'h5p', finalExam: true, theme: { themeFamily: 'aula-clara', mode: 'light' } },
  { id: 'scorm-nofinal-dark', engine: 'scorm', finalExam: false, theme: { themeFamily: 'oscuro-premium', mode: 'dark' }, realAudio: true },
  { id: 'h5p-nofinal-dark-mock-cleansafe', engine: 'h5p', finalExam: false, theme: { themeFamily: 'tecnico', mode: 'dark' }, mockPresentations: true, level: 'clean_safe' },
  { id: 'scorm-final-light', engine: 'scorm', finalExam: true, theme: { themeFamily: 'institucional', mode: 'light' } },
  { id: 'h5p-ev5c-rules1', engine: 'h5p', finalExam: true, activityTypeRules: 1, chapterObjectives: ['Diseñar estrategias de empaque', 'Identificar partes', 'Organice las etapas del despacho', 'Identificar partes'] },
];

async function legacyH5pShas(distRoot) {
  const h = require(path.join(distRoot, 'package/h5p/index.js'));
  const SF = require('./v21-shell-fixtures');
  const VF = require('./v21-video-fixture');
  const out = {};
  for (const t of ['questionset', 'singlechoiceset', 'dragtext', 'blanks']) {
    const p = SF.h5pPayload(t);
    const input = { ...p.data, itemKey: `activity:golden-${t}` };
    if (t === 'questionset' || t === 'singlechoiceset') input.passPercentage = 70;
    const built =
      t === 'questionset' ? h.buildQuestionSet(input) : t === 'singlechoiceset' ? h.buildSingleChoiceSet(input) : t === 'dragtext' ? h.buildDragText(input) : h.buildBlanks(input);
    out[t] = sha(await h.buildContentOnlyH5p({ mainLibrary: built.mainLibrary, content: built.content, title: built.title, language: 'es' }));
  }
  for (const d of [140, 468, 1200]) {
    const key = 'video:golden';
    const doc = VF.makeInteractionsDoc(h.planInteractionCheckpoints(d), { videoItemKey: key, durationSec: d });
    const r = await h.buildVideoActivity({ itemKey: key, title: 'Video de prueba', youtubeId: 'IdwOipZAeqY', durationSec: d, interactionsDoc: doc });
    out[`interactivevideo-${d}`] = r.sha256;
  }
  return out;
}

async function legacyMbzShas(distRoot) {
  const PF = require('./v21-packaging-fixtures');
  const B = require(path.join(distRoot, 'package/dynamic-mbz-builder-v3.js'));
  const out = {};
  for (const cfg of MBZ_CONFIGS) {
    const r = await B.buildDynamicMbzV3(PF.packagingInput(distRoot, cfg));
    out[cfg.id] = sha(r.mbz);
  }
  return out;
}

module.exports = { legacyH5pShas, legacyMbzShas, MBZ_CONFIGS };

if (require.main === module) {
  (async () => {
    require('reflect-metadata');
    const distRoot = path.resolve(process.cwd(), 'dist');
    const res = { h5p: await legacyH5pShas(distRoot), mbz: await legacyMbzShas(distRoot) };
    console.log(JSON.stringify(res, null, 2));
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

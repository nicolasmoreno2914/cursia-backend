#!/usr/bin/env node
/* eslint-disable */
// Marca de los videos de Videogen (video-brand.ts) — sin DB ni red, con los módulos COMPILADOS de dist/.
//
// Verifica que el logo y el nombre que se envían a Videogen siguen el MISMO orden que el Libro Guía:
//  1. «Diseño visual» del curso: 'custom' (logo propio) gana; 'cursia' fuerza el logo de Cursia;
//  2. Brand Kit activo de la institución;
//  3. «Logo del centro» de la cuenta del dueño (user_settings.logo_b64);
//  4. logo de Cursia (sin logo, o si el de la cuenta no valida).
// Nombre: el de la institución; si no hay, «Cursia». Un perfil de presentación ilegible no deja al
// video sin marca.
//
// Usage: npm run build && node scripts/check-video-brand.js [path/to/dist]

const path = require('path');
const fs = require('fs');

const distRoot = path.resolve(process.cwd(), process.argv[2] || 'dist');
const { loadVideoBrand } = require(path.join(distRoot, 'video-engine/video-brand'));
const { defaultPresentationProfile } = require(path.join(distRoot, 'modules/course-profiles/course-profiles'));

const logoPng = fs.readFileSync(path.resolve(__dirname, '../assets/brand/cursia-logo-navy.png'));
const PNG_URI = `data:image/png;base64,${logoPng.toString('base64')}`;

/** QueryExecutor falso: responde según la consulta, con los datos del escenario. */
function fakeDb(s) {
  return {
    async query(sql) {
      if (/from public\.course_profiles/.test(sql)) {
        if (s.profileError) throw new Error('THEME_INVALID: perfil roto');
        return s.identity ? [{ kind: 'presentation', version: 1, data: JSON.stringify({ ...defaultPresentationProfile(), identity: s.identity }) }] : [];
      }
      if (/select metadata, created_at from public\.courses/.test(sql)) return [{ metadata: {}, created_at: new Date().toISOString() }];
      if (/select owner_id, institution_id from public\.courses/.test(sql)) return [{ owner_id: 'owner-1', institution_id: s.institution ? 'inst-1' : null }];
      if (/to_regclass/.test(sql)) return [{ bp: true, us: true, inst: true }];
      if (/from public\.institutions/.test(sql)) return [{ name: s.institution?.name ?? null }];
      if (/from public\.brand_profiles/.test(sql)) return s.institution?.logo ? [{ logo_url: s.institution.logo, logo_artifact_id: null }] : [];
      if (/from public\.user_settings/.test(sql)) return s.userLogo ? [{ logo_b64: s.userLogo }] : [];
      throw new Error(`consulta no prevista: ${sql.slice(0, 80)}`);
    },
  };
}

const cases = [
  { name: 'sin ningún logo → Cursia', s: {}, source: 'cursia_default', inst: 'Cursia' },
  { name: '«Logo del centro» de la cuenta', s: { userLogo: PNG_URI }, source: 'user_settings', inst: 'Cursia' },
  { name: 'Brand Kit de la institución gana a la cuenta', s: { userLogo: PNG_URI, institution: { name: 'Colegio Andino', logo: PNG_URI } }, source: 'brand_profile', inst: 'Colegio Andino' },
  { name: 'institución sin logo → logo de la cuenta, nombre de la institución', s: { userLogo: PNG_URI, institution: { name: 'Colegio Andino' } }, source: 'user_settings', inst: 'Colegio Andino' },
  { name: 'Diseño visual «custom» gana a todo', s: { userLogo: PNG_URI, institution: { name: 'Colegio Andino', logo: PNG_URI }, identity: { logo: 'custom', logoDataUri: PNG_URI, watermark: true, showInCourse: false } }, source: 'course_profile', inst: 'Colegio Andino' },
  { name: 'Diseño visual «cursia» fuerza el logo de Cursia', s: { userLogo: PNG_URI, identity: { logo: 'cursia', watermark: true, showInCourse: false } }, source: 'cursia_default', inst: 'Cursia' },
  { name: 'logo de la cuenta inválido → Cursia con aviso', s: { userLogo: 'data:image/png;base64,AAAA' }, source: 'cursia_default', inst: 'Cursia', warning: /libro_logo_invalid/ },
  { name: 'perfil ilegible → marca de la cuenta igual', s: { userLogo: PNG_URI, profileError: true }, source: 'user_settings', inst: 'Cursia', warning: /video_brand_profile_unavailable/ },
];

(async () => {
  let failed = 0;
  for (const c of cases) {
    const r = await loadVideoBrand(fakeDb(c.s), 42, 'owner-1');
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(r.brand.logo_data_uri);
    const bytes = m ? Buffer.from(m[2], 'base64') : Buffer.alloc(0);
    const problems = [];
    if (r.logoSource !== c.source) problems.push(`origen ${r.logoSource} (esperado ${c.source})`);
    if (r.brand.institution_name !== c.inst) problems.push(`nombre "${r.brand.institution_name}" (esperado "${c.inst}")`);
    if (!m || bytes.length < 100) problems.push('logo_data_uri no es una imagen PNG/JPEG en base64');
    if (c.warning && !r.warnings.some((w) => c.warning.test(w))) problems.push(`falta el aviso ${c.warning} (avisos: ${r.warnings.join(', ') || 'ninguno'})`);
    console.log(`${problems.length ? 'FALLA' : 'OK   '} ${c.name}${problems.length ? ' — ' + problems.join('; ') : ''}`);
    if (problems.length) failed++;
  }
  console.log(`\n${cases.length - failed}/${cases.length} OK`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

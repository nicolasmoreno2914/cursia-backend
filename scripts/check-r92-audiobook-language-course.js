#!/usr/bin/env node
// r92 · el guion del audiolibro no se bloquea por «español neutro» en cursos de lengua/literatura, ni por un término
// que ya trae el texto fuente del bloque (ejemplo del capítulo). USD 0, contra dist/.
const path = require('path');
const { audioLanguageFindings } = require(path.join(__dirname, '..', 'dist', 'workers', 'provider-real', 'audio-scripts.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✅ ' + m); } else { fail++; console.log('❌ ' + m); } };
const script = 'En Colombia decimos que algo es chévere cuando nos gusta mucho; en España, que es guay.';
const other = { courseTitle: 'Excel para auxiliares administrativos', sector: 'Administración' };
ok(audioLanguageFindings(script, 'Texto sin regionalismos.', other).length > 0, 'curso normal: un regionalismo del narrador sigue bloqueando');
ok(audioLanguageFindings(script, 'Texto sin regionalismos.', { courseTitle: 'Español y Literatura – Grado 6', sector: 'Educación' }).length === 0, 'curso de lengua/literatura: no bloquea');
ok(audioLanguageFindings('Algo chévere.', 'La palabra «chévere» es un colombianismo.', other).length === 0, 'término presente en el texto fuente: ejemplo del capítulo, no bloquea');
ok(audioLanguageFindings('Vosotros sabéis.', 'Texto neutro.', other).length > 0, '«vosotros» del narrador sigue bloqueando en curso normal');
console.log(`\nRESULTADO r92: ${pass} OK / ${fail} FALLAS`);
process.exit(fail ? 1 : 0);

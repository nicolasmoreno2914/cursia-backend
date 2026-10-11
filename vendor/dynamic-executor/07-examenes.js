// ════ EXÁMENES ════
var EI=[];
function qExamenes(){
  EI=D.mods.map(function(m,mi){return{n:'📝 Examen Unidad '+(mi+1)+' — 25 preguntas',d:'Caps '+(mi*3+1)+'-'+(mi*3+3)+': '+m.caps.join(' / '),fn:'examen_unidad'+(mi+1)+'.gift',t:'u',mi:mi,m:m};});
  EI.push({n:'🏆 Examen Final — 50 preguntas',d:'Todo el curso — 9 capítulos — '+D.nombre,fn:'examen_final.gift',t:'f'});
  return EI.map(function(x){return {name:x.n,detail:x.d};});
}

// ── GIFT header block (reutilizado en ambos flujos) ──
function giftFeedbackHeader(){
  return '// ═══════════════════════════════════════════════════════\n'
    +'// RETROALIMENTACIÓN GLOBAL — Configura en Moodle:\n'
    +'// Editar cuestionario → Retroalimentación general\n'
    +'// ───────────────────────────────────────────────\n'
    +'// Límite 100% → 🏆 ¡Perfecto! Dominas completamente este tema. ¡Felicitaciones!\n'
    +'// Límite 90%  → 🎯 ¡Excelente resultado! Estás muy cerca de la perfección.\n'
    +'// Límite 70%  → 🌟 ¡Muy bien! Demuestras buen dominio del tema. ¡Sigue así!\n'
    +'// Límite 50%  → 🌱 ¡Vas por buen camino! Con más repaso lo dominarás.\n'
    +'// Límite 0%   → 💪 ¡No te rindas! Repasa el material y vuelve a intentarlo.\n'
    +'// ═══════════════════════════════════════════════════════\n\n';
}

// ── Cuántas preguntas de cada tipo se piden por examen. Ya no se generan
// preguntas de completar/numéricas (type:'shortanswer') — Moodle las califica
// por coincidencia exacta de texto y eso generaba falsos negativos (ej. "70%"
// vs "70"). Esas preguntas se redistribuyeron a selección múltiple.
function examTypeExpectations(item){
  return item.t==='f'
    ? {multichoice:30,truefalse:10,match:10}
    : {multichoice:15,truefalse:5,match:5};
}

// ── Genera el GIFT de UN examen: primer intento + verificación de conteo real
// POR TIPO + reintento correctivo pidiendo exactamente lo que falta de cada
// tipo (no solo el total — si falta emparejamiento específicamente, se pide
// emparejamiento, no "cualquier pregunta más"). Único punto de esta lógica —
// la usan tanto genExamenes() (botón standalone) como el bucle de exámenes en
// runAll() (02-run.js), para no volver a duplicarla como pasó con parseGIFT().
// ── Divide un GIFT crudo en bloques por marcador ::ID:: y detecta el tipo de
// cada bloque (sin depender de parseGIFT, que no conserva el texto original
// necesario para poder recortar bloques sobrantes).
function _giftBlocks(text){
  var blocks=[]; var re=/::([^:]+)::/g; var m; var starts=[];
  while((m=re.exec(text)))starts.push({id:m[1],idx:m.index});
  for(var i=0;i<starts.length;i++){
    var st=starts[i].idx;
    var en=(i+1<starts.length)?starts[i+1].idx:text.length;
    blocks.push({id:starts[i].id,raw:text.substring(st,en).trim()});
  }
  return blocks;
}
function _giftBlockType(raw){
  var bs=raw.indexOf('{'), be=raw.lastIndexOf('}');
  if(bs<0||be<0)return null;
  var ans=raw.substring(bs+1,be).trim();
  var ansArrows=ans.replace(/→|⟶|-{1,2}>/g,'->');
  if(ansArrows.indexOf('->')>=0)return 'match';
  if(/^(TRUE|FALSE|T|F|VERDADERO|FALSO)$/.test(ans))return 'truefalse';
  if(/^#/.test(ans))return 'shortanswer';
  if(ans.indexOf('~')>=0)return 'multichoice';
  if(ans.indexOf('=')===0)return 'shortanswer';
  return null;
}
// ── Recorta preguntas sobrantes por tipo (quita las últimas de cada tipo que
// exceda lo esperado) para que el total del examen quede exacto — antes solo
// se corregían faltantes, nunca excedentes, y un examen podía quedar con más
// preguntas de las anunciadas (ej. 30 en vez de 25).
function _trimExcessQuestions(text,expected){
  var blocks=_giftBlocks(text);
  var typed=blocks.map(function(b){return{id:b.id,raw:b.raw,type:_giftBlockType(b.raw)};});
  var counts={}; typed.forEach(function(b){ if(b.type)counts[b.type]=(counts[b.type]||0)+1; });
  var excedentes=[];
  Object.keys(expected).forEach(function(t){
    var extra=(counts[t]||0)-expected[t];
    if(extra>0)excedentes.push({type:t,count:extra});
  });
  if(!excedentes.length)return text;
  excedentes.forEach(function(ex){
    var idxs=[]; typed.forEach(function(b,i){ if(b.type===ex.type)idxs.push(i); });
    idxs.slice(-ex.count).forEach(function(i){ typed[i]._remove=true; });
  });
  if(typeof logLine==='function')logLine('  ✂️ Recortadas '+excedentes.reduce(function(s,e){return s+e.count;},0)+' pregunta(s) sobrante(s) ('+excedentes.map(function(e){return e.type+':'+e.count;}).join(', ')+')','info');
  return typed.filter(function(b){return !b._remove;}).map(function(b){return b.raw;}).join('\n\n');
}

async function genExamenGift(item,c,s){
  var r=await apiRetry(s,pGIFT(item,c),item.t==='f'?8192:4096,3);
  var cl=r.replace(/```gift|```/g,'').trim();
  // Verificar conteo real (no crudo) por tipo de pregunta, y pedir un único
  // reintento correctivo específico si falta algo — antes se guardaba tal
  // cual y el faltante solo se descubría revisando el MBZ ya restaurado.
  var expected=examTypeExpectations(item);
  cl=_trimExcessQuestions(cl,expected);
  var parsed=(typeof parseGIFT==='function')?parseGIFT(cl):[];
  var byType={multichoice:0,truefalse:0,match:0,shortanswer:0};
  parsed.forEach(function(q){ if(byType[q.type]!==undefined)byType[q.type]++; });
  var faltantes=[];
  Object.keys(expected).forEach(function(t){
    var missing=expected[t]-(byType[t]||0);
    if(missing>0)faltantes.push({type:t,count:missing});
  });
  if(faltantes.length>0){
    var totalMissing=faltantes.reduce(function(s,f){return s+f.count;},0);
    if(typeof logLine==='function')logLine('  ↻ Faltaron '+totalMissing+' pregunta(s) ('+faltantes.map(function(f){return f.type+':'+f.count;}).join(', ')+') — pidiendo corrección…','active');
    try{
      var prefix=item.t==='f'?'EF':'U'+(item.mi+1);
      var idNums=[]; var idRe=new RegExp('::'+prefix+'-(\\d+)::','g'),idm;
      while((idm=idRe.exec(cl)))idNums.push(parseInt(idm[1],10));
      var nextIdNum=(idNums.length?Math.max.apply(null,idNums):0)+1;
      var r2=await apiRetry(s,pGIFTCorreccion(item,c,faltantes,nextIdNum),item.t==='f'?4096:2048,2);
      var cl2=r2.replace(/```gift|```/g,'').trim();
      cl=_trimExcessQuestions(cl+'\n\n'+cl2,expected);
      if(typeof logLine==='function')logLine('  ✓ Corrección aplicada','ok');
    }catch(e2){
      // Si falla el reintento, se guarda lo que ya se generó — la alarma del
      // validador lo hace visible, pero al menos queda registrado acá.
      if(typeof logLine==='function')logLine('  ✗ Corrección falló: '+(e2.msg||e2.message||e2)+' — se guarda incompleto','warn');
    }
  }
  return giftFeedbackHeader()+cl;
}

async function genExamenes(){
  if(!getApiKey()){alert('⚠️ Ingresa tu API key en el sidebar.');return;}
  var btn=document.querySelector('#br-examenes button'); btn.disabled=true;
  var c=ctx(), s=sysG();
  for(var i=0;i<EI.length;i++){
    var item=EI[i]; qSt('examenes',i,'gen');
    try{
      var cl=await genExamenGift(item,c,s);
      F[item.fn]=cl; qSt('examenes',i,'done'); qResult('examenes',i,item.fn,cl); updStats();
    }
    catch(e){qSt('examenes',i,'err');}
  }
  btn.disabled=false;
}

// ── GIFT syntax reference embedded en cada prompt (generación y corrección) ──
function giftSyntaxRef(){
  return '\n\nFORMATO GIFT — SINTAXIS OBLIGATORIA POR TIPO:\n\n'
    +'// Selección múltiple (1 correcta):\n'
    +'::ID-01:: Pregunta completa sobre '+D.sector+'? {\n'
    +'  =Respuesta correcta\n'
    +'  ~Distractor plausible 1\n'
    +'  ~Distractor plausible 2\n'
    +'  ~Distractor plausible 3\n'
    +'}\n\n'
    +'// Verdadero/Falso:\n'
    +'::ID-02:: Afirmación sobre '+D.sector+' que es verdadera. {TRUE}\n'
    +'::ID-03:: Afirmación incorrecta sobre el proceso. {FALSE}\n\n'
    +'// Emparejamiento (matching):\n'
    +'::ID-04:: Relaciona términos de '+D.sector+'. {\n'
    +'  =Término A -> Definición de A\n'
    +'  =Término B -> Definición de B\n'
    +'  =Término C -> Definición de C\n'
    +'  =Término D -> Definición de D\n'
    +'}\n\n'
    +'REGLAS ABSOLUTAS DEL FORMATO:\n'
    +'- Cada pregunta DEBE tener ::ID-NN:: único\n'
    +'- Selección múltiple: EXACTAMENTE 1 "=" y 3 "~"\n'
    +'- Matching: mínimo 4 pares "=término -> definición"\n'
    +'- PROHIBIDO generar preguntas de completar/rellenar espacio ({=respuesta}) ni numéricas ({#valor:tolerancia}) — Moodle las califica por coincidencia exacta de texto y generan falsos negativos. SOLO usa selección múltiple, verdadero/falso y emparejamiento.\n'
    +'- LONGITUD IGUALADA en selección múltiple (regla dura, no aproximada): mide en caracteres la respuesta correcta y los 3 distractores. La diferencia entre la opción MÁS LARGA y la MÁS CORTA —incluida la correcta— NO debe superar 15 caracteres. La correcta JAMÁS puede ser la opción más larga; si necesita más detalle, alarga los distractores para igualar. Un estudiante no debe poder adivinar la respuesta solo por ser la más larga.\n'
    +'- PROHIBIDO: texto explicativo entre preguntas\n'
    +'- PROHIBIDO: ```gift ``` bloques de código\n'
    +'- SOLO GIFT puro, sin comentarios entre preguntas\n';
}

// ── Prompt de corrección: pide EXCLUSIVAMENTE los tipos de pregunta que
// faltaron, con su cantidad exacta — no "cualquier pregunta más", porque eso
// dejaba que la IA repusiera con otro tipo y el hueco original seguía ahí.
function pGIFTCorreccion(item,c,faltantes,nextIdNum){
  var prefix=item.t==='f'?'EF':'U'+(item.mi+1);
  var totalLabel=item.t==='f'?'examen FINAL':'examen de UNIDAD '+(item.mi+1);
  var totalMissing=faltantes.reduce(function(s,f){return s+f.count;},0);
  var typeLabels={
    multichoice:'selección múltiple (4 opciones, 1 correcta)',
    truefalse:'verdadero/falso',
    match:'emparejamiento (mínimo 4 pares cada una)'
  };
  var detalle=faltantes.map(function(f){return '- '+f.count+' de '+(typeLabels[f.type]||f.type);}).join('\n');
  return c+'\n\nGeneraste el '+totalLabel+' de "'+D.nombre+'" pero faltaron preguntas de tipos específicos: tu respuesta anterior solo llegó hasta '+prefix+'-'+(nextIdNum-1)+'.\nGenera EXACTAMENTE estas '+totalMissing+' preguntas ADICIONALES, del tipo EXACTO indicado en cada caso (no las repongas con otro tipo):\n'+detalle+'\nContinuando la numeración desde ::'+prefix+'-'+nextIdNum+':: en adelante (sin saltos ni repetir preguntas anteriores). Mismo rigor: preguntas concretas del sector '+D.sector+' en '+D.pais+', nunca genéricas.\nENTREGA SOLO las '+totalMissing+' preguntas nuevas en formato GIFT puro, sin repetir ninguna pregunta anterior, sin texto explicativo.'
    +giftSyntaxRef();
}

function pGIFT(item,c){
  var syntax=giftSyntaxRef();
  if(item.t==='u'){
    var qTypes='- 15 selección múltiple (distractores plausibles, opciones misma longitud)\n- 5 Verdadero/Falso (mezcla TRUE y FALSE, no más de 3 iguales)\n- 5 emparejamiento (4 pares cada uno, términos específicos de '+D.sector+')\n';
    return c+'\n\nExamen UNIDAD '+(item.mi+1)+' del curso "'+D.nombre+'" ('+D.sector+', '+D.pais+').\nCapítulos cubiertos: '+item.m.caps.join(' | ')+'\n\n25 PREGUNTAS distribuidas así:\n'+qTypes
      +'\n$CATEGORY: '+D.nombre+' - Unidad '+(item.mi+1)+'\n'
      +'IDs: U'+(item.mi+1)+'-01 a U'+(item.mi+1)+'-25\n'
      +'Cada pregunta específica para el sector '+D.sector+' en '+D.pais+' — NUNCA genérica.\n'
      +syntax;
  }

  // Examen final
  var qTypesFinal='- 30 selección múltiple\n- 10 Verdadero/Falso\n- 10 emparejamiento (4 pares c/u)\n';
  return c+'\n\nExamen FINAL de "'+D.nombre+'" ('+D.sector+', '+D.pais+'). 9 capítulos, 3 módulos.\n\n50 PREGUNTAS distribuidas así:\n'+qTypesFinal
    +'\n$CATEGORY: '+D.nombre+' - Examen Final\n'
    +'IDs: EF-01 a EF-50\n'
    +'Cobertura proporcional: ~5-6 preguntas por capítulo. Cubre fundamentos, procedimientos, diagnóstico, seguridad.\n'
    +'Preguntas concretas del sector '+D.sector+' en '+D.pais+' — ejemplos reales, nombres de procesos reales.\n'
    +syntax;
}

// ════ STATS & DL ════
function updStats(){
  var gen=Object.keys(F).length;
  var stGen=document.getElementById('st-gen');
  var stPct=document.getElementById('st-pct');
  if(stGen)stGen.textContent=gen;
  if(stPct)stPct.textContent=Math.round(gen/44*100)+'%';
  var badge=document.getElementById('dl-badge');
  if(badge){badge.textContent=gen; badge.className='sb-badge'+(gen>0?' on':'');}
  renderDL();
  updReviewGates();
}

function approveR1(){
  REVIEW.r1=true;
  _saveReview();
  var gate=document.getElementById('review1-gate');
  var done=document.getElementById('review1-done');
  if(gate)gate.style.display='none';
  if(done)done.style.display='flex';
  updReviewGates();
  // Navigate to multimedia so user can continue the flow
  setTimeout(function(){go('media');},600);
}

function approveR2(){
  REVIEW.r2=true;
  _saveReview();
  var gate=document.getElementById('review2-gate');
  var done=document.getElementById('review2-done');
  if(gate)gate.style.display='none';
  if(done)done.style.display='flex';
  updReviewGates();
}

function updReviewGates(){
  var hasContent=typeof F!=='undefined'&&Object.keys(F).length>0;
  var canExport=REVIEW.r1||hasContent;

  // Si Gamma ya se disparó para este curso pero todavía no se sabe su resultado
  // (éxito, falla, o no disponible), bloqueamos la exportación para que el .mbz
  // "primera parte" siempre salga con las presentaciones ya incluidas.
  var CP=window.COURSE_PRODUCTION;
  var gammaBlocking=!!(CP && CP._gammaBackgroundFired && !CP._gammaResolved);
  canExport=canExport&&!gammaBlocking;

  var nlmLock=document.getElementById('media-nlm-lock');
  var nlmContent=document.getElementById('media-nlm-content');
  if(nlmLock)nlmLock.style.display=canExport?'none':'';
  if(nlmContent)nlmContent.style.display=canExport?'':'none';

  var mbzBtn=document.getElementById('btn-export-mbz');
  if(mbzBtn){
    mbzBtn.disabled=!canExport;
    mbzBtn.style.opacity=canExport?'1':'0.45';
    mbzBtn.style.cursor=canExport?'pointer':'not-allowed';
    mbzBtn.innerHTML=canExport
      ?'📦 Exportar .MBZ para Moodle'
      :(gammaBlocking?'⏳ Generando presentaciones Gamma…':'⏳ Genera el curso primero');
  }
  var driveBtn=document.getElementById('btn-drive-mbz');
  if(driveBtn){
    driveBtn.disabled=!canExport;
    driveBtn.style.opacity=canExport?'1':'0.45';
    driveBtn.style.cursor=canExport?'pointer':'not-allowed';
  }
}
function renderDL(){
  var grid=document.getElementById('dl-grid'); grid.innerHTML='';
  var icons={'.html':'🌐','.gift':'📝','.md':'📖','.xml':'📋'};
  Object.keys(F).forEach(function(fn){
    var ext=(fn.match(/\.[^.]+$/)||[''])[0];
    var icon=(fn.includes('index')||fn.includes('scorm'))?'🎮':(icons[ext]||'📄');
    var div=document.createElement('div'); div.className='dl-item';
    // Nombre legible en vez del nombre técnico crudo (libro_cap3.md → "📚 Libro Guía...");
    // friendlyName() ya existía y se usaba al empaquetar el .mbz, pero nunca aquí,
    // que es justo la pantalla que el usuario final ve.
    var label=(typeof friendlyName==='function')?friendlyName(fn):fn;
    div.title=fn;
    div.innerHTML='<div class="dl-icon">'+icon+'</div><div class="dl-info"><div class="dl-name">'+esc(label)+'</div><div class="dl-ext">'+ext.toUpperCase()+'</div></div>';
    var btn=document.createElement('button'); btn.className='btn btn-g btn-sm'; btn.textContent='⬇️';
    btn.addEventListener('click',function(){dl(fn,F[fn]);});
    div.appendChild(btn); grid.appendChild(div);
  });
}
function dlTodo(){
  var keys=Object.keys(F); if(!keys.length){alert('No hay archivos generados todavía.');return;}
  keys.forEach(function(fn,i){setTimeout(function(){dl(fn,F[fn]);},i*250);});
}
function limpiar(){
  if(!confirm('¿Limpiar todos los archivos y empezar de nuevo?'))return;
  F={}; uMec=[]; uEst=[];
  REVIEW.r1=false; REVIEW.r2=false; _saveReview();
  updStats(); go('config');
}
// ════ AUTO-FILL IA ════
// ════ POPUP PERFIL ESTUDIANTE ════
function showPerfilPopup(){
  return new Promise(function(resolve, reject){
    // Leer selecciones actuales del formulario como defaults
    var defNivel    = (document.querySelector('#cp-nivel .chip.on')||{}).textContent||'Básico';
    var defTono     = (document.querySelector('#cp-tono .chip.on')||{}).textContent||'Conversacional';
    var defContexto = (document.querySelector('#cp-contexto .chip.on')||{}).textContent||'Universitario';

    var el=document.createElement('div');
    el.id='perfil-popup-overlay';
    el.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;backdrop-filter:blur(4px);';
    el.innerHTML=
      '<div style="background:#0E1C2E;border:1px solid rgba(226, 230, 243,0.10);border-radius:20px;padding:32px;width:100%;max-width:520px;box-shadow:0 24px 64px rgba(0,0,0,0.5);">'+
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">'+
          '<div style="width:36px;height:36px;border-radius:10px;background:oklch(0.25 0.06 250);display:flex;align-items:center;justify-content:center;flex-shrink:0;">'+
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="oklch(0.611 0.192 264.7)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>'+
          '</div>'+
          '<div>'+
            '<div style="font-size:16px;font-weight:700;color:#E2E6F3;">Perfil del estudiante</div>'+
            '<div style="font-size:12px;color:rgba(226, 230, 243,0.62);margin-top:2px;">La IA ajustará el contenido según estas preferencias</div>'+
          '</div>'+
        '</div>'+

        // Nivel
        '<div style="margin-bottom:20px;">'+
          '<div style="font-size:10px;font-weight:700;color:rgba(226, 230, 243,0.62);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;">Nivel de conocimiento previo</div>'+
          '<div class="pp-chips" id="pp-nivel" style="display:flex;flex-wrap:wrap;gap:8px;">'+
            '<div class="pp-chip'+(defNivel==='Básico'?' pp-on':'')+'" data-v="Básico — sin conocimientos previos" data-lbl="Básico" style="display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:oklch(0.78 0.16 155);flex-shrink:0;"></span>Básico</div>'+
            '<div class="pp-chip'+(defNivel==='Intermedio'?' pp-on':'')+'" data-v="Intermedio — conoce los conceptos fundamentales" data-lbl="Intermedio" style="display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:oklch(0.82 0.14 75);flex-shrink:0;"></span>Intermedio</div>'+
            '<div class="pp-chip'+(defNivel==='Avanzado'?' pp-on':'')+'" data-v="Avanzado — ya trabaja en el área" data-lbl="Avanzado" style="display:flex;align-items:center;gap:6px;"><span style="width:7px;height:7px;border-radius:50%;background:oklch(0.70 0.20 25);flex-shrink:0;"></span>Avanzado</div>'+
          '</div>'+
        '</div>'+

        // Tono
        '<div style="margin-bottom:20px;">'+
          '<div style="font-size:10px;font-weight:700;color:rgba(226, 230, 243,0.62);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;">Tono del contenido</div>'+
          '<div class="pp-chips" id="pp-tono" style="display:flex;flex-wrap:wrap;gap:8px;">'+
            '<div class="pp-chip'+(defTono==='Conversacional'?' pp-on':'')+'" data-v="Conversacional y cercano, como un mentor con ejemplos cotidianos" data-lbl="Conversacional">Conversacional</div>'+
            '<div class="pp-chip'+(defTono==='Técnico'?' pp-on':'')+'" data-v="Técnico y preciso, con terminología del sector" data-lbl="Técnico">Técnico</div>'+
            '<div class="pp-chip'+(defTono==='Directo'?' pp-on':'')+'" data-v="Directo y práctico, enfocado en qué hacer y cómo" data-lbl="Directo">Directo</div>'+
            '<div class="pp-chip'+(defTono==='Motivador'?' pp-on':'')+'" data-v="Motivador y orientado a la acción y resultados" data-lbl="Motivador">Motivador</div>'+
          '</div>'+
        '</div>'+

        // Contexto
        '<div style="margin-bottom:28px;">'+
          '<div style="font-size:10px;font-weight:700;color:rgba(226, 230, 243,0.62);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;">Contexto educativo</div>'+
          '<div class="pp-chips" id="pp-contexto" style="display:flex;flex-wrap:wrap;gap:8px;">'+
            '<div class="pp-chip'+(defContexto==='Bachillerato'?' pp-on':'')+'" data-v="Bachillerato — estudiantes de secundaria y media, con lenguaje claro y ejemplos concretos" data-lbl="Bachillerato">Bachillerato</div>'+
            '<div class="pp-chip'+(defContexto==='Técnico'?' pp-on':'')+'" data-v="Técnico / Tecnólogo — formación vocacional orientada a competencias prácticas" data-lbl="Técnico">Técnico</div>'+
            '<div class="pp-chip'+(defContexto==='Universitario'?' pp-on':'')+'" data-v="Universitario — estudiantes de pregrado con rigor académico y pensamiento crítico" data-lbl="Universitario">Universitario</div>'+
            '<div class="pp-chip'+(defContexto==='Corporativo'?' pp-on':'')+'" data-v="Corporativo — profesionales en ejercicio, con enfoque práctico y aplicación inmediata" data-lbl="Corporativo">Corporativo</div>'+
            '<div class="pp-chip'+(defContexto==='Posgrado'?' pp-on':'')+'" data-v="Posgrado — especialización o maestría, con profundidad teórica y análisis avanzado" data-lbl="Posgrado">Posgrado</div>'+
          '</div>'+
        '</div>'+

        // Botones
        '<div style="display:flex;gap:10px;">'+
          '<button id="pp-cancel" style="flex:1;padding:12px;border-radius:10px;background:rgba(226, 230, 243,0.04);border:1px solid rgba(226, 230, 243,0.08);color:rgba(226, 230, 243,0.6);font-size:14px;font-family:inherit;cursor:pointer;">Cancelar</button>'+
          '<button id="pp-confirm" style="flex:2;padding:12px;border-radius:10px;background:oklch(0.611 0.192 264.7);border:none;color:#0A1628;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;">Generar con IA →</button>'+
        '</div>'+
      '</div>';

    // Estilos de chips del popup
    var style=document.createElement('style');
    style.textContent=
      '.pp-chip{padding:8px 14px;border-radius:50px;border:1px solid rgba(226, 230, 243,0.10);color:rgba(226, 230, 243,0.55);font-size:13px;font-family:inherit;cursor:pointer;transition:all .15s;user-select:none;}'+
      '.pp-chip:hover{border-color:rgba(255,255,255,0.25);color:#E2E6F3;}'+
      '.pp-chip.pp-on{border-color:oklch(0.611 0.192 264.7);color:oklch(0.611 0.192 264.7);background:oklch(0.611 0.192 264.7 / 0.10);}';
    el.appendChild(style);
    document.body.appendChild(el);

    // Click en chips — solo uno activo por grupo
    el.querySelectorAll('.pp-chips').forEach(function(group){
      group.addEventListener('click',function(e){
        var chip=e.target.closest('.pp-chip');
        if(!chip)return;
        group.querySelectorAll('.pp-chip').forEach(function(c){c.classList.remove('pp-on');});
        chip.classList.add('pp-on');
      });
    });

    function close(){ document.body.removeChild(el); }

    document.getElementById('pp-cancel').onclick=function(){ close(); reject('cancelled'); };
    el.addEventListener('click',function(e){ if(e.target===el){ close(); reject('cancelled'); } });

    document.getElementById('pp-confirm').onclick=function(){
      var nivel    = el.querySelector('#pp-nivel .pp-on');
      var tono     = el.querySelector('#pp-tono .pp-on');
      var contexto = el.querySelector('#pp-contexto .pp-on');
      if(!nivel||!tono||!contexto){ return; }

      // Sincronizar selecciones al formulario principal
      ['cp-nivel','cp-tono','cp-contexto'].forEach(function(gId, gi){
        var popupSel=[nivel,tono,contexto][gi];
        var formGroup=document.getElementById(gId);
        if(!formGroup||!popupSel)return;
        var lbl=popupSel.dataset.lbl;
        formGroup.querySelectorAll('.chip').forEach(function(c){
          var match=c.textContent.trim()===lbl||c.textContent.trim().startsWith(lbl);
          c.classList.toggle('on',match);
        });
      });

      close();
      resolve({
        nivel:    nivel.dataset.v,
        nivelLbl: nivel.dataset.lbl,
        tono:     tono.dataset.v,
        tonoLbl:  tono.dataset.lbl,
        contexto: contexto.dataset.v,
        contextoLbl: contexto.dataset.lbl
      });
    };
  });
}

async function autoIA(){
  var nombre=v('c-nombre');
  if(!nombre){alert('Escribe el nombre del curso primero.');return;}
  // El formulario es ahora el aterrizaje por defecto, así que esto puede
  // llamarse sin sesión — api() manda el token de Supabase al backend, que
  // lo necesita para resolver la key de Anthropic del servidor. Se pide
  // login recién acá (no antes) y se reintenta la llamada tras loguearse.
  if(!window.SB_USER){
    try{ localStorage.setItem('CURSIA_PENDING_COURSE_NAME', nombre); }catch(e){}
    requireAuth(function(){ autoIA(); });
    return;
  }
  // api() ya cae al ANTHROPIC_API_KEY del servidor cuando no hay key propia
  // (ver buildProxyHeaders en 04-api.js) — pedir una key de Anthropic en medio
  // del flujo de creación de curso no tiene lugar en un producto self-service.

  // Mostrar popup de perfil antes de generar
  var perfil;
  try{ perfil=await showPerfilPopup(); }
  catch(e){ return; } // usuario canceló

  var pais=v('c-pais')||'Colombia';
  var esColombia=(pais==='Colombia');
  var sector=v('c-sector')||'';
  var btn=document.getElementById('btn-ia');
  var st=document.getElementById('ia-status');
  btn.disabled=true;btn.innerHTML='<span style="opacity:.6">⏳</span> Generando…';
  st.style.display='block';st.textContent='Analizando "'+nombre+'" y diseñando la estructura…';
  try{
    // El campo "comp" (unidad de competencia SENA) solo tiene sentido en
    // Colombia — pedirlo para otros países hacía que la IA inventara un
    // código SENA falso para un curso mexicano/español/etc.
    var compField=esColombia?'\n  "comp": "código y nombre de la unidad de competencia SENA más apropiada",':'';
    var compRule=esColombia?' Competencia con código SENA real.':'';
    var prompt='Curso: "'+nombre+'"'+(sector?' | Sector: '+sector:'')+' | País: '+pais+
      '\nPerfil del estudiante: Nivel '+perfil.nivelLbl+' | Tono '+perfil.tonoLbl+' | Contexto '+perfil.contextoLbl+
      '\n\nDiseña la estructura completa de este curso virtual adaptada al perfil indicado y al país. Responde SOLO con JSON (sin markdown, sin backticks, sin explicaciones), con esta estructura exacta:\n{'+compField+'\n  "sector": "sector o industria del curso",\n  "ciudad": "ciudad principal relevante en '+pais+'",\n  "objetivo": "párrafo de 2 líneas: qué logrará el estudiante al terminar (adaptado al nivel '+perfil.nivelLbl+')",\n  "m1": {"n": "nombre módulo 1", "c1": "cap 1", "c2": "cap 2", "c3": "cap 3"},\n  "m2": {"n": "nombre módulo 2", "c4": "cap 4", "c5": "cap 5", "c6": "cap 6"},\n  "m3": {"n": "nombre módulo 3", "c7": "cap 7", "c8": "cap 8", "c9": "cap 9"}\n}\nREGLAS: Módulo 1=fundamentos/conceptos, Módulo 2=aplicación/gestión, Módulo 3=herramientas+legal+proyecto. Capítulos específicos y profesionales, no genéricos.'+compRule+' Adapta la profundidad, enfoque y normativa/contexto local al perfil: '+perfil.nivel+' | '+perfil.tono+' | '+perfil.contexto;
    var r=await api('Eres diseñador curricular experto para cursos virtuales en '+pais+'. Solo respondes JSON.',prompt,1500);
    var clean=r.replace(/```json|```/g,'').trim();
    var d=JSON.parse(clean);
    if(d.comp&&esColombia)document.getElementById('c-comp').value=d.comp;
    if(d.sector)document.getElementById('c-sector').value=d.sector;
    if(d.ciudad)document.getElementById('c-ciudad').value=d.ciudad;
    if(d.objetivo)document.getElementById('c-obj').value=d.objetivo;
    if(d.m1){
      document.getElementById('m1-n').value=d.m1.n||'';
      document.getElementById('m1-c1').value=d.m1.c1||'';
      document.getElementById('m1-c2').value=d.m1.c2||'';
      document.getElementById('m1-c3').value=d.m1.c3||'';
    }
    if(d.m2){
      document.getElementById('m2-n').value=d.m2.n||'';
      document.getElementById('m2-c4').value=d.m2.c4||'';
      document.getElementById('m2-c5').value=d.m2.c5||'';
      document.getElementById('m2-c6').value=d.m2.c6||'';
    }
    if(d.m3){
      document.getElementById('m3-n').value=d.m3.n||'';
      document.getElementById('m3-c7').value=d.m3.c7||'';
      document.getElementById('m3-c8').value=d.m3.c8||'';
      document.getElementById('m3-c9').value=d.m3.c9||'';
    }
    st.innerHTML='✅ Estructura generada para nivel <strong>'+perfil.nivelLbl+'</strong>. Revisa y ajusta lo que necesites.';
    // Refrescar el checklist "Listo para generar" — autoIA() setea .value
    // directo (sin evento input) y showPerfilPopup() togglea los chips de
    // nivel/tono/contexto sin click(), así que ninguno de los dos dispara
    // los listeners que normalmente mantienen el panel lateral sincronizado.
    if (typeof occMeterUpdate === 'function') occMeterUpdate();
    if (typeof occSetReadinessItem === 'function') {
      occSetReadinessItem('cc-c-nivel', 'cc-e-nivel', true, perfil.nivelLbl);
      occSetReadinessItem('cc-c-tono', 'cc-e-tono', true, perfil.tonoLbl);
    }
    go('estructura');
    setTimeout(function(){go('config');},600);
  }catch(e){
    var msg=e&&(e.msg||e.message)||'Error desconocido';
    st.textContent='❌ '+msg+'. Intenta de nuevo.';
  }
  btn.disabled=false;btn.innerHTML='<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><path d="M12 8.5l1.2 2.3L15.5 12l-2.3 1.2L12 15.5l-1.2-2.3L8.5 12l2.3-1.2z"/></svg> Generar con IA';
}

// ════ FRIENDLY NAMES ════
function parseGIFT(gift){
  var questions=[];
  var lines=gift.split('\n');
  var i=0;
  while(i<lines.length){
    var line=lines[i].trim();
    // Skip empty lines, comments, categories
    if(!line||line.charAt(0)==='/'||line.indexOf('$CATEGORY:')===0){i++;continue;}
    // Extract name if present ::name::
    var name='';
    var nameMatch=line.match(/^::([^:]+)::/);
    if(nameMatch){name=nameMatch[1].trim();line=line.substring(nameMatch[0].length).trim();}
    // Collect multi-line question text + answer block
    var fullLine=line;
    while(i+1<lines.length&&lines[i+1].trim()&&lines[i+1].trim().charAt(0)!==':'){
      i++;fullLine+='\n'+lines[i].trim();
    }
    // Normalizar llaves dobles ({{...}}) que la IA a veces genera en vez de {...} —
    // sin esto ansBlock empieza con "{" y la pregunta se descarta en ninguna rama.
    fullLine=fullLine.replace(/\{\{+/g,'{').replace(/\}\}+/g,'}');
    // Find the answer block { ... }
    var braceStart=fullLine.indexOf('{');
    var braceEnd=fullLine.lastIndexOf('}');
    if(braceStart<0||braceEnd<0){i++;continue;}
    var qText=fullLine.substring(0,braceStart).trim();
    var qTextAfter=fullLine.substring(braceEnd+1).trim();
    // Fallback: AI sometimes puts the statement as ::name:: and leaves qText empty
    if(!qText&&name) qText=name;
    var ansBlock=fullLine.substring(braceStart+1,braceEnd).trim();

    // Determine type
    var ansBlockArrows=ansBlock.replace(/→|⟶|-{1,2}>/g,'->'); // tolerar variantes de flecha del modelo
    if(ansBlockArrows.indexOf('->')>=0){
      // Match type: =term -> definition
      var pairs=[];
      var mLines=ansBlockArrows.split('\n');
      for(var ml=0;ml<mLines.length;ml++){
        var mLine=mLines[ml].trim();
        if(mLine.charAt(0)==='='){
          var parts=mLine.substring(1).split('->');
          if(parts.length>=2)pairs.push({q:parts[0].trim(),a:parts.slice(1).join('->').trim()});
        }
      }
      if(pairs.length>0)questions.push({type:'match',name:name,text:qText,pairs:pairs});
    }else if(ansBlock==='TRUE'||ansBlock==='FALSE'||ansBlock==='T'||ansBlock==='F'||ansBlock==='VERDADERO'||ansBlock==='FALSO'){
      var isTrue=ansBlock==='TRUE'||ansBlock==='T'||ansBlock==='VERDADERO';
      questions.push({type:'truefalse',name:name,text:qText,answer:isTrue});
    }else if(/^#/.test(ansBlock)){
      // Numérica {#valor:tolerancia} — sin tipo 'numerical' propio todavía, se guarda
      // como shortanswer con el valor exacto para reusar el XML ya probado en Moodle.
      var numMatch=ansBlock.match(/^#\s*([\d.\-]+)/);
      if(numMatch)questions.push({type:'shortanswer',name:name,text:qText,answers:[numMatch[1]]});
    }else if(ansBlock.indexOf('~')>=0||ansBlock.indexOf('=')===0){
      // Check if it's shortanswer (only = answers, no ~)
      if(ansBlock.indexOf('~')<0&&ansBlock.indexOf('=')>=0){
        // Completar: el blank puede ir a mitad de frase — reconstruye el texto completo
        // en vez de descartar todo lo que sigue después de "}".
        // Si hay más de un blank en la misma pregunta (ej. "El {=a =b} de {=c =d}."),
        // solo el primero queda interactivo; los siguientes se resuelven con su
        // primera respuesta como texto fijo — Moodle shortanswer no soporta 2+ blanks.
        var braceGroups=[];
        var bgRe=/\{([^{}]*)\}/g,bgm;
        while((bgm=bgRe.exec(fullLine)))braceGroups.push({start:bgm.index,end:bgRe.lastIndex,inner:bgm[1]});
        if(braceGroups.length>1){
          var rebuilt='',cursor=0,firstAnswers=null;
          for(var gi=0;gi<braceGroups.length;gi++){
            var g=braceGroups[gi];
            rebuilt+=fullLine.substring(cursor,g.start);
            var alts=g.inner.split('=').map(function(s){return s.trim();}).filter(function(s){return s.length>0;});
            if(gi===0){rebuilt+='_____';firstAnswers=alts;}
            else{rebuilt+=(alts[0]||'');}
            cursor=g.end;
          }
          rebuilt+=fullLine.substring(cursor);
          if(firstAnswers&&firstAnswers.length>0)questions.push({type:'shortanswer',name:name,text:rebuilt.trim(),answers:firstAnswers});
        }else{
          if(qTextAfter)qText=(qText+' _____ '+qTextAfter).trim();
          var saAnswers=ansBlock.split('=').map(function(l){return l.trim().replace(/\}+$/,'');}).filter(function(l){return l.length>0;});
          if(saAnswers.length>0)questions.push({type:'shortanswer',name:name,text:qText,answers:saAnswers});
        }
      }else{
        // Multichoice
        var opts=[];
        var optLines=ansBlock.split('\n');
        for(var ol=0;ol<optLines.length;ol++){
          var oLine=optLines[ol].trim();
          if(!oLine)continue;
          if(oLine.charAt(0)==='='){opts.push({text:oLine.substring(1).trim(),correct:true});}
          else if(oLine.charAt(0)==='~'){
            var oText=oLine.substring(1).trim();
            // Remove %0% or %-xx% prefix
            oText=oText.replace(/^%[-\d]+%\s*/,'');
            opts.push({text:oText,correct:false});
          }
        }
        if(opts.length>0)questions.push({type:'multichoice',name:name,text:qText,options:opts});
      }
    }else if(ansBlock.length>0&&ansBlock.indexOf('\n')<0&&ansBlock.length<150){
      // Fallback: a veces la IA omite el "=" delante de la respuesta en completar
      // (ej. "{precisión}" en vez de "{=precisión}") — sin esto la pregunta no
      // matchea ninguna rama y se pierde en silencio. Se toma como respuesta única.
      if(qTextAfter)qText=(qText+' _____ '+qTextAfter).trim();
      questions.push({type:'shortanswer',name:name,text:qText,answers:[ansBlock]});
    }
    i++;
  }
  return questions;
}

/**
 * Recorta un nombre de actividad para que quepa en la columna `name`
 * (VARCHAR(255)) que Moodle usa en scorm/label/quiz/resource. Sin este
 * recorte, capítulos con títulos muy detallados generan nombres de
 * actividad >255 caracteres que Moodle rechaza al restaurar (MySQL en
 * modo estricto) — el import se queda "procesando" sin completar nunca.
 */
function safeActivityName(name,max){
  max=max||240;
  if(!name||name.length<=max)return name;
  var cut=name.substring(0,max);
  var lastSpace=cut.lastIndexOf(' ');
  if(lastSpace>max*0.6)cut=cut.substring(0,lastSpace);
  return cut.replace(/[\s—\-:,]+$/,'')+'…';
}

function friendlyName(fn){
  var caps=D.caps||[];
  var capMap={};
  caps.forEach(function(c){capMap[c.n]=c.t;});
  // Static pages
  if(fn==='seccion0_bienvenida.html')return '🏠 Bienvenida al Curso';
  if(fn==='seccion0_audio_bienvenida.html')return '🎵 Audio de Bienvenida';
  if(fn==='seccion0_introduccion.html')return '📋 ¿Qué Aprenderás?';
  if(fn==='seccion0_metodologia.html')return '⚙️ Metodología del Curso';
  if(fn==='seccion1_ruta_aprendizaje.html')return '🗺️ Ruta de Aprendizaje';
  if(fn==='seccion1_libro_guia.html')return '📚 Libro Guía del Curso';
  if(fn==='seccion1_audiolibro.html')return '📻 Audiolibro del Curso';
  if(fn==='examen_final_descripcion.html')return 'ℹ️ Información: Examen Final';
  // Video pages
  var vm=fn.match(/^cap(\d+)_video_interactivo\.html$/);
  if(vm){var n=parseInt(vm[1]);return safeActivityName('▶️ Cap. '+n+' — Video: '+(capMap[n]||'Capítulo '+n));}
  // Gamma presentation
  var gm=fn.match(/^cap(\d+)_presentacion_gamma\.html$/);
  if(gm){var n=parseInt(gm[1]);return safeActivityName('📊 Presentación Cap '+n+(capMap[n]?' — '+capMap[n]:''));}
  // SCORM description
  var sm=fn.match(/^cap(\d+)_descripcion_actividad\.html$/);
  if(sm){var n=parseInt(sm[1]);return '🎮 Cap. '+n+' — Actividad Gamificada';}
  // Exam descriptions — different name from the quiz itself to avoid looking like duplicates
  var em=fn.match(/^examen_unidad(\d+)_descripcion\.html$/);
  if(em)return 'ℹ️ Información: Examen Unidad '+em[1];
  // Fallback
  return fn.replace(/_/g,' ').replace('.html','').replace(/\b\w/g,function(l){return l.toUpperCase();});
}

// ── SHA-1 helper (Web Crypto API) ──
async function sha1Hex(data){
  // data can be Uint8Array or ArrayBuffer
  var buf = data instanceof ArrayBuffer ? data : (data.buffer || data);
  var hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
}
async function sha1HexBlob(blob){
  var ab = await blob.arrayBuffer();
  return sha1Hex(ab);
}


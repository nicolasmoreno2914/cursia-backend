// ════ SCORMs ════
// All mechanics use checkSala(n,i) — AI only implements renderArea(n) visual.
// HINT FORMAT: concrete area.innerHTML code — AI copies the pattern, only changes CSS styling.
// CRITICAL INVARIANT in every hint: onclick uses '+n+' and '+i+' as JS string concatenation,
// NOT literal text. Pattern: '<button onclick="checkSala('+n+','+i+')">'
var MECS=[
  {
    name:'Quiz Clásico',
    hint:'4 botones apilados verticalmente. area.innerHTML=\'<p style="font-size:18px;font-weight:600;margin:0 0 18px;">\'+q.q+\'</p>\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="display:block;width:100%;padding:14px 18px;margin:6px 0;border-radius:10px;text-align:left;cursor:pointer;font-size:15px;">\'+o+\'</button>\';}).join(\'\');'
  },
  {
    name:'V/F Speedrun',
    hint:'PREGUNTAS opts:["VERDADERO","FALSO"]. Afirmación gigante centrada + 2 botones enormes lado a lado. area.innerHTML=\'<p style="font-size:24px;font-weight:700;text-align:center;padding:28px 0;line-height:1.3;">\'+q.q+\'</p><div style="display:flex;gap:16px;width:100%;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="flex:1;height:90px;border-radius:16px;font-size:22px;font-weight:800;cursor:pointer;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Boss Fight',
    hint:'PREGUNTAS: añade bossEmoji (ej "👹") y bossName al nivel sala en PREGUNTAS (fuera del array de preguntas). Boss emoji enorme + barra HP verde que decrece. area.innerHTML=\'<div style="font-size:72px;text-align:center;margin-bottom:6px;">\'+( PREGUNTAS["sala"+n].bossEmoji||"👾" )+\'</div><p style="text-align:center;font-weight:700;margin:0 0 8px;">\'+( PREGUNTAS["sala"+n].bossName||"JEFE" )+\'</p><div style="height:14px;border-radius:7px;overflow:hidden;background:rgba(255,255,255,.15);margin-bottom:14px;"><div style="height:100%;background:#22c55e;width:\'+Math.max(10,Math.round((1-G.idx/PREGUNTAS["sala"+n].length)*100))+\'%;transition:width 0.5s;"></div></div><p style="font-size:15px;font-weight:600;margin-bottom:12px;">\'+q.q+\'</p>\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="display:block;width:100%;padding:11px;margin:4px 0;border-radius:8px;cursor:pointer;font-size:14px;text-align:left;">\'+o+\'</button>\';}).join(\'\');'
  },
  {
    name:'Hot or Not',
    deprecated:true,
    hint:'PREGUNTAS opts:["CORRECTO","INCORRECTO"]. Tarjeta de afirmación grande + 2 botones emoji gigantes. area.innerHTML=\'<div style="border-radius:20px;padding:30px;text-align:center;font-size:18px;font-weight:600;border:2px solid rgba(255,255,255,.2);margin-bottom:18px;line-height:1.4;">\'+q.q+\'</div><div style="display:flex;gap:16px;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="flex:1;height:80px;border-radius:16px;font-size:40px;cursor:pointer;">\'+( o==="CORRECTO"?"✅":"❌" )+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Tarjetas Reveal',
    hint:'4 tarjetas cuadradas en flex-wrap. Pregunta arriba, opciones como cards clicables. area.innerHTML=\'<p style="font-size:16px;font-weight:600;text-align:center;margin-bottom:18px;">\'+q.q+\'</p><div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="width:142px;height:90px;border-radius:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;text-align:center;padding:10px;border:2px solid rgba(255,255,255,.25);line-height:1.3;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Grid 2×2',
    hint:'Pregunta + cuadrícula 2 columnas × 2 filas de botones cuadrados iguales. area.innerHTML=\'<p style="font-size:17px;font-weight:600;margin-bottom:16px;">\'+q.q+\'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="height:84px;border-radius:14px;font-size:14px;cursor:pointer;padding:10px;line-height:1.3;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Carrusel Horizontal',
    deprecated:true,
    hint:'Pregunta + tira horizontal scrollable de tarjetas. area.innerHTML=\'<p style="font-size:17px;font-weight:600;margin-bottom:12px;">\'+q.q+\'</p><div style="display:flex;gap:12px;overflow-x:auto;padding:4px 0 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="min-width:150px;height:110px;border-radius:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:14px;font-size:14px;line-height:1.3;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Neon Selector',
    deprecated:true,
    hint:'Pregunta + 4 barras horizontales apiladas con borde izquierdo de acento. area.innerHTML=\'<p style="font-size:17px;font-weight:600;margin-bottom:16px;">\'+q.q+\'</p>\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="display:flex;align-items:center;width:100%;height:58px;margin:6px 0;border-radius:0 10px 10px 0;padding-left:18px;border-left:4px solid;cursor:pointer;font-size:15px;text-align:left;">\'+o+\'</button>\';}).join(\'\');'
  },
  {
    name:'Pictogram Quiz',
    hint:'Pregunta + 4 tarjetas con número/ícono grande arriba y texto abajo, en flex-wrap centrado. area.innerHTML=\'<p style="font-size:17px;font-weight:600;text-align:center;margin-bottom:16px;">\'+q.q+\'</p><div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">\'+G.currentOpts.map(function(o,i){var nums=["①","②","③","④"];return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="width:132px;height:104px;border-radius:16px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;border:2px solid rgba(255,255,255,.2);padding:8px;"><span style="font-size:26px;">\'+nums[i]+\'</span><span style="font-size:12px;text-align:center;line-height:1.3;">\'+o+\'</span></button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Elimina el Intruso',
    hint:'PREGUNTAS: opts contiene 4 opciones; correct ES el intruso (el que NO pertenece al grupo). Instrucción fija + pregunta que nombra el grupo + pills chip. area.innerHTML=\'<p style="font-size:13px;opacity:.7;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px;">¿Cuál NO pertenece al grupo?</p><p style="font-size:20px;font-weight:700;margin-bottom:22px;">\'+q.q+\'</p><div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="padding:12px 22px;border-radius:50px;cursor:pointer;font-size:14px;font-weight:600;border:2px solid rgba(255,255,255,.25);">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Speed Round',
    hint:'PREGUNTAS opts: exactamente 2 opciones por pregunta. Barra de progreso slim arriba + pregunta grande + 2 botones anchos. area.innerHTML=\'<div style="height:4px;border-radius:2px;overflow:hidden;margin-bottom:22px;background:rgba(255,255,255,.1);"><div style="height:100%;background:currentColor;width:\'+Math.round(G.idx/(PREGUNTAS["sala"+n].length||1)*100)+\'%;transition:width .3s;"></div></div><p style="font-size:22px;font-weight:700;text-align:center;margin-bottom:22px;line-height:1.3;">\'+q.q+\'</p><div style="display:flex;gap:12px;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="flex:1;height:66px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Caso de Estudio',
    hint:'PREGUNTAS: cada pregunta tiene campo "scenario" (texto del caso real, 1-2 oraciones). Recuadro de caso + pregunta + 4 botones. area.innerHTML=\'<div style="border-left:4px solid;padding:14px 16px;border-radius:0 12px 12px 0;background:rgba(255,255,255,.05);margin-bottom:14px;font-size:14px;line-height:1.5;">\'+( q.scenario||"" )+\'</div><p style="font-size:16px;font-weight:600;margin-bottom:14px;">\'+q.q+\'</p>\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="display:block;width:100%;padding:12px 16px;margin:5px 0;border-radius:9px;text-align:left;cursor:pointer;font-size:14px;">\'+o+\'</button>\';}).join(\'\');'
  },
  {
    name:'Diagnóstico Sectorial',
    hint:'PREGUNTAS: q describe el síntoma/problema observado; opts son causas o diagnósticos posibles. Panel de alerta naranja + 4 botones con borde izquierdo naranja. area.innerHTML=\'<div style="display:flex;align-items:flex-start;gap:12px;border-radius:12px;padding:14px;background:rgba(255,100,0,.1);border:1px solid rgba(255,100,0,.35);margin-bottom:14px;"><span style="font-size:22px;">⚠️</span><div><p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.65;margin:0 0 5px;">PROBLEMA DETECTADO</p><p style="font-size:15px;font-weight:600;margin:0;">\'+q.q+\'</p></div></div>\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="display:flex;align-items:center;width:100%;padding:11px 14px;margin:5px 0;border-radius:9px;border-left:3px solid rgba(255,120,0,.6);cursor:pointer;font-size:14px;text-align:left;">\'+o+\'</button>\';}).join(\'\');'
  },
  {
    name:'Selector Circular',
    deprecated:true,
    hint:'Pregunta en pill redondeado arriba + 4 cuadrantes 2×2 con border-radius alto. area.innerHTML=\'<div style="border-radius:100px;padding:16px 20px;font-size:16px;font-weight:600;text-align:center;margin-bottom:16px;border:2px solid rgba(255,255,255,.2);">\'+q.q+\'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="height:90px;border-radius:20px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:13px;padding:12px;cursor:pointer;line-height:1.3;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Match de Tarjetas',
    hint:'PREGUNTAS: q es el TÉRMINO; opts son 4 DEFINICIONES posibles; correct es la definición correcta. Término enorme centrado en caja oscura + 4 definiciones en grid 2×2. area.innerHTML=\'<div style="font-size:26px;font-weight:800;text-align:center;padding:22px;border-radius:16px;margin-bottom:16px;background:rgba(255,255,255,.08);">\'+q.q+\'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="padding:16px 12px;border-radius:14px;font-size:12px;cursor:pointer;text-align:left;line-height:1.4;border:1px solid rgba(255,255,255,.15);">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Simulador de Decisiones',
    hint:'PREGUNTAS: q es situación real del sector; opts son 4 decisiones posibles. Caja "SITUACIÓN" + subtítulo + 4 botones con letra A/B/C/D. area.innerHTML=\'<div style="border-radius:12px;padding:16px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);margin-bottom:14px;"><p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin:0 0 8px;">SITUACIÓN</p><p style="font-size:15px;font-weight:600;margin:0;line-height:1.4;">\'+q.q+\'</p></div><p style="font-size:13px;opacity:.75;margin-bottom:10px;">¿Qué decisión tomarías?</p>\'+G.currentOpts.map(function(o,i){var lbl=["A","B","C","D"];return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;margin:5px 0;border-radius:10px;cursor:pointer;text-align:left;font-size:13px;"><span style="min-width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;background:rgba(255,255,255,.15);">\'+lbl[i]+\'</span><span>\'+o+\'</span></button>\';}).join(\'\');'
  },
  {
    name:'Cronología Interactiva',
    hint:'PREGUNTAS: q es el evento/hito; opts son 4 períodos/fechas; correct es el período correcto. Evento en caja + línea de tiempo horizontal con 4 nodos clicables. area.innerHTML=\'<div style="border-radius:12px;padding:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);margin-bottom:22px;font-size:15px;font-weight:600;text-align:center;line-height:1.4;">\'+q.q+\'</div><div style="position:relative;display:flex;justify-content:space-between;align-items:flex-start;padding:20px 0 0;"><div style="position:absolute;top:6px;left:8%;right:8%;height:2px;background:rgba(255,255,255,.25);"></div>\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="position:relative;flex:1;background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 4px;"><div style="width:14px;height:14px;border-radius:50%;background:currentColor;border:2px solid rgba(0,0,0,.3);"></div><span style="font-size:11px;font-weight:700;text-align:center;line-height:1.3;">\'+o+\'</span></button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Galería de Conceptos',
    hint:'PREGUNTAS: q es la DEFINICIÓN; opts son 4 TÉRMINOS; correct es el término correcto. Definición en caja grande + 4 términos en grid 2×2 como badges. area.innerHTML=\'<div style="border-radius:14px;padding:20px;font-size:16px;line-height:1.5;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);margin-bottom:16px;text-align:center;">\'+q.q+\'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">\'+G.currentOpts.map(function(o,i){return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="padding:18px 12px;border-radius:14px;font-size:15px;font-weight:700;cursor:pointer;text-align:center;letter-spacing:.3px;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Arrastra y Suelta',
    hint:'Interacción: clic en tarjeta la SELECCIONA (resalta), luego clic en zona de drop la CONFIRMA → checkSala. Sin drag real (funciona en móvil). Estado en G._dragSel (índice seleccionado, -1=ninguno). CSS en <style>: .drag-card{transition:transform .15s,box-shadow .15s;cursor:pointer} .drag-card.sel{transform:scale(1.06);box-shadow:0 0 0 3px var(--accent);} .drop-zone{transition:background .2s;} .drop-zone.ready{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.7);}\nEn renderArea(n) primero: G._dragSel=-1;\narea.innerHTML=\'<p style="font-size:13px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin-bottom:8px;">① Selecciona · ② Suelta en la zona</p><p style="font-size:17px;font-weight:700;margin:0 0 16px;line-height:1.4;">\'+q.q+\'</p><div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;">\'+G.currentOpts.map(function(o,i){return \'<div class="drag-card btn-op" id="dc\'+n+\'_\'+i+\'" onclick="var prev=document.querySelector(\\".drag-card.sel\\");if(prev)prev.classList.remove(\\"sel\\");this.classList.add(\\"sel\\");G._dragSel=\'+i+\';var dz=document.getElementById(\\"dz\'+n+\'\\");if(dz)dz.classList.add(\\"ready\\")" style="padding:12px 18px;border-radius:12px;font-size:14px;font-weight:600;user-select:none;">\'+o+\'</div>\';}).join(\'\')+\'</div><div id="dz\'+n+\'" class="drop-zone" onclick="if(G._dragSel>=0){checkSala(\'+n+\',G._dragSel);}" style="border:2px dashed rgba(255,255,255,.3);border-radius:16px;padding:32px 20px;text-align:center;font-size:15px;opacity:.8;cursor:pointer;">📥 Suelta aquí la respuesta correcta</div>\';'
  },
  {
    name:'Defuse la Bomba',
    hint:'Todas las opciones se ven como bombas 💣 idénticas (la correcta es la que "no explota"). CSS en <style>: @keyframes kaboom{0%{transform:scale(1)}30%{transform:scale(1.3) rotate(-5deg)}60%{transform:scale(.8) rotate(5deg)}100%{transform:scale(0);opacity:0}} @keyframes tick{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}} .bomb-btn{animation:tick 0.4s ease-in-out infinite;} .bomb-btn:active{transform:scale(.95);}\nEn renderArea(n):\nvar total=PREGUNTAS["sala"+n].length;\narea.innerHTML=\'<p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.5;margin-bottom:8px;">⚡ DESACTIVA LA BOMBA CORRECTA</p><p style="font-size:16px;font-weight:700;margin:0 0 20px;line-height:1.4;text-align:center;">\'+q.q+\'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">\'+G.currentOpts.map(function(o,i){return \'<button class="btn-op bomb-btn" onclick="this.style.animation=\\"none\\";checkSala(\'+n+\',\'+i+\')" style="height:110px;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:700;padding:10px;"><span style="font-size:38px;line-height:1;">💣</span><span style="line-height:1.3;text-align:center;">\'+o+\'</span></button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Kahoot Relámpago',
    hint:'Estilo Kahoot: barra de tiempo countdown (CSS animation), pregunta grande, 4 botones de COLORES FIJOS con símbolo geométrico. Los colores no revelan respuesta (son por posición). CSS en <style>: @keyframes countdown{from{width:100%}to{width:0%}} .kbar{animation:countdown 20s linear forwards;}\nColores fijos: i=0 → #EF4444, i=1 → #3B82F6, i=2 → #EAB308, i=3 → #22C55E. Símbolos: ["▲","◆","●","✿"].\narea.innerHTML=\'<div style="height:8px;border-radius:4px;overflow:hidden;margin-bottom:18px;background:rgba(255,255,255,.12);"><div class="kbar" style="height:100%;border-radius:4px;background:var(--accent);"></div></div><p style="font-size:21px;font-weight:800;text-align:center;margin:0 0 20px;line-height:1.3;">\'+q.q+\'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">\'+G.currentOpts.map(function(o,i){var clrs=["#EF4444","#3B82F6","#EAB308","#22C55E"],sym=["▲","◆","●","✿"];return \'<button onclick="checkSala(\'+n+\',\'+i+\')" style="height:80px;border-radius:14px;font-size:13px;font-weight:800;cursor:pointer;background:\'+clrs[i]+\';color:#fff;border:none;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;text-align:center;line-height:1.3;"><span style="font-size:22px;flex-shrink:0;">\'+sym[i]+\'</span>\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Rueda de Conceptos',
    deprecated:true,
    hint:'Pregunta en el CENTRO de un círculo; 4 opciones posicionadas en N/E/S/W alrededor con CSS absolute. Contenedor .wheel{position:relative;width:290px;height:290px;margin:0 auto}. Posiciones: i=0 top-center, i=1 right-middle, i=2 bottom-center, i=3 left-middle. CSS: @keyframes spin-in{from{opacity:0;transform:scale(.5)}to{opacity:1;transform:scale(1)}} .wheel-opt{animation:spin-in .3s ease both;}\nTransforms de posición (aplicar como style inline):\ni=0: top:0;left:50%;transform:translateX(-50%)\ni=1: top:50%;right:0;transform:translateY(-50%)\ni=2: bottom:0;left:50%;transform:translateX(-50%)\ni=3: top:50%;left:0;transform:translateY(-50%)\narea.innerHTML=\'<p style="font-size:14px;font-weight:700;text-align:center;margin-bottom:16px;opacity:.8;">\'+q.q+\'</p><div class="wheel" style="position:relative;width:290px;height:290px;margin:0 auto;"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;z-index:2;">🎯</div>\'+G.currentOpts.map(function(o,i){var pos=["top:0;left:50%;transform:translateX(-50%)","top:50%;right:0;transform:translateY(-50%)","bottom:0;left:50%;transform:translateX(-50%)","top:50%;left:0;transform:translateY(-50%)"];return \'<button class="btn-op wheel-opt" onclick="checkSala(\'+n+\',\'+i+\')" style="position:absolute;width:100px;height:70px;\'+pos[i]+\';border-radius:14px;cursor:pointer;font-size:12px;font-weight:600;padding:8px;line-height:1.3;text-align:center;animation-delay:\'+( i*0.08 )+\'s;">\'+o+\'</button>\';}).join(\'\')+\'</div>\';'
  },
  {
    name:'Conectar Flechas',
    hint:'MECÁNICA MATCHING: columna izquierda = conceptos (de q.opts primeros 2); columna derecha = definiciones (de q.opts últimos 2 mezclados). El usuario clica un item izquierdo (queda "sel"), luego clica uno derecho → checkSala si el índice es correcto. Para esta mecánica PREGUNTAS: q es la pregunta/instrucción general; opts=[concepto1, concepto2, definicion1, definicion2] donde opts[0]→opts[2] y opts[1]→opts[3] son pares correctos.\nEstado: G._connLeft=-1 (índice seleccionado en col izquierda), G._connRight=-1.\nCSS en <style>: .conn-col{display:flex;flex-direction:column;gap:10px;flex:1} .conn-item{padding:12px 14px;border-radius:12px;font-size:13px;font-weight:600;cursor:pointer;text-align:center;line-height:1.3;transition:all .15s} .conn-item.sel{box-shadow:0 0 0 3px var(--accent);transform:scale(1.04)} .conn-item.matched{opacity:.45;pointer-events:none}\nEn renderArea(n):\nG._connLeft=-1;G._connRight=-1;\nvar lefts=G.currentOpts.slice(0,2),rights=G.currentOpts.slice(2,4);\narea.innerHTML=\'<p style="font-size:16px;font-weight:700;text-align:center;margin:0 0 18px;">\'+q.q+\'</p><div style="display:flex;gap:14px;align-items:flex-start;">\'+\'<div class="conn-col">\'+lefts.map(function(o,i){return \'<div class="conn-item btn-op" id="cl\'+n+\'_\'+i+\'" onclick="var prev=document.getElementById(\\"cl\'+n+\'_\\"+G._connLeft);if(prev)prev.classList.remove(\\"sel\\");G._connLeft=\'+i+\';this.classList.add(\\"sel\\")">\'+o+\'</div>\';}).join(\'\')+\'</div>\'+\'<div style="display:flex;align-items:center;font-size:24px;opacity:.4;padding-top:20px;">→</div>\'+\'<div class="conn-col">\'+rights.map(function(o,i){return \'<div class="conn-item btn-op" id="cr\'+n+\'_\'+i+\'" onclick="if(G._connLeft<0)return;checkSala(\'+n+\',G._connLeft===0&&\'+i+\'===0||G._connLeft===1&&\'+i+\'===1?0:1)">\'+o+\'</div>\';}).join(\'\')+\'</div>\'+\'</div>\';'
  }
  // ── NUEVAS MECÁNICAS DE PARADIGMA ÚNICO ──
  ,{
    name:'Secuencia de Proceso',
    hint:'PARADIGMA ORDENAR PASOS — el usuario hace clic en los pasos EN ORDEN CORRECTO. PREGUNTAS: q=nombre del procedimiento; steps=array de 4 pasos EN ORDEN CORRECTO; sin opts ni correct. Los botones muestran ? hasta que se hacen clic; al clicar aparece el número de posición en el badge. Usa checkSeq(n,i).'
  }
  ,{
    name:'Inspector de Planta',
    hint:'PARADIGMA INSPECCIÓN — escena descrita + usuario identifica la anomalía. PREGUNTAS: q=pregunta de inspección; scene=descripción 2 oraciones de la situación; opts=[anomalía real, obs_normal_1, obs_normal_2, obs_normal_3]; correct=anomalía real. Panel escena con borde acento + título ANOMALÍA DETECTADA + 4 pills. Usa checkSala(n,i).'
  }
  ,{
    name:'Turno de Operario',
    hint:'PARADIGMA DECISIÓN-CONSECUENCIA — situación operacional crítica, usuario decide, si falla ve la consecuencia antes de continuar. PREGUNTAS: q=situación/dilema; opts=4 decisiones; correct=mejor decisión; consequence=qué ocurre en la planta al decidir mal (1 oración dramática). Panel oscuro con cabecera TURNO DE GUARDIA. Usa checkTurno(n,i).'
  }
  ,{name:'Cartas Ocultas',
    hint:'PARADIGMA FLIP-CARD — 4 cartas boca abajo con ?, usuario hace clic para revelar una a una con animación CSS flip, la correcta "brilla". PREGUNTAS: q, opts[4], correct, fb. Usa tapCard(n,i) → setTimeout(checkSala). Panel oscuro misterioso, cartas con perspective 3D.'
  }
  ,{name:'Francotirador',
    deprecated:true,
    hint:'PARADIGMA SHOOTER — 4 blancos circulares flotantes en posición aleatoria sobre fondo oscuro, cursor crosshair, usuario apunta y dispara al correcto. PREGUNTAS: q, opts[4], correct, fb. Usa checkSala(n,i). Efecto de explosión al acertar.'
  }
  ,{name:'Sala de Escape',
    hint:'PARADIGMA ESCAPE ROOM — presentado como "pista encontrada", 4 candados 🔒 con texto de opción, el correcto se abre al hacer clic. PREGUNTAS: q, opts[4], correct, fb. Usa checkSala(n,i). Framing narrativo de escape room, candados animados.'
  }
  // ── FASE M2: MECÁNICAS PREMIUM ──
  ,{name:'Checklist Crítico',
    hint:'PARADIGMA VERIFICACIÓN — el estudiante marca los pasos CRÍTICOS de un protocolo antes de continuar. NO es quiz MCQ. PREGUNTAS: q (caso o pregunta de verificación), items (array de 5-8 objetos {label,required}), minRequired, fb. Usa checkChecklist(n).'
  }
  // ── FASE M3: MECÁNICAS PREMIUM ──
  ,{name:'Error Hunter',
    hint:'PARADIGMA DETECCIÓN DE ERRORES — se muestra un texto, procedimiento, cálculo o caso con errores intencionados como chips resaltados y clickeables. El estudiante identifica cuál es el fragmento erróneo. PREGUNTAS: q, context (texto plano 300-900 chars), errorSpans (3-6 objetos {id,text,isError}; exactamente 1 isError:true), correct (id del error real), fb. Usa checkErrorHunter(n,id). Los chips se muestran bajo el contexto — no se insertan en el texto para evitar riesgos de HTML.'
  }
  // 31 Secuencia de Proceso Pro — reorder-cards paradigm (Fase M4)
  ,{name:'Secuencia de Proceso Pro',
    hint:'PARADIGMA REORDENAR PASOS — el estudiante usa botones ↑↓ para reordenar cards de un procedimiento y presiona VALIDAR SECUENCIA. NO es click-in-order. PREGUNTAS: q, steps (array de 4-7 objetos {id,label,order}; order inicia en 1), fb, tolerance (opcional, 0 por defecto). Usa checkSeqPro(n).'
  }
];

// ════ MECS STATIC IMPLEMENTATIONS ════
// qf = question format for AI prompt. rf = renderArea function (extracted with .toString() at build time).
// AI generates ONLY question data JSON; engine HTML is static. Truncation is impossible.
(function addMecsImpl(){
  var impls=[
    // 0 Quiz Clásico
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var keys=['A','B','C','D'];var html='<p style="font-size:16px;font-weight:700;margin:0 0 18px;line-height:1.5;padding:0 2px;">'+q.q+'</p>';G.currentOpts.forEach(function(o,i){html+='<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:flex;align-items:center;width:100%;padding:11px 14px;margin:7px 0;border-radius:10px;cursor:pointer;text-align:left;font-family:inherit;font-weight:600;font-size:14px;gap:12px;"><span style="min-width:28px;height:28px;border-radius:6px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);display:flex;align-items:center;justify-content:center;font-weight:900;font-size:13px;flex-shrink:0;letter-spacing:0;">'+keys[i]+'</span><span style="line-height:1.3;">'+o+'</span></button>';});area.innerHTML=html;}catch(e){console.error('renderArea',e);}}},
    // 1 V/F Speedrun
    {qf:'{"q":"afirmación verdadera o falsa","opts":["VERDADERO","FALSO"],"correct":"VERDADERO o FALSO","fb":"feedback"} — opts SIEMPRE ["VERDADERO","FALSO"]',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=(q.opts&&q.opts.length===2)?q.opts.slice():['VERDADERO','FALSO'];var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="background:linear-gradient(135deg,rgba(255,255,255,.07),rgba(255,255,255,.03));border:1.5px solid rgba(255,255,255,.2);border-radius:14px;padding:20px 16px;text-align:center;font-size:16px;font-weight:700;line-height:1.45;margin-bottom:16px;">'+q.q+'</div><div style="display:flex;gap:12px;height:120px;"><button class="btn-op" onclick="checkSala('+n+',0)" style="flex:1;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:linear-gradient(160deg,rgba(34,197,94,.35) 0%,rgba(16,185,129,.15) 100%);border:2px solid rgba(34,197,94,.6);font-family:inherit;"><span style="font-size:34px;">✅</span><span style="font-size:15px;font-weight:900;letter-spacing:.5px;">'+G.currentOpts[0]+'</span></button><button class="btn-op" onclick="checkSala('+n+',1)" style="flex:1;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:linear-gradient(160deg,rgba(239,68,68,.35) 0%,rgba(220,38,38,.15) 100%);border:2px solid rgba(239,68,68,.6);font-family:inherit;"><span style="font-size:34px;">❌</span><span style="font-size:15px;font-weight:900;letter-spacing:.5px;">'+G.currentOpts[1]+'</span></button></div>';}catch(e){console.error('renderArea',e);}}},
    // 2 Boss Fight
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback","bossEmoji":"👹","bossName":"Nombre Jefe"} — añade bossEmoji y bossName a CADA pregunta del array',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var total=PREGUNTAS['sala'+n].length;var hp=Math.max(10,Math.round((1-(G.idx/total))*100));area.innerHTML='<div style="font-size:72px;text-align:center;margin-bottom:6px;">'+(q.bossEmoji||'👾')+'</div><p style="text-align:center;font-weight:700;margin:0 0 8px;">'+(q.bossName||'JEFE')+'</p><div style="height:14px;border-radius:7px;overflow:hidden;background:rgba(255,255,255,.15);margin-bottom:14px;"><div style="height:100%;background:#22c55e;width:'+hp+'%;transition:width 0.5s;"></div></div><p style="font-size:15px;font-weight:600;margin-bottom:12px;">'+q.q+'</p>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:block;width:100%;padding:11px;margin:4px 0;border-radius:8px;cursor:pointer;font-size:14px;text-align:left;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('');}catch(e){console.error('renderArea',e);}}},
    // 3 Hot or Not
    {qf:'{"q":"afirmación a evaluar","opts":["CORRECTO","INCORRECTO"],"correct":"CORRECTO o INCORRECTO","fb":"feedback"} — opts SIEMPRE ["CORRECTO","INCORRECTO"]',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=(q.opts&&q.opts.length===2)?q.opts.slice():['CORRECTO','INCORRECTO'];var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<style>.hon-cd:hover{transform:rotate(1.5deg) scale(1.02);box-shadow:0 8px 30px rgba(0,0,0,.4);}</style><div class="hon-cd" style="background:linear-gradient(135deg,rgba(255,255,255,.09),rgba(255,255,255,.04));border:1.5px solid rgba(255,255,255,.22);border-radius:20px;padding:22px 18px;text-align:center;font-size:16px;font-weight:700;line-height:1.45;margin-bottom:14px;transition:transform .2s,box-shadow .2s;cursor:default;">'+q.q+'</div><div style="display:flex;gap:12px;"><button class="btn-op" onclick="checkSala('+n+',0)" style="flex:1;height:90px;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:linear-gradient(160deg,rgba(34,197,94,.3),rgba(16,185,129,.12));border:2px solid rgba(34,197,94,.55);font-family:inherit;"><span style="font-size:30px;">🔥</span><span style="font-size:13px;font-weight:800;letter-spacing:.5px;">'+G.currentOpts[0]+'</span></button><button class="btn-op" onclick="checkSala('+n+',1)" style="flex:1;height:90px;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:linear-gradient(160deg,rgba(239,68,68,.3),rgba(220,38,38,.12));border:2px solid rgba(239,68,68,.55);font-family:inherit;"><span style="font-size:30px;">💀</span><span style="font-size:13px;font-weight:800;letter-spacing:.5px;">'+G.currentOpts[1]+'</span></button></div>';}catch(e){console.error('renderArea',e);}}},
    // 4 Tarjetas Reveal
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var cname='trc'+n;var html='<style>.'+cname+'{filter:blur(5px);opacity:.4;transition:filter .25s,opacity .25s,transform .15s}.'+cname+':hover{filter:none;opacity:1;transform:scale(1.05)}</style><p style="font-size:15px;font-weight:700;text-align:center;margin-bottom:14px;line-height:1.4;">'+q.q+'</p><p style="font-size:10px;opacity:.4;text-align:center;margin:-8px 0 14px;text-transform:uppercase;letter-spacing:1.5px;">&#128065; Pasa el cursor para revelar</p><div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">';G.currentOpts.forEach(function(o,i){html+='<button class="btn-op '+cname+'" onclick="checkSala('+n+','+i+')" style="width:138px;height:96px;border-radius:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;text-align:center;padding:10px;line-height:1.3;font-family:inherit;font-weight:700;">'+o+'</button>';});html+='</div>';area.innerHTML=html;}catch(e){console.error('renderArea',e);}}},
    // 5 Grid 2×2
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var icons=['▲','◆','●','✶'];var bgs=['linear-gradient(135deg,rgba(239,68,68,.3),rgba(220,38,38,.12))','linear-gradient(135deg,rgba(59,130,246,.3),rgba(37,99,235,.12))','linear-gradient(135deg,rgba(234,179,8,.3),rgba(202,138,4,.12))','linear-gradient(135deg,rgba(34,197,94,.3),rgba(16,185,129,.12))'];var borders=['rgba(239,68,68,.6)','rgba(59,130,246,.6)','rgba(234,179,8,.6)','rgba(34,197,94,.6)'];var html='<p style="font-size:15px;font-weight:700;margin:0 0 14px;line-height:1.4;text-align:center;padding:0 4px;">'+q.q+'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">';G.currentOpts.forEach(function(o,i){html+='<button class="btn-op" onclick="checkSala('+n+','+i+')" style="height:100px;border-radius:14px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;background:'+bgs[i]+';border:2px solid '+borders[i]+';padding:10px;box-sizing:border-box;font-family:inherit;"><span style="font-size:24px;opacity:.9;">'+icons[i]+'</span><span style="font-size:12px;font-weight:700;line-height:1.3;text-align:center;">'+o+'</span></button>';});html+='</div>';area.innerHTML=html;}catch(e){console.error('renderArea',e);}}},
    // 6 Carrusel Horizontal
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<p style="font-size:17px;font-weight:700;margin-bottom:12px;line-height:1.4;">'+q.q+'</p><div style="display:flex;gap:12px;overflow-x:auto;padding:4px 0 12px;scrollbar-width:none;-webkit-overflow-scrolling:touch;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="min-width:150px;height:110px;border-radius:16px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:14px;font-size:14px;line-height:1.3;font-weight:700;font-family:inherit;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 7 Neon Selector
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var html='<style>@keyframes neonPulse'+n+'{0%,100%{box-shadow:0 0 8px var(--accent),0 0 20px rgba(255,255,255,.05)}50%{box-shadow:0 0 18px var(--accent),0 0 40px var(--accent),0 0 6px #fff}}.np'+n+':hover{animation:neonPulse'+n+' .8s ease-in-out infinite!important;border-color:var(--accent)!important;}</style><p style="font-size:16px;font-weight:700;margin:0 0 18px;line-height:1.5;border-left:3px solid var(--accent);padding-left:12px;">'+q.q+'</p>';G.currentOpts.forEach(function(o,i){html+='<button class="btn-op np'+n+'" onclick="checkSala('+n+','+i+')" style="display:flex;align-items:center;width:100%;padding:14px 20px;margin:8px 0;border-radius:50px;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;border:1.5px solid rgba(255,255,255,.2);gap:14px;transition:box-shadow .3s,border-color .3s;"><span style="width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px var(--accent),0 0 14px var(--accent);flex-shrink:0;"></span>'+o+'</button>';});area.innerHTML=html;}catch(e){console.error('renderArea',e);}}},
    // 8 Pictogram Quiz
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var nums=['\u2460','\u2461','\u2462','\u2463'];area.innerHTML='<p style="font-size:17px;font-weight:700;text-align:center;margin-bottom:16px;line-height:1.4;">'+q.q+'</p><div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="width:132px;height:104px;border-radius:16px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px;"><span style="font-size:26px;">'+nums[i%4]+'</span><span style="font-size:12px;text-align:center;line-height:1.3;font-family:inherit;font-weight:700;">'+o+'</span></button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 9 Elimina el Intruso
    {qf:'{"q":"nombre del grupo/categoría","opts":["intruso","pertenece1","pertenece2","pertenece3"],"correct":"intruso","fb":"feedback"} — correct ES el elemento que NO pertenece al grupo',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var html='<style>@keyframes eiS'+n+'{0%,100%{transform:translateX(0)}20%{transform:translateX(-6px)}50%{transform:translateX(6px)}80%{transform:translateX(-3px)}}.eit-b'+n+':hover{transform:scale(1.06);transition:transform .15s}</style><p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.5;margin:0 0 6px;">&#128269; Encuentra el intruso</p><p style="font-size:18px;font-weight:800;margin:0 0 18px;padding:10px 14px;background:rgba(255,255,255,.06);border-radius:10px;border-left:3px solid var(--accent);">'+q.q+'</p><div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:center;">';G.currentOpts.forEach(function(o,i){html+='<button class="btn-op eit-b'+n+'" onclick="checkSala('+n+','+i+')" style="padding:14px 24px;border-radius:50px;cursor:pointer;font-size:14px;font-weight:700;font-family:inherit;transition:transform .15s;">'+o+'</button>';});html+='</div>';area.innerHTML=html;}catch(e){console.error('renderArea',e);}}},
    // 10 Speed Round
    {qf:'{"q":"pregunta corta y directa","opts":["opcionA","opcionB"],"correct":"opcionA o opcionB","fb":"feedback"} — opts EXACTAMENTE 2 opciones',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts&&q.opts.length>=2)?q.opts.slice(0,2):['Verdadero','Falso']);var area=document.getElementById('area'+n);if(!area)return;var total=PREGUNTAS['sala'+n].length;area.innerHTML='<div style="height:4px;border-radius:2px;overflow:hidden;margin-bottom:22px;background:rgba(255,255,255,.1);"><div style="height:100%;background:var(--accent);width:'+Math.round(G.idx/(total||1)*100)+'%;transition:width .3s;"></div></div><p style="font-size:22px;font-weight:700;text-align:center;margin-bottom:22px;line-height:1.3;">'+q.q+'</p><div style="display:flex;gap:12px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="flex:1;height:66px;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 11 Caso de Estudio
    {qf:'{"q":"pregunta sobre el caso","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback","scenario":"descripción del caso real en 1-2 oraciones"} — añade campo scenario a cada pregunta',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML=(q.scenario?'<div style="border-left:4px solid var(--accent);padding:14px 16px;border-radius:0 12px 12px 0;background:rgba(255,255,255,.05);margin-bottom:14px;font-size:14px;line-height:1.5;">'+q.scenario+'</div>':'')+'<p style="font-size:16px;font-weight:600;margin-bottom:14px;">'+q.q+'</p>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:block;width:100%;padding:12px 16px;margin:5px 0;border-radius:9px;text-align:left;cursor:pointer;font-size:14px;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('');}catch(e){console.error('renderArea',e);}}},
    // 12 Diagnóstico Sectorial
    {qf:'{"q":"s\u00edntoma o problema observado en el sector","opts":["causa correcta","causa falsa1","causa falsa2","causa falsa3"],"correct":"causa correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="display:flex;align-items:flex-start;gap:12px;border-radius:12px;padding:14px;background:rgba(255,100,0,.1);border:1px solid rgba(255,100,0,.35);margin-bottom:14px;"><span style="font-size:22px;">\u26a0\ufe0f</span><div><p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.65;margin:0 0 5px;">PROBLEMA DETECTADO</p><p style="font-size:15px;font-weight:600;margin:0;">'+q.q+'</p></div></div>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:flex;align-items:center;width:100%;padding:11px 14px;margin:5px 0;border-radius:9px;border-left:3px solid rgba(255,120,0,.6);cursor:pointer;font-size:14px;text-align:left;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('');}catch(e){console.error('renderArea',e);}}},
    // 13 Selector Circular
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="border-radius:100px;padding:16px 20px;font-size:16px;font-weight:600;text-align:center;margin-bottom:16px;border:2px solid rgba(255,255,255,.2);">'+q.q+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="height:90px;border-radius:20px;display:flex;align-items:center;justify-content:center;text-align:center;font-size:13px;padding:12px;cursor:pointer;line-height:1.3;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 14 Match de Tarjetas
    {qf:'{"q":"T\u00c9RMINO a identificar","opts":["definici\u00f3n correcta","def falsa1","def falsa2","def falsa3"],"correct":"definici\u00f3n correcta","fb":"feedback"} — q=T\u00c9RMINO, opts=DEFINICIONES',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="font-size:20px;font-weight:800;text-align:center;padding:20px;border-radius:16px;margin-bottom:14px;background:rgba(255,255,255,.08);line-height:1.3;">'+q.q+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="padding:16px 12px;border-radius:14px;font-size:12px;cursor:pointer;text-align:left;line-height:1.4;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 15 Simulador de Decisiones
    {qf:'{"q":"situaci\u00f3n real del sector que requiere decisi\u00f3n","opts":["mejor decisi\u00f3n","incorrecta1","incorrecta2","incorrecta3"],"correct":"mejor decisi\u00f3n","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var lbl=['A','B','C','D'];area.innerHTML='<div style="border-radius:12px;padding:16px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);margin-bottom:14px;"><p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin:0 0 8px;">SITUACI\u00d3N</p><p style="font-size:15px;font-weight:600;margin:0;line-height:1.4;">'+q.q+'</p></div><p style="font-size:13px;opacity:.75;margin-bottom:10px;">\u00bfQu\u00e9 decisi\u00f3n tomar\u00edas?</p>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;margin:5px 0;border-radius:10px;cursor:pointer;text-align:left;font-size:13px;font-family:inherit;"><span style="min-width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;background:rgba(255,255,255,.15);">'+lbl[i]+'</span><span>'+o+'</span></button>';}).join('');}catch(e){console.error('renderArea',e);}}},
    // 16 Cronología Interactiva
    {qf:'{"q":"evento o hito","opts":["per\u00edodo correcto","per\u00edodo falso1","per\u00edodo falso2","per\u00edodo falso3"],"correct":"per\u00edodo correcto","fb":"feedback"} — q=EVENTO, opts=PER\u00cdODOS/FECHAS',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="border-radius:12px;padding:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);margin-bottom:22px;font-size:15px;font-weight:600;text-align:center;line-height:1.4;">'+q.q+'</div><div style="position:relative;display:flex;justify-content:space-between;align-items:flex-start;padding:20px 0 0;"><div style="position:absolute;top:6px;left:8%;right:8%;height:2px;background:rgba(255,255,255,.25);"></div>'+G.currentOpts.map(function(o,i){return '<button onclick="checkSala('+n+','+i+')" style="position:relative;flex:1;background:none;border:none;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:8px;padding:0 4px;font-family:inherit;"><div style="width:14px;height:14px;border-radius:50%;background:var(--accent);border:2px solid rgba(0,0,0,.3);"></div><span style="font-size:11px;font-weight:700;text-align:center;line-height:1.3;color:var(--text);">'+o+'</span></button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 17 Galería de Conceptos
    {qf:'{"q":"DEFINICI\u00d3N del concepto","opts":["t\u00e9rmino correcto","t\u00e9rmino falso1","t\u00e9rmino falso2","t\u00e9rmino falso3"],"correct":"t\u00e9rmino correcto","fb":"feedback"} — q=DEFINICI\u00d3N, opts=T\u00c9RMINOS',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="border-radius:14px;padding:20px;font-size:16px;line-height:1.5;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);margin-bottom:16px;text-align:center;">'+q.q+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="padding:18px 12px;border-radius:14px;font-size:15px;font-weight:700;cursor:pointer;text-align:center;font-family:inherit;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 18 Arrastra y Suelta
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;G._dragSel=-1;area.innerHTML='<style>.dc'+n+'{padding:12px 18px;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;border:1px solid var(--btnb);background:var(--btn);color:var(--btnt);font-family:inherit;transition:transform .15s,box-shadow .15s;user-select:none;display:inline-block;}.dc'+n+'.sel{transform:scale(1.06);box-shadow:0 0 0 3px var(--accent);}.dz'+n+'{border:2px dashed rgba(255,255,255,.3);border-radius:16px;padding:32px 20px;text-align:center;font-size:15px;cursor:pointer;transition:background .2s;}.dz'+n+'.ready{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.7);}</style><p style="font-size:13px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin-bottom:8px;">\u2460 Selecciona \u00b7 \u2461 Suelta en la zona</p><p style="font-size:17px;font-weight:700;margin:0 0 16px;line-height:1.4;">'+q.q+'</p><div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:20px;">'+G.currentOpts.map(function(o,i){return '<div class="dc'+n+'" id="dc'+n+'_'+i+'" onclick="var p=document.querySelector(\'.dc'+n+'.sel\');if(p)p.classList.remove(\'sel\');this.classList.add(\'sel\');G._dragSel='+i+';var z=document.getElementById(\'dz'+n+'\');if(z)z.classList.add(\'ready\')">'+o+'</div>';}).join('')+'</div><div class="dz'+n+'" id="dz'+n+'" onclick="if(G._dragSel>=0)checkSala('+n+',G._dragSel)">\uD83D\uDCE5 Suelta aqu\u00ed la respuesta correcta</div>';}catch(e){console.error('renderArea',e);}}},
    // 19 Defuse la Bomba
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<style>@keyframes tick'+n+'{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}.bomb'+n+'{animation:tick'+n+' 0.4s ease-in-out infinite;}</style><p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.5;margin-bottom:8px;">\u26a1 DESACTIVA LA BOMBA CORRECTA</p><p style="font-size:16px;font-weight:700;margin:0 0 20px;line-height:1.4;text-align:center;">'+q.q+'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op bomb'+n+'" onclick="this.style.animation=\'none\';checkSala('+n+','+i+')" style="height:110px;border-radius:18px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;font-size:12px;font-weight:700;padding:10px;font-family:inherit;"><span style="font-size:38px;line-height:1;">\uD83D\uDCA3</span><span style="line-height:1.3;text-align:center;">'+o+'</span></button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 20 Kahoot Relámpago
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var clrs=['#EF4444','#3B82F6','#EAB308','#22C55E'],sym=['\u25b2','\u25c6','\u25cf','\u273f'];area.innerHTML='<style>@keyframes kcd'+n+'{from{width:100%}to{width:0%}}.kb'+n+'{animation:kcd'+n+' 20s linear forwards;}</style><div style="height:8px;border-radius:4px;overflow:hidden;margin-bottom:18px;background:rgba(255,255,255,.12);"><div class="kb'+n+'" style="height:100%;border-radius:4px;background:var(--accent);"></div></div><p style="font-size:21px;font-weight:800;text-align:center;margin:0 0 20px;line-height:1.3;">'+q.q+'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'+G.currentOpts.map(function(o,i){return '<button onclick="checkSala('+n+','+i+')" style="height:80px;border-radius:14px;font-size:13px;font-weight:800;cursor:pointer;background:'+clrs[i%4]+';color:#fff;border:none;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;text-align:center;line-height:1.3;"><span style="font-size:22px;flex-shrink:0;">'+sym[i%4]+'</span>'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 21 Rueda de Conceptos
    {qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var pos=['top:0;left:50%;transform:translateX(-50%)','top:50%;right:0;transform:translateY(-50%)','bottom:0;left:50%;transform:translateX(-50%)','top:50%;left:0;transform:translateY(-50%)'];area.innerHTML='<p style="font-size:14px;font-weight:700;text-align:center;margin-bottom:16px;opacity:.8;">'+q.q+'</p><div style="position:relative;width:290px;height:290px;margin:0 auto;"><div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:80px;height:80px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;z-index:2;background:var(--btn);border:2px solid var(--btnb);">\uD83C\uDFAF</div>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="position:absolute;width:100px;height:70px;'+pos[i%4]+';border-radius:14px;cursor:pointer;font-size:12px;font-weight:600;padding:8px;line-height:1.3;text-align:center;font-family:inherit;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 22 Conectar Flechas (término grande a la izquierda, definiciones a la derecha)
    {qf:'{"q":"T\u00c9RMINO o concepto a definir","opts":["definici\u00f3n correcta","def falsa1","def falsa2","def falsa3"],"correct":"definici\u00f3n correcta","fb":"feedback"} — q=T\u00c9RMINO, opts=DEFINICIONES',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<p style="font-size:12px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin-bottom:12px;">Conecta el t\u00e9rmino con su definici\u00f3n</p><div style="display:flex;gap:14px;align-items:flex-start;"><div style="flex:1;background:rgba(255,255,255,.08);border-radius:14px;padding:18px;font-size:16px;font-weight:800;line-height:1.4;border:1px solid var(--btnb);text-align:center;">'+q.q+'</div><div style="font-size:28px;opacity:.4;padding-top:18px;">\u2192</div><div style="flex:1;display:flex;flex-direction:column;gap:10px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="padding:14px;border-radius:12px;font-size:13px;cursor:pointer;text-align:left;line-height:1.3;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('')+'</div></div>';}catch(e){console.error('renderArea',e);}}},
    // 23 Secuencia de Proceso — click-in-order paradigm
    {qf:'{"q":"nombre del procedimiento a ordenar","steps":["Paso 1 en orden correcto","Paso 2","Paso 3","Paso 4"],"fb":"retroalimentación"} — steps es el orden CORRECTO; NO incluyas opts ni correct',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.steps||['?','?','?','?']).slice());G._seqSel=[];var area=document.getElementById('area'+n);if(!area)return;var total=PREGUNTAS['sala'+n].length;area.innerHTML='<p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin-bottom:6px;">① Selecciona los pasos en orden correcto</p><p style="font-size:16px;font-weight:700;margin:0 0 14px;line-height:1.4;">'+q.q+'</p><div style="display:flex;flex-direction:column;gap:8px;">'+G.currentOpts.map(function(o,i){return '<button id="seqb_'+n+'_'+i+'" class="btn-op" onclick="checkSeq('+n+','+i+')" style="display:flex;align-items:center;gap:12px;width:100%;padding:13px 16px;border-radius:10px;cursor:pointer;text-align:left;font-size:14px;font-family:inherit;font-weight:700;"><span id="seqn_'+n+'_'+i+'" style="min-width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;background:rgba(255,255,255,.12);flex-shrink:0;">?</span><span>'+o+'</span></button>';}).join('')+'</div><p style="font-size:12px;opacity:.45;margin-top:10px;text-align:center;">Pregunta '+(G.idx+1)+' de '+total+'</p>';}catch(e){console.error('renderArea',e);}}},
    // 24 Inspector de Planta — scene inspection paradigm
    {qf:'{"q":"¿Qué anomalía debes identificar?","scene":"descripción de la escena/situación en 2 oraciones","opts":["anomalía o riesgo real","observación normal 1","observación normal 2","observación normal 3"],"correct":"anomalía o riesgo real","fb":"retroalimentación"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML=(q.scene?'<div style="border-left:3px solid var(--accent);padding:12px 16px;border-radius:0 12px 12px 0;background:rgba(255,255,255,.05);margin-bottom:14px;font-size:13px;line-height:1.5;"><span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;opacity:.6;">📋 ESCENA</span><br>'+q.scene+'</div>':'')+'<p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin-bottom:6px;">🔍 ¿Qué anomalía o riesgo detectas?</p><p style="font-size:16px;font-weight:700;margin-bottom:14px;line-height:1.4;">'+q.q+'</p><div style="display:flex;flex-wrap:wrap;gap:8px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="width:100%;padding:11px 16px;border-radius:8px;cursor:pointer;font-size:13px;font-family:inherit;font-weight:700;display:flex;align-items:center;gap:6px;box-sizing:border-box;"><span style="opacity:.5;font-size:10px;">○</span>'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}},
    // 25 Turno de Operario — consequence-driven decision paradigm
    {qf:'{"q":"situación operacional crítica que requiere decisión","opts":["decisión correcta","decisión incorrecta 1","decisión incorrecta 2","decisión incorrecta 3"],"correct":"decisión correcta","consequence":"qué ocurre en la instalación si se toma la decisión incorrecta (1 oración)","fb":"retroalimentación"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var lbl=['A','B','C','D'];area.innerHTML='<div style="border-radius:12px;padding:16px;background:linear-gradient(135deg,rgba(255,255,255,.08),rgba(255,255,255,.04));border:1px solid rgba(255,255,255,.18);margin-bottom:14px;"><p style="font-size:10px;text-transform:uppercase;letter-spacing:1.5px;opacity:.55;margin:0 0 10px;">⏱ TURNO DE GUARDIA — DECISIÓN REQUERIDA</p><p style="font-size:15px;font-weight:700;margin:0;line-height:1.5;">'+q.q+'</p></div><p style="font-size:12px;opacity:.6;margin-bottom:10px;">¿Qué harías en esta situación?</p>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkTurno('+n+','+i+')" style="display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;margin:5px 0;border-radius:10px;cursor:pointer;text-align:left;font-size:13px;font-family:inherit;font-weight:700;"><span style="min-width:26px;height:26px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;background:rgba(255,255,255,.12);flex-shrink:0;">'+lbl[i%4]+'</span><span style="line-height:1.4;">'+o+'</span></button>';}).join('');}catch(e){console.error('renderArea',e);}}}
  
  // 26 Cartas Ocultas — flip-card paradigm (texto visible al frente, flip = confirmación)
  ,{qf:'{"q":"pregunta sobre concepto/término del sector","opts":["respuesta correcta","distractor plausible 1","distractor plausible 2","distractor plausible 3"],"correct":"respuesta correcta","fb":"retroalimentación breve"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var html='<div style="padding:6px 0 10px;"><p style="font-size:15px;font-weight:700;line-height:1.5;margin:0 0 6px;text-align:center;padding:0 4px;">'+q.q+'</p><p style="font-size:10px;opacity:.45;text-align:center;margin:0 0 14px;text-transform:uppercase;letter-spacing:1px;">Selecciona la carta correcta</p><style>.fc-wrap{perspective:700px;cursor:pointer}.fc-inner{position:relative;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d}.fc-wrap.flipped .fc-inner{transform:rotateY(180deg)}.fc-front,.fc-back{position:absolute;inset:0;backface-visibility:hidden;border-radius:12px;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;text-align:center;line-height:1.3}.fc-front{background:linear-gradient(135deg,rgba(99,102,241,.35),rgba(139,92,246,.25));border:2px solid rgba(167,139,250,.55);font-size:13px;font-weight:700;color:#e9d5ff}.fc-back{transform:rotateY(180deg);font-size:22px;display:flex;align-items:center;justify-content:center}.fc-wrap.ok .fc-front{border-color:rgba(34,197,94,.8);background:linear-gradient(135deg,rgba(34,197,94,.3),rgba(16,185,129,.15));box-shadow:0 0 16px rgba(34,197,94,.4)}.fc-wrap.ng .fc-front{border-color:rgba(239,68,68,.7);background:linear-gradient(135deg,rgba(239,68,68,.25),rgba(239,68,68,.1))}</style><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;height:190px;">';for(var k=0;k<G.currentOpts.length;k++){html+='<div class="fc-wrap" id="fc_'+n+'_'+k+'" onclick="tapCard('+n+','+k+')" style="height:90px;"><div class="fc-inner"><div class="fc-front">'+G.currentOpts[k]+'</div><div class="fc-back">✅</div></div></div>';}html+='</div></div>';area.innerHTML=html;}catch(e){}}
  }
  // 27 Francotirador — shooter targets paradigm
  ,{qf:'{"q":"pregunta directa sobre concepto o dato del sector","opts":["opción A CORTA máx 4 palabras","opción B CORTA máx 4 palabras","opción C CORTA máx 4 palabras","opción D CORTA máx 4 palabras"],"correct":"opción correcta (igual que en opts)","fb":"retroalimentación breve"} — CRÍTICO: opts deben ser MUY CORTAS (máx 4-5 palabras), para caber en blancos circulares. Si el concepto es largo, abrevia (ej: "Mitosis", "Selección natural", "ADN polimerasa")',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var lbls=['A','B','C','D'];var positions=[{top:'8%',left:'5%'},{top:'6%',left:'52%'},{top:'50%',left:'12%'},{top:'48%',left:'58%'}];var html='<div style="padding:0 4px 10px;"><p style="font-size:15px;font-weight:700;line-height:1.5;margin:0 0 8px;text-align:center;">'+q.q+'</p><p style="font-size:10px;opacity:.5;margin:0 0 8px;letter-spacing:1px;text-transform:uppercase;text-align:center;">⊕ Apunta y dispara al blanco correcto</p><div id="range_'+n+'" style="position:relative;width:100%;height:200px;background:radial-gradient(ellipse at center,rgba(20,30,15,.95),rgba(5,10,5,1));border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);cursor:crosshair;margin-bottom:10px;">';for(var k=0;k<G.currentOpts.length;k++){var p=positions[k];html+='<div onclick="checkSala('+n+','+k+')" style="position:absolute;top:'+p.top+';left:'+p.left+';width:88px;height:88px;background:radial-gradient(circle,rgba(255,80,0,.2) 0%,transparent 70%);border:2.5px solid rgba(255,80,0,.75);border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:crosshair;box-sizing:border-box;transition:background .15s;" onmouseover="this.style.background=\'radial-gradient(circle,rgba(255,120,0,.45) 0%,rgba(255,80,0,.1) 70%)\'" onmouseout="this.style.background=\'radial-gradient(circle,rgba(255,80,0,.2) 0%,transparent 70%)\'"><span style="font-size:22px;font-weight:900;color:rgba(255,150,80,.9);line-height:1;">'+lbls[k]+'</span><span style="width:50%;height:1px;background:rgba(255,100,0,.4);margin:3px 0;"></span><span style="font-size:9px;font-weight:700;color:rgba(255,200,150,.6);letter-spacing:1px;">BLANCO</span></div>';}html+='</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">';for(var k=0;k<G.currentOpts.length;k++){html+='<div style="display:flex;align-items:center;gap:8px;background:rgba(255,80,0,.08);border:1px solid rgba(255,80,0,.25);border-radius:8px;padding:7px 10px;"><span style="font-size:13px;font-weight:900;color:rgba(255,150,80,.9);flex-shrink:0;">'+lbls[k]+'</span><span style="font-size:12px;font-weight:600;line-height:1.3;color:rgba(255,220,180,.85);">'+G.currentOpts[k]+'</span></div>';}html+='</div></div>';area.innerHTML=html;}catch(e){}}
  }
  // 28 Sala de Escape — escape room padlock paradigm
  ,{qf:'{"q":"pista encontrada que describe una situación del sector y requiere la respuesta correcta para avanzar","opts":["respuesta correcta","pista falsa 1","pista falsa 2","pista falsa 3"],"correct":"respuesta correcta","fb":"retroalimentación narrativa breve en tono de escape room"}',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var html='<div style="text-align:center;padding:8px 4px 14px;"><div style="background:linear-gradient(135deg,rgba(251,191,36,.08),rgba(245,158,11,.04));border:1px solid rgba(251,191,36,.25);border-radius:10px;padding:12px;margin-bottom:14px;"><p style="font-size:10px;text-transform:uppercase;letter-spacing:2px;opacity:.6;margin:0 0 8px;">🔍 PISTA ENCONTRADA</p><p style="font-size:15px;font-weight:700;line-height:1.5;margin:0;">'+q.q+'</p></div><p style="font-size:11px;opacity:.5;margin:0 0 12px;letter-spacing:1px;">Desbloquea el candádo correcto para escapar</p><div style="display:flex;flex-direction:column;gap:10px;">';for(var k=0;k<G.currentOpts.length;k++){html+='<button id="lock_'+n+'_'+k+'" onclick="checkSala('+n+','+k+')" style="background:linear-gradient(135deg,rgba(255,255,255,.06),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.2);border-radius:10px;padding:12px 16px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:10px;text-align:left;transition:all .2s;">🔒 '+G.currentOpts[k]+'</button>';}html+='</div></div>';area.innerHTML=html;}catch(e){}}
  }
  // 29 Checklist Crítico — multi-select verification paradigm
  ,{qf:'{"q":"Pregunta o caso clínico/operacional que requiere verificación de protocolo","items":[{"label":"Paso crítico 1 del protocolo","required":true},{"label":"Paso crítico 2 del protocolo","required":true},{"label":"Paso crítico 3 del protocolo","required":true},{"label":"Paso recomendado pero no obligatorio 1","required":false},{"label":"Paso recomendado pero no obligatorio 2","required":false}],"minRequired":3,"fb":"Retroalimentación educativa explicando por qué esos pasos son críticos"} — REGLAS OBLIGATORIAS: items entre 5 y 8 objetos; mínimo 2 required:true y mínimo 2 required:false; minRequired = número total de ítems con required:true; label debe ser claro y corto (máx 12 palabras); NO incluyas opts ni correct; solo JSON puro sin markdown',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];var area=document.getElementById('area'+n);if(!area)return;var items=q.items;if(!Array.isArray(items)||items.length<2){items=[{label:'Verificar condiciones de seguridad del área',required:true},{label:'Confirmar identidad y datos del receptor o insumo',required:true},{label:'Revisar dosis, especificación o concentración exacta',required:true},{label:'Registrar en el sistema de trazabilidad interno',required:false},{label:'Notificar al supervisor del turno correspondiente',required:false}];}items=shuffle(items.slice());q.items=items;var reqCount=items.filter(function(it){return it.required;}).length;G._cklSel=items.map(function(){return false;});var html='<p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.5;margin:0 0 6px;">☑ PROTOCOLO DE VERIFICACIÓN</p>'+'<p style="font-size:17px;font-weight:700;margin:0 0 8px;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;">'+q.q+'</p>'+'<p style="font-size:12px;opacity:.65;margin:0 0 12px;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;">Marca los <strong>'+reqCount+'</strong> paso(s) <strong>críticos y obligatorios</strong> del protocolo.</p>'+'<div style="display:flex;flex-direction:column;gap:8px;">';items.forEach(function(it,k){html+='<div id="ckcard_'+n+'_'+k+'" onclick="_cklToggle('+n+','+k+')" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:10px;border:1.5px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);cursor:pointer;transition:border-color .15s,background .15s;-webkit-tap-highlight-color:transparent;">'+'<span id="ckdot_'+n+'_'+k+'" style="min-width:22px;height:22px;border-radius:5px;border:2px solid rgba(255,255,255,.35);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:900;flex-shrink:0;transition:all .15s;"></span>'+'<span style="font-size:14px;font-weight:600;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;text-align:left;">'+it.label+'</span>'+'</div>';});html+='</div>'+'<button id="ckbtn_'+n+'" onclick="checkChecklist('+n+')" style="margin-top:14px;width:100%;padding:14px;border-radius:10px;background:var(--accent);color:#000;font-weight:800;font-size:15px;cursor:pointer;border:none;font-family:system-ui,-apple-system,sans-serif;letter-spacing:.5px;">☑ VALIDAR PROTOCOLO</button>';area.innerHTML=html;}catch(e){console.error('renderArea checklist',e);}}
  }
  // 30 Error Hunter — find-the-error paradigm (Fase M3)
  // context mostrado como texto plano + chips clickeables debajo — nunca innerHTML injection
  ,{qf:'{"q":"Instrucción de detección: ¿Qué fragmento contiene el error?","context":"Texto plano de 300-900 caracteres con un procedimiento, cálculo, prescripción, configuración o caso. SIN HTML. SIN markdown. Solo texto. El error debe estar escrito de forma natural dentro del contexto.","errorSpans":[{"id":"e1","text":"fragmento del contexto que contiene el ERROR REAL (máx 10 palabras)","isError":true},{"id":"e2","text":"fragmento del contexto sospechoso pero correcto (máx 10 palabras)","isError":false},{"id":"e3","text":"otro fragmento del contexto sospechoso pero correcto (máx 10 palabras)","isError":false}],"correct":"e1","fb":"Retroalimentación educativa explicando por qué ese fragmento es el error y cuál es la forma correcta"} — REGLAS CRÍTICAS: context entre 300 y 900 chars; errorSpans entre 3 y 6 elementos; exactamente 1 isError:true; correct = id del isError:true; cada errorSpan.text debe aparecer literalmente en context; NO incluyas opts ni correct de MCQ; solo JSON puro sin markdown',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];var area=document.getElementById('area'+n);if(!area)return;function _ehEsc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}var ctx=q.context;var spans=q.errorSpans;var fallback=false;if(!ctx||String(ctx).length<10){ctx='Error en el procedimiento de bloqueo de energía: el técnico aplica el candado antes de verificar que la máquina está apagada, omite comunicar al supervisor y no verifica la ausencia de voltaje residual con el multímetro.';fallback=true;}if(!Array.isArray(spans)||spans.length<2){spans=[{id:'e1',text:'aplica el candado antes de verificar que la máquina está apagada',isError:true},{id:'e2',text:'comunica al supervisor',isError:false},{id:'e3',text:'verifica la ausencia de voltaje residual',isError:false}];fallback=true;}if(!q.correct){q.correct=spans.filter(function(s){return s.isError;})[0]&&spans.filter(function(s){return s.isError;})[0].id||'e1';}G._ehDone=false;var html='<p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.5;margin:0 0 6px;">🔍 DETECCIÓN DE ERRORES</p>'+'<p style="font-size:17px;font-weight:700;margin:0 0 10px;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;">'+_ehEsc(q.q)+'</p>'+'<div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.14);border-left:3px solid var(--accent);border-radius:0 10px 10px 0;padding:14px 16px;margin-bottom:14px;font-size:15px;line-height:1.65;font-family:system-ui,-apple-system,sans-serif;color:var(--text);">'+_ehEsc(ctx)+'</div>'+(fallback?'<p style="font-size:11px;opacity:.5;margin:0 0 8px;">(datos de ejemplo — regenera para contenido real)</p>':'')+'<p style="font-size:12px;opacity:.65;margin:0 0 10px;font-family:system-ui,-apple-system,sans-serif;">Selecciona el fragmento que contiene el <strong>error</strong>:</p>'+'<div style="display:flex;flex-direction:column;gap:8px;">';shuffle(spans.slice()).forEach(function(sp){html+='<button id="ehchip_'+n+'_'+_ehEsc(sp.id)+'" onclick="checkErrorHunter('+n+',\''+sp.id+'\')" style="display:block;width:100%;padding:12px 16px;border-radius:10px;border:1.5px solid rgba(255,255,255,.2);background:rgba(255,255,255,.05);font-size:14px;font-weight:600;line-height:1.5;text-align:left;cursor:pointer;font-family:system-ui,-apple-system,sans-serif;-webkit-tap-highlight-color:transparent;transition:border-color .15s,background .15s;">🔎 '+_ehEsc(sp.text)+'</button>';});html+='</div>';area.innerHTML=html;}catch(e){console.error('renderArea errorhunter',e);}}
  }
  // 31 Secuencia de Proceso Pro — reorder-cards paradigm (Fase M4)
  // Schema: {q, steps:[{id,label,order}], fb, tolerance?}
  // Interaction: ↑↓ buttons per card → VALIDAR SECUENCIA
  ,{qf:'{"q":"Instrucción clara de ordenamiento: ¿En qué orden se deben ejecutar los pasos de este procedimiento?","steps":[{"id":"s1","label":"Primer paso del procedimiento (máx 12 palabras, sin HTML)","order":1},{"id":"s2","label":"Segundo paso","order":2},{"id":"s3","label":"Tercer paso","order":3},{"id":"s4","label":"Cuarto paso","order":4},{"id":"s5","label":"Quinto paso","order":5}],"fb":"Retroalimentación educativa explicando por qué ese orden es correcto y qué ocurre si se altera","tolerance":0} — REGLAS CRÍTICAS: steps entre 4 y 7 objetos; cada objeto DEBE tener id (s1…s7), label (texto plano, máx 12 palabras, sin HTML/markdown), order (entero empezando en 1); order debe ser único y consecutivo; NO incluyas opts ni correct; solo JSON puro sin markdown',
     rf:function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];var area=document.getElementById('area'+n);if(!area)return;var steps=q.steps;if(!Array.isArray(steps)||steps.length<2){steps=[{id:'s1',label:'Preparar materiales y verificar disponibilidad del equipo necesario',order:1},{id:'s2',label:'Verificar condiciones de seguridad del área de trabajo',order:2},{id:'s3',label:'Ejecutar el procedimiento según el protocolo establecido',order:3},{id:'s4',label:'Registrar resultados y notificar al supervisor correspondiente',order:4}];}steps=steps.map(function(s,k){return{id:String(s.id||('s'+(k+1))),label:String(s.label||s.text||s||'—'),order:Number(s.order)||(k+1)};});var correct=steps.slice().sort(function(a,b){return a.order-b.order;});var shuffled=steps.slice();for(var _si=shuffled.length-1;_si>0;_si--){var _sj=Math.floor(Math.random()*(_si+1));var _st=shuffled[_si];shuffled[_si]=shuffled[_sj];shuffled[_sj]=_st;}var _already=shuffled.every(function(s,k){return s.id===correct[k].id;});if(_already&&shuffled.length>=2){var _tmp=shuffled[0];shuffled[0]=shuffled[shuffled.length-1];shuffled[shuffled.length-1]=_tmp;}if(!G._seqOrder)G._seqOrder={};if(!G._seqDone)G._seqDone={};if(!G._seqSteps)G._seqSteps={};G._seqOrder[n]=shuffled.map(function(s){return s.id;});G._seqDone[n]=false;G._seqSteps[n]=steps;area.innerHTML='<p style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:2px;opacity:.5;margin:0 0 6px;">↕ ORDENAR PROCEDIMIENTO</p>'+'<p style="font-size:17px;font-weight:700;margin:0 0 10px;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;">'+q.q+'</p>'+'<p style="font-size:12px;opacity:.65;margin:0 0 12px;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;">Usa <strong>↑ ↓</strong> para poner los pasos en el orden correcto, luego pulsa <strong>Validar</strong>.</p>'+'<div id="spcontainer_'+n+'" style="display:flex;flex-direction:column;gap:8px;"></div>'+'<button id="seqpro_btn_'+n+'" onclick="checkSeqPro('+n+')" style="margin-top:14px;width:100%;padding:14px;border-radius:10px;background:var(--accent);color:#000;font-weight:800;font-size:15px;cursor:pointer;border:none;font-family:system-ui,-apple-system,sans-serif;letter-spacing:.5px;">✔ VALIDAR SECUENCIA</button>';_seqProRender(n);}catch(e){console.error('renderArea seqpro',e);}}
  }
  ];
  impls.forEach(function(impl,i){if(MECS[i]){MECS[i].qf=impl.qf;MECS[i].rf=impl.rf;}});
})();

// ── ACTIVE MECS — excluye mecánicas deprecated de la selección automática ──────
// NOTA: buildScormHtml() sigue aceptando CUALQUIER mecánica por índice directo
// para mantener compatibilidad con SCORMs ya generados. Esta función solo
// se usa en mecForCap() y mecFromPack() para NUEVAS generaciones.
function getActiveMecs(){
  return MECS.filter(function(m){return !m.deprecated;});
}

var ESTS=[
  'Dungeon RPG — body{background:#0D0D14} HUD{background:#13082A;border-bottom:1px solid rgba(147,51,234,.4)} --accent:#9333EA --accent2:#FBBF24 --btn:rgba(147,51,234,.25) --btn-border:rgba(147,51,234,.5) --text:#E9D5FF, Bebas Neue títulos + Inter cuerpo, grid-lines CSS rgba(147,51,234,.08) en body::after, box-shadow glow púrpura en botones activos',
  'Terminal Hacker — body{background:#000;color:#00FF41} font: Space Mono (Google Fonts) todo, --accent:#00FF41 --btn:rgba(0,255,65,.08) --btn-border:rgba(0,255,65,.4) --hud-bg:#001100, scanlines body::before{background:repeating-linear-gradient(transparent,transparent 2px,rgba(0,0,0,.15) 2px,rgba(0,0,0,.15) 4px);pointer-events:none;position:fixed;inset:0;z-index:9999}, border-radius:0 en todo',
  'Retro Arcade 8-bit — body{background:#0A0A2E} font: Press Start 2P (Google Fonts), --accent:#FF0090 --accent2:#FFFF00 --btn:#1A1A4E --btn-border:#FF0090 --text:#00FFFF, outline:3px solid #FF0090 en cards, box-shadow:4px 4px 0 #FF0090 en botones, cero border-radius, animación blink @keyframes en cursor',
  'Cyberpunk Neon City — body{background:#080B14} font: Orbitron (Google Fonts), --accent:#FF006E --accent2:#00F5FF --btn:rgba(0,245,255,.07) --btn-border:#00F5FF --hud-bg:rgba(8,11,20,.95), text-shadow:0 0 10px currentColor en títulos, box-shadow:0 0 12px rgba(0,245,255,.4) en btn hover, líneas diagonales body::after con linear-gradient a 45deg',
  'Medieval Pergamino — body{background:#1A1208;color:#F0E6C8} font: Cinzel títulos + Lora cuerpo (Google Fonts), --accent:#F5C518 --accent2:#D97706 --btn:rgba(245,197,24,.12) --btn-border:rgba(245,197,24,.45) --hud-bg:#0F0A03, bordes dobles border:2px solid #D97706, body{background-image:radial-gradient(ellipse at 50% 0,rgba(245,197,24,.08),transparent 70%)}',
  'Sci-Fi Espacial — body{background:#000;background-image:radial-gradient(1px 1px at 20% 30%,#fff,transparent),radial-gradient(1px 1px at 80% 10%,#fff,transparent),...} font: Rajdhani (Google Fonts), --accent:#00D4FF --accent2:#00FF9F --btn:rgba(0,212,255,.1) --btn-border:rgba(0,212,255,.5) --hud-bg:rgba(0,0,0,.8), clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%) en cards hexagonales',
  'Neón Minimalista — body{background:#0A0A0A;color:#fff} font: Inter (900 weight), --accent:#FDFF00 --btn:rgba(253,255,0,.08) --btn-border:rgba(253,255,0,.5) --hud-bg:#0A0A0A, text-shadow:0 0 20px #FDFF00 en títulos, border-left:3px solid #FDFF00 en items, espaciado generoso (padding:32px+), zero decoración superflua',
  'Glassmorphism Dark — body{background:linear-gradient(135deg,#0F2027,#203A43,#2C5364)} font: DM Sans (Google Fonts), --accent:#60A5FA --btn:rgba(255,255,255,.07) --btn-border:rgba(255,255,255,.15) --hud-bg:rgba(15,32,39,.7), cards{backdrop-filter:blur(16px);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:20px}, box-shadow:0 8px 32px rgba(0,0,0,.4)',
  'Naturaleza Orgánica — body{background:#0D1B0F} font: Nunito (Google Fonts), --accent:#4ADE80 --accent2:#86EFAC --btn:rgba(74,222,128,.12) --btn-border:rgba(74,222,128,.4) --hud-bg:#071209, border-radius:20px en todo, body{background-image:radial-gradient(ellipse at 0% 100%,rgba(74,222,128,.08),transparent)}, íconos hoja 🌿 en stats intro',
  'Océano Profundo — body{background:#020B18} font: Exo 2 (Google Fonts), --accent:#38BDF8 --accent2:#7DD3FC --btn:rgba(56,189,248,.1) --btn-border:rgba(56,189,248,.4) --hud-bg:rgba(2,11,24,.9), @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}} en emoji intro, ondas CSS border-radius animado en cards',
  'Llamas de Fuego — body{background:#0F0500} font: Oswald Bold (Google Fonts), --accent:#FF6B00 --accent2:#FF0000 --btn:rgba(255,107,0,.15) --btn-border:rgba(255,107,0,.6) --hud-bg:#1A0800, box-shadow:0 0 16px rgba(255,107,0,.5) en botones, @keyframes pulse{0%,100%{box-shadow:0 0 8px #FF6B00}50%{box-shadow:0 0 24px #FF0000}} animación en btn inicio, texto con glow naranja',
  'Hielo y Cristal — body{background:#010B14} font: Raleway (Google Fonts), --accent:#BAE6FD --accent2:#fff --btn:rgba(186,230,253,.07) --btn-border:rgba(186,230,253,.3) --hud-bg:rgba(1,11,20,.85), cards{background:linear-gradient(135deg,rgba(255,255,255,.06),rgba(186,230,253,.04));border:1px solid rgba(186,230,253,.2)}, sombras box-shadow azul-frías diffusas',
  'Neon Tokyo — body{background:#050508} font: Syne (Google Fonts), --accent:#FF2D78 --accent2:#FFE600 --btn:rgba(255,45,120,.1) --btn-border:#FF2D78 --hud-bg:rgba(5,5,8,.9), text-shadow:0 0 12px #FF2D78 en títulos, gradientes verticales en bordes izquierdos (border-left:2px solid;box-shadow:-2px 0 8px), caracteres decorativos Unicode ◆ ▲ en separadores',
  'Steampunk Industrial — body{background:#1A1209;color:#E8D5B0} font: Playfair Display títulos + Courier cuerpo (Google Fonts), --accent:#B8860B --accent2:#B87333 --btn:rgba(184,134,11,.12) --btn-border:rgba(184,134,11,.5) --hud-bg:#0F0A03, border:2px solid #B8860B en cards, iconos engranaje ⚙️ en salas, body::before textura metálica radial-gradient oscura',
  'Aurora Holográfica — body{background:#060608} font: Poppins (Google Fonts), --accent:#a78bfa --accent2:#34d399 --btn:rgba(167,139,250,.12) --btn-border:rgba(167,139,250,.4) --hud-bg:rgba(6,6,8,.9), @keyframes hue{0%{background-position:0%}100%{background-position:400%}} títulos con background:linear-gradient(60deg,#ff0000,#ff7700,#ffff00,#00ff00,#00ffff,#ff00ff,#ff0000);background-size:400%;-webkit-background-clip:text;color:transparent;animation:hue 4s linear infinite',
  'Flat Vibrante — body{background:#F8FAFC;color:#111} font: Inter Black 900 (Google Fonts), --accent:#EF4444 --accent2:#3B82F6 --btn:#EF4444 --btn-text:#fff --btn-border:transparent --hud-bg:#fff, sombras duras box-shadow:4px 4px 0 #111 en botones, sin gradientes ni blur, colores sólidos puros, border:2px solid #111 en cards, máximo contraste',
  'Lofi Chill — body{background:#1E1B2E} font: Nunito (Google Fonts), --accent:#C084FC --accent2:#FB923C --btn:rgba(192,132,252,.12) --btn-border:rgba(192,132,252,.35) --hud-bg:rgba(30,27,46,.9), gradiente suave body{background:linear-gradient(180deg,#1E1B2E,#2D2040)}, border-radius:16px en todo, box-shadow:0 4px 24px rgba(0,0,0,.4) en cards, aspecto tranquilo y cálido'
];

// ── TEXT NORMALIZER — strips accents, lowercases, removes special chars for comparison ──
// Used by scoreFamily, resolveSector and experienceForCap so all keyword matching
// works regardless of whether the input has tildes, mixed case or extra punctuation.
function normalizeText(s){
  return (s||'').toString().toLowerCase()
    .replace(/[áàäâã]/g,'a').replace(/[éèëê]/g,'e')
    .replace(/[íìïî]/g,'i').replace(/[óòöôõ]/g,'o')
    .replace(/[úùüû]/g,'u').replace(/ñ/g,'n').replace(/ç/g,'c')
    .replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
}

function pick(arr,used){var av=arr.filter(function(x){return used.indexOf(x)<0;});if(!av.length){used.length=0;av=arr.slice();}var p=av[Math.floor(Math.random()*av.length)];used.push(p);return p;}

// ════ STATIC SCORM TEMPLATES ════
// AI only generates question data JSON (~1500 tokens). Engine is 100% static.
// Truncation is IMPOSSIBLE — no HTML generated by AI, no FIX 0 needed ever.

var STHEMES=[
  {n:'Fuego',   bg:'#0F0500',font:'Oswald',      fu:'https://fonts.googleapis.com/css2?family=Oswald:wght@400;700&display=swap',
   v:'--accent:#FF6B00;--accent2:#FF0000;--text:#fff;--t2:rgba(255,255,255,.7);--btn:rgba(255,107,0,.15);--btnt:#fff;--btnb:rgba(255,107,0,.6);--hud:#1A0800;'},
  {n:'Matrix',  bg:'#000',   font:'Space Mono', fu:'https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap',
   v:'--accent:#00FF41;--accent2:#00FF41;--text:#00FF41;--t2:rgba(0,255,65,.7);--btn:rgba(0,255,65,.08);--btnt:#00FF41;--btnb:rgba(0,255,65,.4);--hud:#001100;'},
  {n:'Cyberpunk',bg:'#080B14',font:'Orbitron',   fu:'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&display=swap',
   v:'--accent:#00F5FF;--accent2:#FF006E;--text:#fff;--t2:rgba(255,255,255,.7);--btn:rgba(0,245,255,.07);--btnt:#fff;--btnb:#00F5FF;--hud:rgba(8,11,20,.95);'},
  {n:'Dungeon',  bg:'#0D0D14',font:'Bebas Neue', fu:'https://fonts.googleapis.com/css2?family=Bebas+Neue&display=swap',
   v:'--accent:#9333EA;--accent2:#FBBF24;--text:#E9D5FF;--t2:rgba(233,213,255,.6);--btn:rgba(147,51,234,.25);--btnt:#E9D5FF;--btnb:rgba(147,51,234,.5);--hud:#13082A;'},
  {n:'Oceano',  bg:'#020B18', font:'Exo 2',      fu:'https://fonts.googleapis.com/css2?family=Exo+2:wght@400;600;700;900&display=swap',
   v:'--accent:#38BDF8;--accent2:#7DD3FC;--text:#fff;--t2:rgba(255,255,255,.7);--btn:rgba(56,189,248,.1);--btnt:#fff;--btnb:rgba(56,189,248,.4);--hud:rgba(2,11,24,.9);'},
  {n:'Natura',  bg:'#0D1B0F', font:'Nunito',     fu:'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;900&display=swap',
   v:'--accent:#4ADE80;--accent2:#86EFAC;--text:#fff;--t2:rgba(255,255,255,.7);--btn:rgba(74,222,128,.12);--btnt:#fff;--btnb:rgba(74,222,128,.4);--hud:#071209;'},
  {n:'Neon',    bg:'#0A0A0A', font:'Inter',      fu:'https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap',
   v:'--accent:#FDFF00;--accent2:#FDFF00;--text:#fff;--t2:rgba(255,255,255,.6);--btn:rgba(253,255,0,.08);--btnt:#fff;--btnb:rgba(253,255,0,.5);--hud:#0A0A0A;'},
  {n:'Aurora',  bg:'#060608', font:'Poppins',    fu:'https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700;900&display=swap',
   v:'--accent:#a78bfa;--accent2:#34d399;--text:#fff;--t2:rgba(255,255,255,.7);--btn:rgba(167,139,250,.12);--btnt:#fff;--btnb:rgba(167,139,250,.4);--hud:rgba(6,6,8,.9);'}
];

// ════ NFAMILIES — Catálogo de familias narrativas (Fase 3) ════
// 22 familias que cubren salud, industria, negocios, legal, tech, ambiente, agro, educación.
// Reemplaza NPACKS. Cada familia incluye compatibleSectors para scoring multi-señal.
// keywords se evalúan contra texto normalizado (sin tildes, minúsculas).
// LEGIBILIDAD: fuentes decorativas solo en títulos/badges; preguntas/opciones siempre ≥16px.
var NFAMILIES=[
  // ── SALUD ─────────────────────────────────────────────────────────────────
  {id:'clinica',         label:'Clínica / Turno Médico',       icon:'🏥', tIdx:0,
   keywords:/clinica|turno medico|guardia medica|paciente|triage|urgencias|atencion medica|enfermeria|consulta medica|protocolo clinico|via parenteral|dosis de carga|evaluacion clinica|efecto adverso|farmacolog|reaccion adversa medicamento/,
   mecNames:['Checklist Crítico','Error Hunter','Secuencia de Proceso Pro','Turno de Operario','Diagnóstico Sectorial','Inspector de Planta'],
   compatibleSectors:['salud','medicina','farmaceutica','veterinaria'],
   promptStyle:'urgente y empático — decisiones clínicas bajo presión, vidas en juego, protocolos de atención',
   visualMetaphor:'sala de urgencias, turno médico activo, monitor vital, protocolo clínico crítico',
   readableFontStrategy:'títulos urgentes; preguntas y opciones con system-ui ≥18px; fondo oscuro + texto blanco'},
  {id:'laboratorio_bio', label:'Laboratorio Biomédico',         icon:'🧬', tIdx:5,
   keywords:/laboratorio bio|laboratorio clinico|muestra biologica|reactivo|biopsia|analisis clinico|microbiologia|biologia molecular|ensayo biologico|dispensacion|farmacovigilancia|principio activo|interaccion farmacologica|preparacion farmaceutica|cadena de frio/,
   mecNames:['Checklist Crítico','Error Hunter','Secuencia de Proceso Pro','Diagnóstico Sectorial','Inspector de Planta','Caso de Estudio'],
   compatibleSectors:['salud','medicina','farmaceutica','veterinaria','biotecnologia','farmacia','medicamentos'],
   promptStyle:'metódico y científico — hipótesis en prueba, resultados anómalos, protocolo de análisis',
   visualMetaphor:'mesa de laboratorio, microscopio activo, resultado fuera de rango, muestra en análisis',
   readableFontStrategy:'científica limpia; Natura+Nunito; Inter o system-ui para textos largos; ≥18px'},
  {id:'salud_publica',   label:'Salud Pública / Epidemiología', icon:'🦠', tIdx:4,
   keywords:/epidemiolog|salud publica|brote infeccioso|vacuna|prevencion de enfermedad|vigilancia sanitaria|mortalidad|morbilidad|tasa de incidencia|uso racional de medicamentos|farmacoepidemiologia|politica farmaceutica|programa de vacunacion|medicamento esencial/,
   mecNames:['Secuencia de Proceso Pro','Checklist Crítico','Diagnóstico Sectorial','Cronología Interactiva','Simulador de Decisiones'],
   compatibleSectors:['salud','medicina','epidemiologia','salud publica','farmaceutica','farmacia','medicamentos'],
   promptStyle:'analítico y preventivo — brotes detectados, curvas epidémicas, decisiones de salud pública',
   visualMetaphor:'mapa de brote activo, sala de crisis sanitaria, curva de contagio, alerta de salud pública',
   readableFontStrategy:'datos legibles; Oceano+Exo2; preguntas claras ≥18px; buen contraste en métricas'},
  // ── INDUSTRIA ─────────────────────────────────────────────────────────────
  {id:'planta_industrial',label:'Planta / Sala de Control',    icon:'⚙️', tIdx:0,
   keywords:/planta industrial|manufactura|produccion industrial|mantenimiento|calibracion|turno operativo|maquinaria|linea de produccion|operacion de planta/,
   mecNames:['Checklist Crítico','Secuencia de Proceso Pro','Inspector de Planta','Turno de Operario','Secuencia de Proceso'],
   compatibleSectors:['industria','manufactura','petroleo','mineria','construccion','energia','logistica'],
   promptStyle:'técnico e industrial — sala de control, alarmas operativas, protocolos de planta, turno crítico',
   visualMetaphor:'panel de control activo, alarma roja, proceso en falla, decisión urgente de turno',
   readableFontStrategy:'técnica-industrial; Fuego+Oswald en títulos; preguntas con system-ui ≥16px'},
  {id:'hseq',            label:'Seguridad Industrial / HSEQ',  icon:'⚠️', tIdx:0,
   keywords:/hseq|riesgo laboral|accidente de trabajo|peligro|incidente industrial|protocolo de seguridad|emergencia industrial|epp|matriz de riesgos|seguridad industrial/,
   mecNames:['Checklist Crítico','Error Hunter','Secuencia de Proceso Pro','Inspector de Planta','Diagnóstico Sectorial','Simulador de Decisiones'],
   compatibleSectors:['industria','manufactura','petroleo','mineria','construccion','energia','salud'],
   promptStyle:'crítico y preventivo — riesgos ocultos, incidentes evitables, decisiones de seguridad',
   visualMetaphor:'zona de peligro activa, EPP incompleto, señal de alarma, incidente a punto de ocurrir',
   readableFontStrategy:'alta legibilidad obligatoria; preguntas ≥18px; fondo oscuro + texto blanco; system-ui'},
  {id:'calidad',         label:'Control de Calidad / ISO',     icon:'📐', tIdx:6,
   keywords:/control de calidad|iso 9001|auditoria de calidad|no conformidad|mejora continua|kaizen|lean|six sigma|indicador de calidad|trazabilidad|buenas practicas de manufactura|bpm farmaceutica|validacion de proceso|liberacion de lote|especificacion tecnica/,
   mecNames:['Checklist Crítico','Error Hunter','Secuencia de Proceso Pro','Inspector de Planta','Caso de Estudio','Diagnóstico Sectorial'],
   compatibleSectors:['industria','manufactura','logistica','software','salud','farmaceutica','farmacia','medicamentos'],
   promptStyle:'riguroso y sistemático — hallazgos de auditoría, no conformidades, causa raíz, acción correctiva',
   visualMetaphor:'lista de verificación, muestra fuera de especificación, hallazgo de auditoría, alerta de calidad',
   readableFontStrategy:'Neon+Inter; preguntas con background claro; opciones ≥16px legibles'},
  // ── NEGOCIOS / EMPRENDIMIENTO ─────────────────────────────────────────────
  {id:'pitch_inversores', label:'Pitch / Sala de Inversores',  icon:'📊', tIdx:7,
   keywords:/pitch de negocio|inversion empresarial|inversionista|capital de riesgo|venture|startup|propuesta de valor|ronda de financiacion|modelo de negocio/,
   mecNames:['Simulador de Decisiones','Caso de Estudio','Match de Tarjetas'],
   compatibleSectors:['negocios','emprendimiento','finanzas'],
   promptStyle:'estratégico y persuasivo — argumentos de negocio, métricas decisivas, sala de inversores hambrienta',
   visualMetaphor:'sala de juntas tensa, pitch deck en pantalla, pregunta del inversor, momento de decisión',
   readableFontStrategy:'Aurora+Poppins formal; preguntas ≥18px sin decoración; opciones con alto contraste'},
  {id:'mercado',          label:'Estudio de Mercado',          icon:'🛒', tIdx:5,
   keywords:/estudio de mercado|analisis del consumidor|tendencia de mercado|comportamiento del cliente|posicionamiento de marca|nicho de mercado|buyer persona|competidor/,
   mecNames:['Galería de Conceptos','Caso de Estudio','Cronología Interactiva'],
   compatibleSectors:['negocios','emprendimiento','retail','turismo','comunicacion'],
   promptStyle:'exploratorio y estratégico — insights de mercado, patrones de consumo, ventaja competitiva',
   visualMetaphor:'mapa de competidores, perfil del cliente ideal, tendencia emergente, nicho por conquistar',
   readableFontStrategy:'Natura+Nunito exploratoria; preguntas legibles ≥16px; contenedores claros'},
  {id:'finanzas',         label:'Sala de Finanzas',            icon:'💰', tIdx:2,
   keywords:/analisis financiero|estructura de costos|punto de equilibrio|rentabilidad|utilidad|flujo de caja|presupuesto empresarial|margen de contribucion|contabilidad/,
   mecNames:['Diagnóstico Sectorial','Simulador de Decisiones','Caso de Estudio'],
   compatibleSectors:['negocios','finanzas','contabilidad','emprendimiento','logistica'],
   promptStyle:'analítico y decisivo — cifras críticas, alertas financieras, decisiones de rentabilidad',
   visualMetaphor:'tablero financiero en alerta, punto de quiebre, decisión de inversión urgente',
   readableFontStrategy:'Cyberpunk+Orbitron solo en títulos; preguntas con system-ui ≥16px'},
  // ── LEGAL ─────────────────────────────────────────────────────────────────
  {id:'tribunal',         label:'Sala del Juicio',             icon:'⚖️', tIdx:7,
   keywords:/marco legal|normativa|regulacion|ley aplicable|decreto|resolucion legal|contrato juridico|codigo civil|registro publico|camara de comercio|derecho comercial|medicamento de control|control especial|estupefaciente|psicoactivo|resolucion sanitaria/,
   mecNames:['Error Hunter','Simulador de Decisiones','Match de Tarjetas','Galería de Conceptos'],
   compatibleSectors:['legal','derecho','negocios','compliance'],
   promptStyle:'formal y deliberativo — argumentos legales, evidencias, veredictos, consecuencias jurídicas',
   visualMetaphor:'sala de audiencias, expediente en manos, argumento clave presentado, fallo pendiente',
   readableFontStrategy:'Aurora formal; Poppins en cuerpo; preguntas ≥18px; nunca decorativas en opciones'},
  {id:'compliance',       label:'Compliance / Ética Corporativa',icon:'📋', tIdx:3,
   keywords:/compliance|etica empresarial|cumplimiento normativo|gobernanza corporativa|fraude|antisoborno|debida diligencia|sarlaft|riesgo de cumplimiento|codigo de etica|normativa farmaceutica|invima|registro sanitario|decreto farmaceutico|autorizacion sanitaria|vigilancia y control/,
   mecNames:['Checklist Crítico','Error Hunter','Secuencia de Proceso Pro','Simulador de Decisiones','Caso de Estudio','Inspector de Planta'],
   compatibleSectors:['legal','derecho','finanzas','contabilidad','industria','negocios','farmaceutica','farmacia','medicamentos'],
   promptStyle:'ético y crítico — dilemas de cumplimiento, señales de alerta, decisiones de integridad',
   visualMetaphor:'alerta de cumplimiento, señal de riesgo ético, dilema corporativo, decisión comprometedora',
   readableFontStrategy:'Dungeon+Inter cuerpo; preguntas ≥16px; NUNCA texto verde Matrix en opciones'},
  // ── TECNOLOGÍA ────────────────────────────────────────────────────────────
  {id:'data_center',      label:'Centro de Datos / DevOps',    icon:'🖥️', tIdx:1,
   keywords:/infraestructura tecnologica|centro de datos|servidor|base de datos|cloud computing|devops|sistema de informacion|arquitectura de software|incidente de sistema/,
   mecNames:['Error Hunter','Secuencia de Proceso Pro','Secuencia de Proceso','Inspector de Planta','Boss Fight'],
   compatibleSectors:['tecnologia','software','telecomunicaciones'],
   promptStyle:'técnico y preciso — incidentes de sistema, SLA en riesgo, infraestructura bajo presión',
   visualMetaphor:'sala de servidores, alerta de sistema, stack trace en pantalla, incidente en producción',
   readableFontStrategy:'Matrix+SpaceMono; preguntas ≥16px con fondo negro + texto verde brillante legible'},
  {id:'hackathon',        label:'Hackathon / Innovación Digital',icon:'💻', tIdx:2,
   keywords:/hackathon|innovacion digital|desarrollo de app|mvp digital|ux design|design thinking|metodologia agil|scrum|sprint de innovacion|prototipo de software/,
   mecNames:['Boss Fight','Kahoot Relámpago','Defuse la Bomba'],
   compatibleSectors:['tecnologia','software','emprendimiento'],
   promptStyle:'ágil y creativo — sprint de ideas, prototipo bajo presión, decisiones de producto a máxima velocidad',
   visualMetaphor:'pizarrón de ideas, sprint de 48h, prototipo a punto de fallar, demo day decisivo',
   readableFontStrategy:'Cyberpunk solo en títulos cortos; preguntas ≥16px con font-family heredado'},
  {id:'ciberseguridad',   label:'Ciberseguridad / SOC',        icon:'🔐', tIdx:1,
   keywords:/ciberseguridad|seguridad informatica|hacking|vulnerabilidad|ataque cibernetico|phishing|malware|soc|amenaza digital|pentesting/,
   mecNames:['Error Hunter','Sala de Escape','Cartas Ocultas','Inspector de Planta'],
   compatibleSectors:['tecnologia','software','telecomunicaciones'],
   promptStyle:'sigiloso y técnico — amenazas ocultas, vectores de ataque, decisiones de mitigación urgentes',
   visualMetaphor:'terminal comprometida, log sospechoso, vector detectado, SOC en alerta máxima',
   readableFontStrategy:'Matrix investigativo; alto contraste; opciones con fondo diferenciado ≥14px legible'},
  // ── AMBIENTE / AGRO ───────────────────────────────────────────────────────
  {id:'expedicion_campo', label:'Expedición de Campo',         icon:'🗺️', tIdx:5,
   keywords:/expedicion de campo|trabajo en terreno|ecosistema|flora y fauna|muestra de campo|monitoreo ambiental|biodiversidad|bitacora de campo|zona de estudio/,
   mecNames:['Cronología Interactiva','Galería de Conceptos','Caso de Estudio'],
   compatibleSectors:['ambiental','agricultura','turismo','agroindustria'],
   promptStyle:'exploratorio y curioso — hallazgos inesperados, zonas inexploradas, descubrimientos graduales',
   visualMetaphor:'bitácora de campo, hallazgo en terreno, zona inexplorada, muestra recolectada en sitio',
   readableFontStrategy:'Natura+Nunito exploratoria; preguntas con contenedores claros sobre verde oscuro ≥16px'},
  {id:'alerta_ambiental', label:'Alerta Ambiental / Crisis',   icon:'🌍', tIdx:5,
   keywords:/impacto ambiental|contaminacion|emision de gases|residuo peligroso|cambio climatico|alerta ecologica|sostenibilidad ambiental|huella de carbono|remediacion/,
   mecNames:['Diagnóstico Sectorial','Simulador de Decisiones','Inspector de Planta'],
   compatibleSectors:['ambiental','agricultura','agroindustria','energia','petroleo','mineria'],
   promptStyle:'crítico y consciente — alertas ambientales activas, impactos detectados, decisiones de mitigación',
   visualMetaphor:'zona de impacto activo, indicador fuera de límite, alerta ecológica roja, decisión crítica',
   readableFontStrategy:'urgencia verde; preguntas ≥18px fondo oscuro + texto claro; system-ui en opciones'},
  {id:'agro',             label:'Finca Inteligente / Agro',    icon:'🌱', tIdx:5,
   keywords:/agricultura|cultivo|cosecha|fitosanidad|ganaderia|finca agricola|cadena agroalimentaria|plagas agricolas|irrigacion|suelo agricola/,
   mecNames:['Checklist Crítico','Secuencia de Proceso Pro','Inspector de Planta','Cronología Interactiva','Diagnóstico Sectorial'],
   compatibleSectors:['agricultura','agroindustria','ambiental'],
   promptStyle:'práctico y estacional — ciclos de cultivo, alertas fitosanitarias, decisiones de finca',
   visualMetaphor:'lote bajo observación, plaga detectada, decisión de temporada, finca en crisis productiva',
   readableFontStrategy:'Natura orgánico; Nunito legible ≥16px; preguntas con fondo verde oscuro + texto blanco'},
  // ── EDUCACIÓN / SOCIAL ────────────────────────────────────────────────────
  {id:'aula',             label:'Laboratorio Pedagógico',      icon:'🎓', tIdx:7,
   keywords:/practica pedagogica|estrategia didactica|evaluacion educativa|aprendizaje significativo|competencia docente|diseno curricular|ensenanza|formacion docente|inclusion educativa/,
   mecNames:['Galería de Conceptos','Match de Tarjetas','Caso de Estudio'],
   compatibleSectors:['educacion','psicologia'],
   promptStyle:'reflexivo y constructivo — situaciones pedagógicas reales, decisiones docentes, análisis de aprendizaje',
   visualMetaphor:'aula en situación crítica, grupo desafiante, estrategia a prueba, evaluación inesperada',
   readableFontStrategy:'Aurora+Poppins educativo; preguntas ≥16px sin decoración; opciones claras'},
  {id:'diplomacia',       label:'Misión Diplomática / Social', icon:'🤝', tIdx:3,
   keywords:/negociacion|conflicto social|mediacion comunitaria|politica publica|desarrollo social|relaciones internacionales|acuerdo de paz|dialogo intercultural|gobernanza/,
   mecNames:['Simulador de Decisiones','Caso de Estudio','Match de Tarjetas'],
   compatibleSectors:['educacion','psicologia','legal','comunicacion','turismo'],
   promptStyle:'diplomático y estratégico — tensiones entre actores, negociaciones frágiles, decisiones de impacto',
   visualMetaphor:'mesa de negociación tensa, actor clave presente, acuerdo a punto de romperse',
   readableFontStrategy:'Dungeon con alta legibilidad; system-ui en preguntas; nunca fantasiosas en opciones ≥16px'},
  // ── UNIVERSALES ───────────────────────────────────────────────────────────
  {id:'detective',        label:'Investigación / Análisis',    icon:'🔍', tIdx:1,
   keywords:/investigacion de causa|analisis de causa raiz|evidencia tecnica|inspeccion tecnica|revision de proceso|auditoria de campo|anomalia sin explicar/,
   mecNames:['Error Hunter','Inspector de Planta','Sala de Escape','Elimina el Intruso'],
   compatibleSectors:[],
   promptStyle:'investigativo y analítico — pistas ocultas, causas sin resolver, evidencias que llevan a la verdad',
   visualMetaphor:'expediente abierto, pista clave, evidencia que cambia el caso, anomalía bajo análisis',
   readableFontStrategy:'Matrix investigativo; preguntas ≥16px con fondo negro + texto verde brillante'},
  {id:'arcade_universal', label:'Reto Arcade',                 icon:'🕹️', tIdx:2,
   keywords:/velocidad de respuesta|competencia de conocimiento|reto de evaluacion|desafio educativo|practica intensiva|repaso rapido|trivia educativa|quiz/,
   mecNames:['Kahoot Relámpago','Boss Fight','Defuse la Bomba'],
   compatibleSectors:[],
   promptStyle:'dinámico y competitivo — velocidad, niveles, puntuación máxima, jefe final derrotado',
   visualMetaphor:'tablero de puntuación, cuenta regresiva explosiva, jefe de zona, nivel desbloqueado',
   readableFontStrategy:'Cyberpunk solo en títulos; preguntas con font-family:inherit ≥16px; Kahoot colores legibles'},
  {id:'timelapse',        label:'Línea del Tiempo',            icon:'⏱️', tIdx:4,
   keywords:/historia del sector|evolucion historica|etapas de desarrollo|ciclo de vida|origen del concepto|cronologia de eventos|linea del tiempo|hito clave|antecedente/,
   mecNames:['Cronología Interactiva','Secuencia de Proceso Pro','Secuencia de Proceso','V/F Speedrun'],
   compatibleSectors:[],
   promptStyle:'histórico y progresivo — evolución clara, hitos clave en contexto, causa-efecto en el tiempo',
   visualMetaphor:'línea del tiempo desplegada, hito histórico descubierto, antes y después del sector',
   readableFontStrategy:'Oceano+Exo2 legible; nodos de tiempo con fuente clara; preguntas ≥16px buen contraste'},
  // ── FASE 7A: FALLBACK PREMIUM ─────────────────────────────────────────────
  {id:'generic_premium',  label:'Centro de Retos',             icon:'🎯', tIdx:7,
   keywords:/reto de aprendizaje|mision de aprendizaje|sala de desafios|laboratorio de decisiones|desafio educativo|competencia de conocimiento|aprendizaje por niveles|evaluacion general|centro de entrenamiento|actividad de aprendizaje/,
   mecNames:['Checklist Crítico','Error Hunter','Secuencia de Proceso Pro','Simulador de Decisiones','Caso de Estudio','Kahoot Relámpago','Match de Tarjetas'],
   compatibleSectors:['general','universal'],
   promptStyle:'profesional y adaptable — retos de aprendizaje escalonados, misiones educativas por niveles, decisiones con impacto formativo claro',
   visualMetaphor:'centro de control educativo, sala de desafíos activa, progreso por niveles desbloqueados, misión de aprendizaje en curso',
   readableFontStrategy:'moderna y legible; system-ui ≥18px; fondo oscuro elegante + texto blanco puro; opciones sin decoración, máxima legibilidad'}
];

// ── BACKWARD COMPAT — NPACKS y uPack siguen funcionando ──
var NPACKS=NFAMILIES;
var uPack=[];

// ── FASE 4: CSS TEMÁTICO — scoped to body.family-{id} ────────────────────────
// Rules:  pointer-events:none on all decorative elements.
//         z-index:0 for backgrounds, z-index:1 for .game-area content.
//         No images, no overlays on content, no fixed-position invasive.
//         12 families without specific CSS get familyCss:'' (safe fallback).
var FAMILY_CSS={
  'clinica':
    'body.family-clinica .gwrap{position:relative;border-left:2px solid rgba(239,68,68,.28);}'+
    'body.family-clinica .gwrap::before{content:"";position:absolute;inset:0;'+
      'background:repeating-linear-gradient(0deg,transparent,transparent 49px,rgba(239,68,68,.055) 50px);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-clinica .game-area{position:relative;z-index:1;}'+
    'body.family-clinica .mission-brief{border-left-color:#ef4444;background:rgba(239,68,68,.07);}'+
    'body.family-clinica .btn-primary{background:#ef4444;}'+
    'body.family-clinica .hud{border-bottom-color:rgba(239,68,68,.45);}',

  'laboratorio_bio':
    'body.family-laboratorio_bio .gwrap{position:relative;}'+
    'body.family-laboratorio_bio .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:linear-gradient(rgba(34,197,94,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(34,197,94,.04) 1px,transparent 1px);'+
      'background-size:28px 28px;pointer-events:none;z-index:0;}'+
    'body.family-laboratorio_bio .game-area{position:relative;z-index:1;}'+
    'body.family-laboratorio_bio .mission-brief{border-left-color:#22c55e;background:rgba(34,197,94,.07);}'+
    'body.family-laboratorio_bio .btn-primary{background:#22c55e;color:#000;}'+
    'body.family-laboratorio_bio .hud{border-bottom-color:rgba(34,197,94,.4);}',

  'hseq':
    'body.family-hseq .gwrap{position:relative;}'+
    'body.family-hseq .gwrap::before{content:"";position:absolute;top:0;left:0;right:0;height:5px;'+
      'background:repeating-linear-gradient(90deg,#eab308 0,#eab308 10px,rgba(10,10,10,.7) 10px,rgba(10,10,10,.7) 18px);'+
      'pointer-events:none;z-index:1;}'+
    'body.family-hseq .gwrap::after{content:"⚠";position:absolute;bottom:20px;right:14px;'+
      'font-size:80px;opacity:.04;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-hseq .game-area{position:relative;z-index:1;}'+
    'body.family-hseq .mission-brief{border-left-color:#eab308;background:rgba(234,179,8,.07);}'+
    'body.family-hseq .btn-primary{background:#eab308;color:#000;}'+
    'body.family-hseq .hud{border-bottom:2px solid rgba(234,179,8,.45);}',

  'finanzas':
    'body.family-finanzas .gwrap{position:relative;}'+
    'body.family-finanzas .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:linear-gradient(rgba(16,185,129,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(16,185,129,.04) 1px,transparent 1px);'+
      'background-size:36px 36px;pointer-events:none;z-index:0;}'+
    'body.family-finanzas .game-area{position:relative;z-index:1;}'+
    'body.family-finanzas .mission-brief{border-left-color:#10b981;background:rgba(16,185,129,.07);}'+
    'body.family-finanzas .btn-primary{background:#10b981;}'+
    'body.family-finanzas .hud{border-bottom-color:rgba(16,185,129,.4);}',

  'ciberseguridad':
    'body.family-ciberseguridad .gwrap{position:relative;}'+
    'body.family-ciberseguridad .gwrap::before{content:"";position:absolute;inset:0;'+
      'background:repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,255,80,.02) 4px);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-ciberseguridad .gwrap::after{content:"[SOC ACTIVO]";position:absolute;bottom:14px;right:14px;'+
      'font-size:9px;letter-spacing:3px;color:rgba(0,255,65,.12);pointer-events:none;z-index:0;font-family:monospace;}'+
    'body.family-ciberseguridad .game-area{position:relative;z-index:1;}'+
    'body.family-ciberseguridad .mission-brief{border-left-color:#00ff41;background:rgba(0,255,65,.05);}'+
    'body.family-ciberseguridad .btn-primary{background:#00ff41;color:#000;}'+
    'body.family-ciberseguridad .hud{border-bottom-color:rgba(0,255,65,.4);}',

  'diplomacia':
    'body.family-diplomacia .gwrap{position:relative;}'+
    'body.family-diplomacia .gwrap::before{content:"";position:absolute;top:0;left:40px;right:40px;height:1px;'+
      'background:linear-gradient(90deg,transparent,rgba(184,115,51,.45),transparent);pointer-events:none;z-index:0;}'+
    'body.family-diplomacia .game-area{position:relative;z-index:1;}'+
    'body.family-diplomacia .mission-brief{border-left-color:#b87333;background:rgba(184,115,51,.07);}'+
    'body.family-diplomacia .btn-primary{background:#8b7355;}'+
    'body.family-diplomacia .hud{letter-spacing:.4px;border-bottom-color:rgba(184,115,51,.35);}',

  'agro':
    'body.family-agro .gwrap{position:relative;border-left:2px solid rgba(101,163,13,.3);}'+
    'body.family-agro .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:radial-gradient(circle at 12% 88%,rgba(101,163,13,.07) 0,transparent 42%),'+
        'radial-gradient(circle at 88% 12%,rgba(34,197,94,.05) 0,transparent 38%);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-agro .game-area{position:relative;z-index:1;}'+
    'body.family-agro .mission-brief{border-left-color:#65a30d;background:rgba(101,163,13,.07);}'+
    'body.family-agro .btn-primary{background:#65a30d;}'+
    'body.family-agro .hud{border-bottom-color:rgba(101,163,13,.4);}',

  'tribunal':
    'body.family-tribunal .gwrap{position:relative;border-top:1px solid rgba(215,180,90,.2);border-bottom:1px solid rgba(215,180,90,.2);}'+
    'body.family-tribunal .gwrap::before{content:"⚖";position:absolute;top:50%;right:16px;'+
      'transform:translateY(-50%);font-size:96px;opacity:.03;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-tribunal .game-area{position:relative;z-index:1;}'+
    'body.family-tribunal .mission-brief{border-left-color:#d7b45a;background:rgba(215,180,90,.06);}'+
    'body.family-tribunal .btn-primary{background:#d7b45a;color:#1a1208;}'+
    'body.family-tribunal .hud{border-bottom-color:rgba(215,180,90,.4);letter-spacing:.3px;}',

  'data_center':
    'body.family-data_center .gwrap{position:relative;}'+
    'body.family-data_center .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:linear-gradient(rgba(59,130,246,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(59,130,246,.03) 1px,transparent 1px);'+
      'background-size:18px 18px;pointer-events:none;z-index:0;}'+
    'body.family-data_center .game-area{position:relative;z-index:1;}'+
    'body.family-data_center .mission-brief{border-left-color:#3b82f6;background:rgba(59,130,246,.07);}'+
    'body.family-data_center .btn-primary{background:#3b82f6;}'+
    'body.family-data_center .hud{border-bottom-color:rgba(59,130,246,.4);}',

  'mercado':
    'body.family-mercado .gwrap{position:relative;}'+
    'body.family-mercado .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:radial-gradient(circle at 25% 65%,rgba(99,102,241,.06) 0,transparent 45%),'+
        'radial-gradient(circle at 78% 28%,rgba(139,92,246,.05) 0,transparent 40%);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-mercado .game-area{position:relative;z-index:1;}'+
    'body.family-mercado .mission-brief{border-left-color:#6366f1;background:rgba(99,102,241,.07);}'+
    'body.family-mercado .btn-primary{background:#6366f1;}'+
    'body.family-mercado .hud{border-bottom-color:rgba(99,102,241,.4);}',

  // ── Fase 5: 5 familias sin CSS previo ─────────────────────────────────────

  // Sala de crisis epidemiológica — calor de mapa sanitario, radiales tipo propagación
  'salud_publica':
    'body.family-salud_publica .gwrap{position:relative;}'+
    'body.family-salud_publica .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:'+
        'radial-gradient(circle at 22% 42%,rgba(0,180,216,.08) 0,transparent 32%),'+
        'radial-gradient(circle at 66% 22%,rgba(0,180,216,.06) 0,transparent 26%),'+
        'radial-gradient(circle at 50% 78%,rgba(144,224,239,.05) 0,transparent 28%);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-salud_publica .gwrap::after{content:"🦠";position:absolute;bottom:20px;right:14px;'+
      'font-size:70px;opacity:.05;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-salud_publica .game-area{position:relative;z-index:1;}'+
    'body.family-salud_publica .mission-brief{border-left-color:#00b4d8;background:rgba(0,180,216,.06);}'+
    'body.family-salud_publica .btn-primary{background:#0ea5e9;}'+
    'body.family-salud_publica .hud{border-bottom-color:rgba(0,180,216,.4);}',

  // Expediente abierto — líneas horizontales tipo archivo, borde-carpeta lateral
  'detective':
    'body.family-detective .gwrap{position:relative;border-left:3px solid rgba(100,116,139,.35);}'+
    'body.family-detective .gwrap::before{content:"";position:absolute;inset:0;'+
      'background:repeating-linear-gradient(0deg,transparent,transparent 23px,rgba(100,116,139,.065) 24px);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-detective .gwrap::after{content:"🔍";position:absolute;bottom:20px;right:14px;'+
      'font-size:64px;opacity:.05;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-detective .game-area{position:relative;z-index:1;}'+
    'body.family-detective .mission-brief{border-left-color:#94a3b8;background:rgba(100,116,139,.07);}'+
    'body.family-detective .btn-primary{background:#475569;color:#fff;}'+
    'body.family-detective .hud{border-bottom-color:rgba(100,116,139,.4);}',

  // Auditoría / checklist — cuadrícula de hoja de verificación, watermark ✓
  'calidad':
    'body.family-calidad .gwrap{position:relative;}'+
    'body.family-calidad .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:'+
        'linear-gradient(rgba(192,132,252,.04) 1px,transparent 1px),'+
        'linear-gradient(90deg,rgba(192,132,252,.03) 1px,transparent 1px);'+
      'background-size:40px 40px;pointer-events:none;z-index:0;}'+
    'body.family-calidad .gwrap::after{content:"✓";position:absolute;bottom:12px;right:14px;'+
      'font-size:96px;font-weight:900;opacity:.04;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-calidad .game-area{position:relative;z-index:1;}'+
    'body.family-calidad .mission-brief{border-left-color:#c084fc;background:rgba(192,132,252,.07);}'+
    'body.family-calidad .btn-primary{background:#c084fc;color:#1a0533;}'+
    'body.family-calidad .hud{border-bottom-color:rgba(192,132,252,.4);}',

  // Matriz de riesgo corporativo — grid rojo/ámbar muy sutil, watermark 📋
  'compliance':
    'body.family-compliance .gwrap{position:relative;}'+
    'body.family-compliance .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:'+
        'linear-gradient(rgba(239,68,68,.03) 1px,transparent 1px),'+
        'linear-gradient(90deg,rgba(180,83,9,.025) 1px,transparent 1px);'+
      'background-size:44px 44px;pointer-events:none;z-index:0;}'+
    'body.family-compliance .gwrap::after{content:"📋";position:absolute;bottom:20px;right:14px;'+
      'font-size:64px;opacity:.05;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-compliance .game-area{position:relative;z-index:1;}'+
    'body.family-compliance .mission-brief{border-left-color:#b45309;background:rgba(180,83,9,.07);}'+
    'body.family-compliance .btn-primary{background:#92400e;color:#fff;}'+
    'body.family-compliance .hud{border-bottom-color:rgba(180,83,9,.4);}',

  // Línea del tiempo — marcas horizontales tipo eje cronológico, watermark ⏱
  'timelapse':
    'body.family-timelapse .gwrap{position:relative;}'+
    'body.family-timelapse .gwrap::before{content:"";position:absolute;inset:0;'+
      'background:repeating-linear-gradient(0deg,transparent,transparent 58px,rgba(0,180,216,.07) 59px,transparent 60px);'+
      'pointer-events:none;z-index:0;}'+
    'body.family-timelapse .gwrap::after{content:"⏱";position:absolute;top:60px;right:14px;'+
      'font-size:70px;opacity:.04;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-timelapse .game-area{position:relative;z-index:1;}'+
    'body.family-timelapse .mission-brief{border-left-color:#0ea5e9;background:rgba(14,165,233,.07);}'+
    'body.family-timelapse .btn-primary{background:#0ea5e9;}'+
    'body.family-timelapse .hud{border-bottom-color:rgba(0,180,216,.4);}',

  // ── Fase 7A: Centro de Retos — fallback premium ────────────────────────────
  // Centro de control educativo — gradiente radial elegante + grid sutil + 🎯 watermark
  'generic_premium':
    'body.family-generic_premium .gwrap{position:relative;}'+
    'body.family-generic_premium .gwrap::before{content:"";position:absolute;inset:0;'+
      'background-image:'+
        'radial-gradient(ellipse at 18% 28%,rgba(99,102,241,.08) 0,transparent 44%),'+
        'radial-gradient(ellipse at 82% 72%,rgba(139,92,246,.06) 0,transparent 40%),'+
        'linear-gradient(rgba(99,102,241,.022) 1px,transparent 1px),'+
        'linear-gradient(90deg,rgba(99,102,241,.022) 1px,transparent 1px);'+
      'background-size:100% 100%,100% 100%,48px 48px,48px 48px;'+
      'pointer-events:none;z-index:0;}'+
    'body.family-generic_premium .gwrap::after{content:"🎯";position:absolute;bottom:20px;right:14px;'+
      'font-size:70px;opacity:.045;pointer-events:none;z-index:0;line-height:1;}'+
    'body.family-generic_premium .game-area{position:relative;z-index:1;}'+
    'body.family-generic_premium .mission-brief{border-left-color:#6366f1;background:rgba(99,102,241,.07);}'+
    'body.family-generic_premium .btn-primary{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);}'+
    'body.family-generic_premium .hud{border-bottom-color:rgba(99,102,241,.45);}'
};
// Attach familyCss to each NFAMILY entry ('' for families without specific CSS — safe fallback).
NFAMILIES.forEach(function(f){f.familyCss=FAMILY_CSS[f.id]||'';});

// ════ SECTOR_MAP — familias candidatas por sector (Fase 3) ════
// Claves normalizadas (sin tildes). Todos los IDs referenciados existen en NFAMILIES.
// ── SECTOR_MAP — Fase 7A: expanded to 8-9 families per sector for diversity ──
// All sectors include generic_premium as safety net (last resort, won't dominate).
// Orden: más específicas primero; generic_premium al final.
var SECTOR_MAP={
  // ── SALUD ─────────────────────────────────────────────────────────────────
  'salud':              ['laboratorio_bio','salud_publica','clinica','calidad','detective','compliance','tribunal','timelapse','generic_premium'],
  'medicina':           ['laboratorio_bio','clinica','salud_publica','hseq','detective','compliance','calidad','timelapse','generic_premium'],
  'farmaceutica':       ['laboratorio_bio','calidad','salud_publica','compliance','clinica','tribunal','detective','timelapse','generic_premium'],
  'farmacia':           ['laboratorio_bio','calidad','salud_publica','compliance','clinica','detective','timelapse','tribunal','generic_premium'],
  'medicamentos':       ['laboratorio_bio','salud_publica','calidad','compliance','clinica','tribunal','detective','timelapse','generic_premium'],
  'farmaceutico':       ['laboratorio_bio','calidad','compliance','salud_publica','clinica','detective','timelapse','tribunal','generic_premium'],
  'servicios farmaceuticos':['laboratorio_bio','calidad','compliance','salud_publica','clinica','detective','timelapse','tribunal','generic_premium'],
  'auxiliar farmaceutico':  ['laboratorio_bio','calidad','clinica','compliance','salud_publica','tribunal','timelapse','detective','generic_premium'],
  'veterinaria':        ['clinica','laboratorio_bio','agro','expedicion_campo','calidad','detective','timelapse','generic_premium'],
  'odontologia':        ['clinica','calidad','compliance','detective','laboratorio_bio','timelapse','generic_premium'],
  // ── INDUSTRIA ─────────────────────────────────────────────────────────────
  'industria':          ['planta_industrial','hseq','calidad','detective','timelapse','alerta_ambiental','compliance','data_center','generic_premium'],
  'manufactura':        ['planta_industrial','calidad','hseq','detective','timelapse','compliance','alerta_ambiental','generic_premium'],
  'petroleo':           ['planta_industrial','hseq','alerta_ambiental','compliance','calidad','detective','timelapse','data_center','generic_premium'],
  'mineria':            ['hseq','planta_industrial','alerta_ambiental','detective','calidad','compliance','timelapse','generic_premium'],
  'construccion':       ['hseq','planta_industrial','calidad','timelapse','detective','compliance','alerta_ambiental','generic_premium'],
  'energia':            ['planta_industrial','hseq','alerta_ambiental','data_center','calidad','compliance','detective','timelapse','generic_premium'],
  // ── NEGOCIOS / EMPRENDIMIENTO ─────────────────────────────────────────────
  'negocios':           ['finanzas','mercado','pitch_inversores','tribunal','compliance','detective','arcade_universal','timelapse','generic_premium'],
  'emprendimiento':     ['pitch_inversores','mercado','hackathon','finanzas','arcade_universal','detective','compliance','timelapse','generic_premium'],
  'retail':             ['mercado','finanzas','calidad','arcade_universal','detective','compliance','timelapse','generic_premium'],
  'comercio':           ['mercado','finanzas','calidad','tribunal','compliance','detective','timelapse','generic_premium'],
  'turismo':            ['mercado','expedicion_campo','diplomacia','arcade_universal','agro','detective','calidad','generic_premium'],
  'logistica':          ['planta_industrial','finanzas','calidad','timelapse','detective','compliance','hseq','generic_premium'],
  // ── TECNOLOGÍA ────────────────────────────────────────────────────────────
  'tecnologia':         ['data_center','hackathon','ciberseguridad','detective','arcade_universal','calidad','compliance','timelapse','generic_premium'],
  'software':           ['hackathon','data_center','ciberseguridad','calidad','detective','arcade_universal','timelapse','compliance','generic_premium'],
  'telecomunicaciones': ['data_center','hackathon','planta_industrial','finanzas','ciberseguridad','detective','calidad','generic_premium'],
  // ── LEGAL ─────────────────────────────────────────────────────────────────
  'legal':              ['tribunal','compliance','detective','diplomacia','calidad','timelapse','arcade_universal','generic_premium'],
  'derecho':            ['tribunal','compliance','detective','timelapse','diplomacia','calidad','arcade_universal','generic_premium'],
  'finanzas':           ['finanzas','tribunal','compliance','arcade_universal','detective','mercado','timelapse','calidad','generic_premium'],
  'contabilidad':       ['finanzas','compliance','calidad','detective','tribunal','timelapse','arcade_universal','generic_premium'],
  // ── AMBIENTAL / AGRO ─────────────────────────────────────────────────────
  'ambiental':          ['alerta_ambiental','expedicion_campo','planta_industrial','detective','calidad','agro','timelapse','hseq','generic_premium'],
  'ambiente':           ['alerta_ambiental','expedicion_campo','detective','timelapse','agro','calidad','hseq','generic_premium'],
  'agroindustria':      ['agro','planta_industrial','calidad','alerta_ambiental','expedicion_campo','hseq','detective','generic_premium'],
  'agricultura':        ['agro','expedicion_campo','alerta_ambiental','timelapse','calidad','detective','hseq','generic_premium'],
  'agro':               ['agro','expedicion_campo','alerta_ambiental','planta_industrial','calidad','hseq','detective','generic_premium'],
  // ── EDUCACIÓN / SOCIAL ────────────────────────────────────────────────────
  'educacion':          ['aula','detective','timelapse','diplomacia','arcade_universal','calidad','compliance','generic_premium'],
  'psicologia':         ['diplomacia','aula','detective','compliance','calidad','timelapse','arcade_universal','generic_premium'],
  'comunicacion':       ['mercado','diplomacia','arcade_universal','hackathon','detective','calidad','timelapse','generic_premium'],
  'arte':               ['hackathon','aula','mercado','detective','timelapse','arcade_universal','generic_premium'],
  'gastronomia':        ['calidad','mercado','expedicion_campo','arcade_universal','detective','timelapse','generic_premium'],
  'deportes':           ['arcade_universal','hseq','timelapse','detective','calidad','compliance','generic_premium'],
  'arquitectura':       ['calidad','planta_industrial','hseq','detective','timelapse','compliance','generic_premium'],
  'seguridad':          ['hseq','compliance','detective','planta_industrial','calidad','timelapse','ciberseguridad','generic_premium'],
  'salud_mental':       ['diplomacia','aula','clinica','detective','compliance','timelapse','calidad','generic_premium'],
  'biotecnologia':      ['laboratorio_bio','calidad','data_center','detective','salud_publica','compliance','timelapse','generic_premium']
};

// ── FASE 6: INTRO SCREENS PREMIUM POR FAMILIA ──────────────────────────────
var INTRO_CFG={
  'clinica':         {k:'🏥 URGENCIAS · TURNO ACTIVO',        p:'📋 INFORME CLÍNICO',         m:['Salas','Vidas','Score'],          b:'INICIAR TURNO'},
  'laboratorio_bio': {k:'🧬 LAB · ANÁLISIS EN CURSO',         p:'🧪 PROTOCOLO DE ANÁLISIS',    m:['Muestras','Intentos','Puntos'],   b:'INICIAR ANÁLISIS'},
  'salud_publica':   {k:'🦠 SALA DE CRISIS · ALERTA ACTIVA',  p:'🌐 INFORME EPIDEMIOLÓGICO',   m:['Zonas','Vidas','Impacto'],        b:'ACTIVAR PROTOCOLO'},
  'hseq':            {k:'⚠️ ZONA CRÍTICA · PROTOCOLO ACTIVO', p:'🛡️ ANÁLISIS DE RIESGO',      m:['Áreas','Vidas','Pts'],            b:'ACTIVAR INSPECCIÓN'},
  'finanzas':        {k:'💰 SALA DE DECISIONES · ALERTA',     p:'📊 BRIEF FINANCIERO',         m:['Análisis','Capital','ROI'],       b:'ABRIR DASHBOARD'},
  'tribunal':        {k:'⚖️ AUDIENCIA · EXPEDIENTE ABIERTO',  p:'📁 EXPEDIENTE DEL CASO',      m:['Salas','Vidas','Veredicto'],      b:'INICIAR AUDIENCIA'},
  'ciberseguridad':  {k:'🔐 SOC ACTIVO · AMENAZA DETECTADA',  p:'⚡ REPORTE DE INCIDENTE',     m:['Vectores','Vidas','Score'],       b:'RESPONDER INCIDENTE'},
  'agro':            {k:'🌱 BITÁCORA DE CAMPO · TEMPORADA',   p:'📋 INFORME DE LOTE',          m:['Lotes','Vidas','Cosecha'],        b:'ABRIR BITÁCORA'},
  'detective':       {k:'🔍 CASO ACTIVO · INVESTIGACIÓN',     p:'📂 EXPEDIENTE',               m:['Pistas','Intentos','Score'],      b:'INICIAR INVESTIGACIÓN'},
  'compliance':      {k:'📋 AUDITORÍA · RIESGO DETECTADO',    p:'⚠️ ALERTA DE CUMPLIMIENTO',   m:['Áreas','Alertas','Score'],        b:'INICIAR AUDITORÍA'},
  'mercado':         {k:'🛒 ANÁLISIS DE MERCADO · TENDENCIA', p:'📊 BRIEF DE INTELIGENCIA',    m:['Segmentos','Capital','Insights'], b:'LANZAR ANÁLISIS'},
  'data_center':     {k:'🖥️ DATA CENTER · INCIDENTE ACTIVO',  p:'⚡ ALERTA DE SISTEMA',        m:['Servicios','SLA','Uptime'],       b:'RESOLVER INCIDENTE'},
  'calidad':         {k:'📐 AUDITORÍA · HALLAZGO ACTIVO',      p:'📋 HOJA DE VERIFICACIÓN',         m:['Áreas','Intentos','Score'],       b:'INICIAR AUDITORÍA'},
  'timelapse':       {k:'⏱ CRONOLOGÍA · HITO EN ANÁLISIS',    p:'📅 LÍNEA DEL TIEMPO',             m:['Períodos','Intentos','Score'],    b:'INICIAR CRONOLOGÍA'},
  // Fase 7A — fallback premium
  'generic_premium': {k:'🎯 CENTRO DE RETOS · MISIÓN ACTIVA', p:'📍 BRIEF DE MISIÓN',           m:['Etapas','Intentos','Puntos'],     b:'INICIAR MISIÓN'}
};

function buildFamilyIntro(pack,xe,gameName,tagline,emoji,capTitle,sc,numSalas,maxPts){
  var id=pack&&pack.id?String(pack.id):'';
  var cfg=INTRO_CFG[id];
  var scHasContent=sc&&(sc.location||sc.character||sc.intro);
  // Generic fallback — replicates original intro exactly
  if(!cfg){
    var statsRow='<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:28px;">'
      +'<div style="padding:10px 16px;border-radius:10px;font-size:12px;font-weight:700;background:var(--btn);border:1px solid var(--btnb);">'+numSalas+' Salas</div>'
      +'<div style="padding:10px 16px;border-radius:10px;font-size:12px;font-weight:700;background:var(--btn);border:1px solid var(--btnb);">3 Vidas</div>'
      +'<div style="padding:10px 16px;border-radius:10px;font-size:12px;font-weight:700;background:var(--btn);border:1px solid var(--btnb);">'+maxPts+' Pts</div>'
      +'</div>';
    var scenarioHtml=scHasContent
      ?'<div class="mission-brief">'
        +(sc.location?'<p class="mb-loc">📍 '+xe(sc.location)+'</p>':'')
        +(sc.character?'<p class="mb-char">👤 '+xe(sc.character)+'</p>':'')
        +(sc.intro?'<p class="mb-intro">'+xe(sc.intro)+'</p>':'')
        +'</div>'
      :'';
    return '<div id="screen-intro" class="screen active" style="justify-content:center;">\n'
      +'  <div style="text-align:center;max-width:420px;padding:20px 16px;">\n'
      +'    <div style="font-size:72px;margin-bottom:12px;animation:pulse 2s infinite;">'+emoji+'</div>\n'
      +'    <h1 style="font-size:28px;font-weight:900;margin:0 0 6px;line-height:1.2;text-shadow:0 0 16px var(--accent);">'+xe(gameName)+'</h1>\n'
      +'    <p class="game-tagline">'+xe(tagline)+'</p>\n'
      +'    <p style="font-size:12px;color:var(--t2);opacity:.55;margin:0 0 18px;letter-spacing:.3px;">'+xe(capTitle)+'</p>\n'
      +scenarioHtml
      +statsRow
      +'    <button class="btn-primary btn-pulse" onclick="showScreen(\'sala1\');startSala(1)">INICIAR</button>\n'
      +'  </div>\n</div>\n';
  }
  // Premium intro template
  var mL=cfg.m;
  var panelHtml=scHasContent
    ?'<div class="intro-panel intro-panel-'+id+'">'
      +'<div class="intro-panel-header">'+cfg.p+'</div>'
      +(sc.location?'<p class="intro-loc">📍 '+xe(sc.location)+'</p>':'')
      +(sc.character?'<p class="intro-char">'+xe(sc.character)+'</p>':'')
      +(sc.intro?'<p class="intro-brief">'+xe(sc.intro)+'</p>':'')
      +'</div>'
    :'';
  return '<div id="screen-intro" class="screen active" style="justify-content:center;">\n'
    +'<div class="premium-intro intro-'+id+'">'
    +'<p class="intro-kicker">'+cfg.k+'</p>'
    +'<div class="intro-icon">'+emoji+'</div>'
    +'<h1 class="intro-title">'+xe(gameName)+'</h1>'
    +'<p class="intro-tagline">'+xe(tagline)+'</p>'
    +'<p class="intro-sub">'+xe(capTitle)+'</p>'
    +panelHtml
    +'<div class="intro-grid">'
    +'<div class="intro-metric"><div class="intro-metric-val">'+numSalas+'</div><div class="intro-metric-lbl">'+mL[0]+'</div></div>'
    +'<div class="intro-metric"><div class="intro-metric-val">3</div><div class="intro-metric-lbl">'+mL[1]+'</div></div>'
    +'<div class="intro-metric"><div class="intro-metric-val">'+maxPts+'</div><div class="intro-metric-lbl">'+mL[2]+'</div></div>'
    +'</div>'
    +'<div class="intro-action"><button class="btn-primary btn-pulse" onclick="showScreen(\'sala1\');startSala(1)">'+cfg.b+'</button></div>'
    +'</div>\n</div>\n';
}

// ── FASE 7B: EXPERIENCE COPY — textos narrativos por familia ─────────────────
// Short keys to keep JSON small when embedded in SCORM:
//   tt=transitionTitle  tx=transitionText   tc=transitionCta
//   rp=resultTitlePass  rf=resultTitleFail
//   xp=resultTextPass   xf=resultTextFail   fc=finalCta
var EXPERIENCE_COPY={
  'generic_premium':{
    tt:'Reto completado',
    tx:'La misión avanza hacia una nueva decisión.',
    tc:'CONTINUAR MISIÓN',
    rp:'Misión completada',
    rf:'Misión pendiente de refuerzo',
    xp:'Superaste los desafíos clave y consolidaste el aprendizaje.',
    xf:'Aún hay decisiones por reforzar antes de cerrar la misión.',
    fc:'REINTENTAR MISIÓN'
  },
  'clinica':{
    tt:'Paciente estabilizado',
    tx:'El turno continúa. Revisa el siguiente caso clínico.',
    tc:'CONTINUAR TURNO',
    rp:'Turno completado con seguridad',
    rf:'Caso clínico pendiente de estabilización',
    xp:'Aplicaste criterios seguros y tomaste decisiones clínicas acertadas.',
    xf:'Revisa el protocolo antes de volver a atender el caso.',
    fc:'REVISAR TURNO'
  },
  'laboratorio_bio':{
    tt:'Muestra validada',
    tx:'El análisis continúa con una nueva evidencia.',
    tc:'CONTINUAR ANÁLISIS',
    rp:'Protocolo validado',
    rf:'Resultados inconclusos',
    xp:'Interpretaste correctamente las señales críticas del laboratorio.',
    xf:'Algunas evidencias requieren una nueva revisión del protocolo.',
    fc:'REPETIR ANÁLISIS'
  },
  'salud_publica':{
    tt:'Zona controlada',
    tx:'El brote avanza. Evalúa la siguiente zona de intervención.',
    tc:'CONTINUAR INTERVENCIÓN',
    rp:'Protocolo de crisis validado',
    rf:'Brote no contenido',
    xp:'Tomaste decisiones epidemiológicas que redujeron el impacto del brote.',
    xf:'Refuerza los criterios de intervención antes de reactivar el protocolo.',
    fc:'REINICIAR PROTOCOLO'
  },
  'hseq':{
    tt:'Área despejada',
    tx:'La inspección continúa en la siguiente zona de riesgo.',
    tc:'CONTINUAR INSPECCIÓN',
    rp:'Zona certificada sin incidentes',
    rf:'Riesgos sin mitigar',
    xp:'Identificaste y gestionaste los riesgos críticos con criterio técnico.',
    xf:'Refuerza los protocolos de seguridad antes de reactivar la zona.',
    fc:'REVISAR INSPECCIÓN'
  },
  'finanzas':{
    tt:'Decisión registrada',
    tx:'El dashboard actualiza. Nueva alerta financiera detectada.',
    tc:'CONTINUAR ANÁLISIS',
    rp:'Dashboard en verde',
    rf:'Alertas financieras activas',
    xp:'Tomaste decisiones financieras sólidas y mantuviste la rentabilidad.',
    xf:'Revisa los indicadores clave antes de volver a operar el dashboard.',
    fc:'REVISAR DASHBOARD'
  },
  'tribunal':{
    tt:'Evidencia admitida',
    tx:'El expediente avanza hacia una nueva decisión.',
    tc:'CONTINUAR AUDIENCIA',
    rp:'Veredicto favorable',
    rf:'Caso pendiente de sustento',
    xp:'Sustentaste las decisiones con criterios sólidos y argumentos válidos.',
    xf:'El expediente necesita mejores argumentos antes del cierre del caso.',
    fc:'REABRIR EXPEDIENTE'
  },
  'ciberseguridad':{
    tt:'Amenaza contenida',
    tx:'El SOC detecta una nueva señal en el sistema.',
    tc:'ANALIZAR SIGUIENTE ALERTA',
    rp:'Incidente mitigado',
    rf:'Brecha aún activa',
    xp:'Identificaste patrones críticos y protegiste el sistema correctamente.',
    xf:'La amenaza requiere una nueva revisión de logs y vectores.',
    fc:'REANALIZAR LOGS'
  },
  'agro':{
    tt:'Lote evaluado',
    tx:'La bitácora avanza al siguiente ciclo del cultivo.',
    tc:'CONTINUAR BITÁCORA',
    rp:'Temporada completada',
    rf:'Ciclo pendiente de revisión',
    xp:'Tomaste decisiones agronómicas acertadas para la temporada.',
    xf:'Revisa los indicadores fitosanitarios antes de cerrar el ciclo.',
    fc:'REVISAR TEMPORADA'
  },
  'detective':{
    tt:'Pista confirmada',
    tx:'El expediente revela un nuevo ángulo del caso.',
    tc:'CONTINUAR INVESTIGACIÓN',
    rp:'Caso resuelto',
    rf:'Caso sin cerrar',
    xp:'Conectaste las evidencias correctas y resolviste el análisis.',
    xf:'Aún hay pistas sin conectar. Revisa el expediente antes de cerrar.',
    fc:'REABRIR CASO'
  },
  'calidad':{
    tt:'Hallazgo documentado',
    tx:'La auditoría continúa en la siguiente área de verificación.',
    tc:'CONTINUAR AUDITORÍA',
    rp:'Auditoría aprobada',
    rf:'No conformidades pendientes',
    xp:'Identificaste los hallazgos críticos y aplicaste criterio de calidad.',
    xf:'Existen no conformidades sin resolver antes de cerrar la auditoría.',
    fc:'REVISAR AUDITORÍA'
  },
  'compliance':{
    tt:'Riesgo evaluado',
    tx:'La matriz de riesgo actualiza. Nueva alerta de cumplimiento.',
    tc:'CONTINUAR AUDITORÍA',
    rp:'Matriz de riesgo en verde',
    rf:'Riesgos de cumplimiento activos',
    xp:'Gestionaste los dilemas éticos y normativos con criterio sólido.',
    xf:'Revisa los criterios de cumplimiento antes de cerrar el proceso.',
    fc:'REVISAR CUMPLIMIENTO'
  },
  'timelapse':{
    tt:'Hito registrado',
    tx:'La línea del tiempo avanza al siguiente período clave.',
    tc:'CONTINUAR LÍNEA DEL TIEMPO',
    rp:'Cronología completada',
    rf:'Hitos sin contextualizar',
    xp:'Ubicaste correctamente los hitos y comprendiste su evolución histórica.',
    xf:'Algunos hitos requieren mayor contextualización. Revisa la cronología.',
    fc:'REVISAR CRONOLOGÍA'
  },
  'mercado':{
    tt:'Segmento analizado',
    tx:'El radar de mercado detecta una nueva tendencia.',
    tc:'CONTINUAR ANÁLISIS',
    rp:'Análisis de mercado validado',
    rf:'Insights incompletos',
    xp:'Identificaste patrones del consumidor y ventajas competitivas clave.',
    xf:'El análisis necesita profundizar en algunos segmentos del mercado.',
    fc:'REINICIAR ANÁLISIS'
  },
  'data_center':{
    tt:'Servicio restaurado',
    tx:'El sistema detecta una nueva anomalía en el stack.',
    tc:'ATENDER SIGUIENTE INCIDENTE',
    rp:'Incidente resuelto — SLA cumplido',
    rf:'SLA comprometido',
    xp:'Gestionaste el incidente con criterio técnico y mantuviste el SLA.',
    xf:'Revisa los procedimientos de respuesta antes de reactivar el servicio.',
    fc:'REVISAR INCIDENTE'
  }
};

// getExperienceCopy: returns copy object for a given pack/family.
// Falls back to generic_premium if id not found; final hardcoded fallback if object missing.
function getExperienceCopy(pack){
  var id=pack&&pack.id?String(pack.id):'';
  if(EXPERIENCE_COPY[id])return EXPERIENCE_COPY[id];
  if(EXPERIENCE_COPY['generic_premium'])return EXPERIENCE_COPY['generic_premium'];
  return{tt:'Etapa completada',tx:'Continúa con la siguiente sección.',tc:'CONTINUAR',
    rp:'Completado exitosamente',rf:'Requiere refuerzo',
    xp:'Demostraste dominio del contenido.',xf:'Repasa el contenido e inténtalo de nuevo.',fc:'REINTENTAR'};
}

// Static renderArea implementations — extracted with .toString() at build time.
// All use standard {q, opts:[4], correct, fb} question format.
var SRENDERS=[
  // 0 Quiz Clásico — 4 buttons stacked
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<p style="font-size:17px;font-weight:700;margin:0 0 18px;line-height:1.4;">'+q.q+'</p>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:block;width:100%;padding:14px 18px;margin:6px 0;border-radius:10px;text-align:left;cursor:pointer;font-size:15px;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('');}catch(e){console.error('renderArea',e);}},
  // 1 Grid 2×2 — 4 buttons in equal grid
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<p style="font-size:17px;font-weight:700;margin:0 0 16px;line-height:1.4;">'+q.q+'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="height:90px;border-radius:14px;font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center;text-align:center;padding:10px;line-height:1.3;font-weight:700;font-family:inherit;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}},
  // 2 Kahoot — colored buttons with symbols
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var clrs=['#EF4444','#3B82F6','#EAB308','#22C55E'],sym=['▲','◆','●','✿'];area.innerHTML='<p style="font-size:20px;font-weight:800;text-align:center;margin:0 0 20px;line-height:1.3;">'+q.q+'</p><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">'+G.currentOpts.map(function(o,i){return '<button onclick="checkSala('+n+','+i+')" style="height:80px;border-radius:14px;font-size:13px;font-weight:800;cursor:pointer;background:'+clrs[i%4]+';color:#fff;border:none;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px;text-align:center;line-height:1.3;"><span style="font-size:22px;flex-shrink:0;">'+sym[i%4]+'</span>'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}},
  // 3 Neon Selector — bars with accent left border
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<p style="font-size:17px;font-weight:700;margin:0 0 16px;line-height:1.4;">'+q.q+'</p>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:flex;align-items:center;width:100%;height:58px;margin:6px 0;border-radius:0 10px 10px 0;padding-left:18px;border-left:4px solid var(--accent);cursor:pointer;font-size:15px;text-align:left;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('');}catch(e){console.error('renderArea',e);}},
  // 4 Match de Tarjetas — term in big box + 4 definition cards
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<div style="font-size:20px;font-weight:800;text-align:center;padding:20px;border-radius:16px;margin-bottom:14px;background:rgba(255,255,255,.08);line-height:1.3;">'+q.q+'</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="padding:16px 12px;border-radius:14px;font-size:12px;cursor:pointer;text-align:left;line-height:1.4;font-family:inherit;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}},
  // 5 Simulador de Decisiones — scenario box + labeled buttons A/B/C/D
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var lbl=['A','B','C','D'];area.innerHTML='<div style="border-radius:12px;padding:16px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);margin-bottom:14px;"><p style="font-size:11px;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin:0 0 8px;">PREGUNTA</p><p style="font-size:15px;font-weight:600;margin:0;line-height:1.4;">'+q.q+'</p></div>'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="display:flex;align-items:center;gap:12px;width:100%;padding:11px 14px;margin:5px 0;border-radius:10px;cursor:pointer;text-align:left;font-size:13px;font-family:inherit;"><span style="min-width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;background:rgba(255,255,255,.15);">'+lbl[i]+'</span><span>'+o+'</span></button>';}).join('');}catch(e){console.error('renderArea',e);}},
  // 6 Tarjetas Reveal — flex-wrap cards
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;area.innerHTML='<p style="font-size:16px;font-weight:700;text-align:center;margin-bottom:18px;line-height:1.4;">'+q.q+'</p><div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="width:142px;height:90px;border-radius:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:13px;text-align:center;padding:10px;line-height:1.3;font-family:inherit;font-weight:700;">'+o+'</button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}},
  // 7 Pictogram Quiz — numbered cards ①②③④
  function renderArea(n){try{var q=PREGUNTAS['sala'+n][G.idx];G.currentOpts=shuffle((q.opts||[]).slice());var area=document.getElementById('area'+n);if(!area)return;var nums=['\u2460','\u2461','\u2462','\u2463'];area.innerHTML='<p style="font-size:17px;font-weight:700;text-align:center;margin-bottom:16px;line-height:1.4;">'+q.q+'</p><div style="display:flex;flex-wrap:wrap;gap:12px;justify-content:center;">'+G.currentOpts.map(function(o,i){return '<button class="btn-op" onclick="checkSala('+n+','+i+')" style="width:132px;height:104px;border-radius:16px;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:8px;"><span style="font-size:26px;">'+nums[i%4]+'</span><span style="font-size:12px;text-align:center;line-height:1.3;font-family:inherit;">'+o+'</span></button>';}).join('')+'</div>';}catch(e){console.error('renderArea',e);}}
];

/**
 * Tope de tokens de salida por mecánica. La mayoría de preguntas son cortas
 * (pregunta + 4 opciones cortas) y 6000 les sobra — pero "Error Hunter" exige
 * un "context" de 300-900 chars POR PREGUNTA (4 salas × 4 preguntas = hasta
 * 16 párrafos completos en una sola respuesta) e "Inspector de Planta" tiene
 * un campo "scene" similar. Con el mismo tope de 6000 para todas, esas dos
 * mecánicas podían truncarse a mitad de generación y perder el capítulo
 * completo (confirmado: Cap con Error Hunter + 4 salas devolvía "0 salas"
 * en ambos intentos porque el segundo usa el mismo prompt reforzado con el
 * mismo tope). El resto de mecánicas se queda en 6000 — subirlo para todas
 * encarecería y alentaría la generación sin necesidad.
 */
function _scormMaxTok(mecName){
  // 11000 se calibró contra un caso confirmado de 4 salas — con 5 salas (el máximo del
  // sorteo original) seguía truncándose. Ahora que el sorteo también baja esas dos
  // mecánicas a 3-4 salas como máximo, 14000 da margen real de sobra en vez de ir justo.
  return (mecName==='Error Hunter'||mecName==='Inspector de Planta')?14000:6000;
}

/**
 * JSON schema para output_config estructurado — garantiza que la respuesta
 * de la IA tenga exactamente los campos que cada mecánica necesita (evita
 * que el modelo omita "steps"/"items"/"context" o los reemplace por "opts").
 * No cubre restricciones de cantidad/longitud (el schema de Claude no las
 * soporta) — esas reglas se mantienen como instrucción en el prompt.
 */
function _scormDataSchema(mecName){
  var scenario={type:'object',properties:{
    location:{type:'string'},character:{type:'string'},intro:{type:'string'}
  },required:['location','character','intro'],additionalProperties:false};

  var pregunta;
  if(mecName==='Secuencia de Proceso Pro'){
    pregunta={type:'object',properties:{
      q:{type:'string'},
      steps:{type:'array',items:{type:'object',properties:{
        id:{type:'string'},label:{type:'string'},order:{type:'integer'}
      },required:['id','label','order'],additionalProperties:false}},
      fb:{type:'string'},
      tolerance:{type:['integer','null']}
    },required:['q','steps','fb','tolerance'],additionalProperties:false};
  }else if(mecName==='Secuencia de Proceso'){
    pregunta={type:'object',properties:{
      q:{type:'string'},
      steps:{type:'array',items:{type:'string'}},
      fb:{type:'string'}
    },required:['q','steps','fb'],additionalProperties:false};
  }else if(mecName==='Inspector de Planta'){
    pregunta={type:'object',properties:{
      q:{type:'string'},scene:{type:'string'},
      opts:{type:'array',items:{type:'string'}},
      correct:{type:'string'},fb:{type:'string'}
    },required:['q','scene','opts','correct','fb'],additionalProperties:false};
  }else if(mecName==='Turno de Operario'){
    pregunta={type:'object',properties:{
      q:{type:'string'},
      opts:{type:'array',items:{type:'string'}},
      correct:{type:'string'},consequence:{type:'string'},fb:{type:'string'}
    },required:['q','opts','correct','consequence','fb'],additionalProperties:false};
  }else if(mecName==='Checklist Crítico'){
    pregunta={type:'object',properties:{
      q:{type:'string'},
      items:{type:'array',items:{type:'object',properties:{
        label:{type:'string'},required:{type:'boolean'}
      },required:['label','required'],additionalProperties:false}},
      minRequired:{type:'integer'},fb:{type:'string'}
    },required:['q','items','minRequired','fb'],additionalProperties:false};
  }else if(mecName==='Error Hunter'){
    pregunta={type:'object',properties:{
      q:{type:'string'},context:{type:'string'},
      errorSpans:{type:'array',items:{type:'object',properties:{
        id:{type:'string'},text:{type:'string'},isError:{type:'boolean'}
      },required:['id','text','isError'],additionalProperties:false}},
      correct:{type:'string'},fb:{type:'string'}
    },required:['q','context','errorSpans','correct','fb'],additionalProperties:false};
  }else{
    // Default: la gran mayoría de mecánicas (opts/correct), incluye variantes 2-opts
    pregunta={type:'object',properties:{
      q:{type:'string'},
      opts:{type:'array',items:{type:'string'}},
      correct:{type:'string'},fb:{type:'string'}
    },required:['q','opts','correct','fb'],additionalProperties:false};
  }

  var sala={type:'object',properties:{
    name:{type:'string'},
    preguntas:{type:'array',items:pregunta}
  },required:['name','preguntas'],additionalProperties:false};

  return {type:'object',properties:{
    gameName:{type:'string'},tagline:{type:'string'},emoji:{type:'string'},
    scenario:scenario,
    salas:{type:'array',items:sala}
  },required:['gameName','tagline','emoji','scenario','salas'],additionalProperties:false};
}

function pSCORM_data(item,c){
  var mecName=(item.mec?item.mec.name:'Quiz');
  var isSeq=mecName==='Secuencia de Proceso';
  var isSeqPro=mecName==='Secuencia de Proceso Pro';
  var isInspect=mecName==='Inspector de Planta';
  var isTurno=mecName==='Turno de Operario';
  var isChecklist=mecName==='Checklist Crítico';
  var isErrorHunter=mecName==='Error Hunter';
  var qf;
  if(isSeqPro){
    qf=(item.mec&&item.mec.qf)?item.mec.qf:'{"q":"¿En qué orden se ejecutan los pasos de este procedimiento?","steps":[{"id":"s1","label":"Primer paso","order":1},{"id":"s2","label":"Segundo paso","order":2},{"id":"s3","label":"Tercer paso","order":3},{"id":"s4","label":"Cuarto paso","order":4}],"fb":"Explicación del orden correcto","tolerance":0}';
  }else if(isSeq){
    qf='{"q":"nombre del procedimiento a ordenar","steps":["Paso 1 en orden correcto","Paso 2","Paso 3","Paso 4"],"fb":"retroalimentación"} — steps es el orden CORRECTO; NO incluyas opts ni correct';
  }else if(isInspect){
    qf='{"q":"¿Qué anomalía o riesgo debes identificar?","scene":"descripción de la escena 2 oraciones","opts":["anomalía real","observación normal 1","observación normal 2","observación normal 3"],"correct":"anomalía real","fb":"retroalimentación"}';
  }else if(isTurno){
    qf='{"q":"situación operacional crítica que requiere decisión","opts":["decisión correcta","decisión incorrecta 1","decisión incorrecta 2","decisión incorrecta 3"],"correct":"decisión correcta","consequence":"qué ocurre en la instalación si se decide mal (1 oración dramática)","fb":"retroalimentación"}';
  }else if(isChecklist){
    qf=(item.mec&&item.mec.qf)?item.mec.qf:'{"q":"Caso o protocolo a verificar","items":[{"label":"Paso crítico 1","required":true},{"label":"Paso crítico 2","required":true},{"label":"Paso crítico 3","required":true},{"label":"Paso recomendado 1","required":false},{"label":"Paso recomendado 2","required":false}],"minRequired":3,"fb":"feedback"}';
  }else if(isErrorHunter){
    qf=(item.mec&&item.mec.qf)?item.mec.qf:'{"q":"¿Qué fragmento contiene el error?","context":"Texto con el error intencionado","errorSpans":[{"id":"e1","text":"fragmento erróneo","isError":true},{"id":"e2","text":"fragmento correcto","isError":false},{"id":"e3","text":"otro fragmento correcto","isError":false}],"correct":"e1","fb":"Explicación del error"}';
  }else{
    qf=(item.mec&&item.mec.qf)?item.mec.qf:'{"q":"pregunta","opts":["correcta","d1","d2","d3"],"correct":"correcta","fb":"feedback"}';
  }
  var is2opts=qf.indexOf('["VERDADERO","FALSO"]')>=0||qf.indexOf('["CORRECTO","INCORRECTO"]')>=0;
  var optsRule=is2opts
    ?'- opts: EXACTAMENTE 2 opciones como se indica\n'
    :isSeqPro
      ?'- steps: entre 4 y 7 objetos {id,label,order}; id=s1…s7; label texto plano máx 12 palabras sin HTML; order entero único consecutivo empezando en 1; NO incluyas opts ni correct\n'
      :isSeq
        ?'- steps: exactamente 4 pasos EN ORDEN CORRECTO — sin opts ni correct\n'
        :isChecklist
          ?'- items: entre 5 y 8 objetos {label,required}; mínimo 2 required:true y 2 required:false; minRequired=número total de required:true; NO incluyas opts ni correct\n'
          :isErrorHunter
            ?'- context: texto plano 300-900 chars con el error intencionado; errorSpans: 3-6 objetos {id,text,isError}; exactamente 1 isError:true; correct=id del error; cada text debe aparecer literalmente en context; NO incluyas opts\n'
            :'- opts: exactamente 4 opciones; "correct" debe ser EXACTAMENTE igual a una de opts\n';
  var packCtx='';
  if(item.pack){
    packCtx='\nFamilia narrativa asignada: '+item.pack.label+' ('+item.pack.id+')'
      +'\n  Icono: '+item.pack.icon
      +'\n  Metáfora visual: '+item.pack.visualMetaphor
      +'\n  Tono y estilo: '+item.pack.promptStyle
      +'\n  Sectores compatibles: '+(item.pack.compatibleSectors||[]).join(', ')
      +'\n  Legibilidad tipográfica: '+item.pack.readableFontStrategy
      +'\n  → Aplica esta metáfora en: gameName, tagline, scenario.location, scenario.character, scenario.intro y nombres de salas.'
      +'\n  → El contenido educativo (preguntas, opciones, feedback) debe mantener claridad y legibilidad absoluta, independientemente del estilo narrativo.\n';
  }
  return c+'\n\nGenera las preguntas para un juego SCORM educativo.\n'
    +'Mecánica: '+mecName+' | Capítulo '+item.cap.n+': "'+item.cap.t+'" | Módulo: '+item.cap.mn+' | Sector: '+D.sector+' | País: '+D.pais
    +packCtx+'\n\n'
    +'Responde SOLO con JSON válido (sin markdown, sin texto extra):\n'
    +'{\n'
    +'  "gameName": "Nombre narrativo con metáfora fuerte (máx 6 palabras) — estilo: Operación Ecosistema, Sala de Crisis, El Infiltrado, UCI Comunitaria, Bóveda de Decisiones, Mapa de Tendencias. NUNCA uses: Quiz de..., Evaluación de..., Actividad de..., Reto de aprendizaje...",\n'
    +'  "tagline": "Subtítulo de 5 a 9 palabras que refuerce la misión, tensión o urgencia de la experiencia",\n'
    +'  "emoji": "un solo emoji representativo de la metáfora del juego",\n'
    +'  "scenario": {\n'
    +'    "location": "Nombre real de instalación/empresa del sector '+D.sector+' en '+D.pais+'",\n'
    +'    "character": "Nombre y cargo del personaje (ej: Técnico Andrés Morales, Inspectora HSEQ María Torres)",\n'
    +'    "intro": "3 oraciones cinematográficas: (1) contexto — dónde estás y qué está ocurriendo, (2) conflicto — el problema o riesgo que se ha detectado, (3) misión — qué debe hacer el estudiante para resolverlo."\n'
    +'  },\n'
    +'  "salas": [\n'
    +'    {\n'
    +'      "name": "Nombre dramático que combine ubicación + tensión o reto (ej: Zona de Validación — Hipótesis en Riesgo, Cámara de Clientes — Señales Confusas, Radar de Mercado — Competidor Detectado)",\n'
    +'      "preguntas": [\n'
    +'        '+qf+',\n'
    +'        ... 4 preguntas por sala\n'
    +'      ]\n'
    +'    }\n'
    +'  ]\n'
    +'}\n\n'
    +'REGLAS CRÍTICAS:\n'
    +'- Genera exactamente '+item.salas+' salas con exactamente 4 preguntas cada una\n'
    +optsRule
    +'- gameName: metáfora narrativa fuerte, máx 6 palabras. PROHIBIDO: "Quiz", "Evaluación", "Actividad", "Reto de aprendizaje"\n'
    +'- tagline: 5 a 9 palabras, tono de misión o urgencia, diferente al gameName\n'
    +'- scenario.location: instalación o empresa real del sector en '+D.pais+' (ej petróleo: "Planta Caño Limón, Arauca")\n'
    +'- scenario.character: nombre latinoamericano realista, cargo relacionado con "'+item.cap.t+'"\n'
    +'- scenario.intro: exactamente 3 oraciones — contexto, conflicto, misión del estudiante\n'
    +'- salas[].name: ubicación real + estado de tensión, no genérico (NUNCA "Sala 1", "Sala A")\n'
    +'- Preguntas específicas sobre "'+item.cap.t+'" con ejemplos de '+D.sector+' en '+D.pais+'\n'
    +'- Variar tipos: conceptual, aplicada, caso real, identificar el error\n'
    +'- LONGITUD: pregunta (campo q) máximo 250 caracteres; cada opción máximo 120 caracteres; feedback (fb) máximo 200 caracteres; sé concreto y directo\n'
    +'- DISTRACTORES: deben representar errores conceptuales reales y típicos del estudiante, no respuestas absurdas; deben ser plausibles, del mismo dominio; PROHIBIDO usar "todas las anteriores" o "ninguna de las anteriores"\n'
    +'- LONGITUD IGUALADA (regla dura, no aproximada): mide en caracteres la opción correcta y cada distractor. La diferencia entre la MÁS LARGA y la MÁS CORTA de las 4 opciones —incluida la correcta— NO debe superar 15 caracteres. La respuesta correcta JAMÁS puede ser la opción más larga del grupo — si el hecho correcto necesita más matiz o detalle, alarga los distractores para igualar, nunca acortes la correcta a costa de precisión. Un estudiante NUNCA debe poder adivinar la respuesta solo por ser la más larga.\n'
    +'- SOLO el JSON, nada más\n'
    +'- IMPORTANTE: cierra todos los arrays y objetos JSON correctamente antes de terminar';
}

function buildScormHtml(item,data){
  var th=STHEMES[item.tIdx%STHEMES.length];
  var renderFn=(item.mec&&item.mec.rf)?item.mec.rf.toString():SRENDERS[0].toString();
  var capTitle=item.cap.t;
  // Fase 4 — family class + CSS (safe defaults if pack missing)
  var familyId=item.pack&&item.pack.id?String(item.pack.id).replace(/[^a-z0-9_-]/g,''):'generic';
  var familyCls='family-'+familyId;
  var familyCssStr=item.pack&&item.pack.familyCss?item.pack.familyCss:'';
  var rawName=String((data.gameName)||capTitle||'Misi\u00F3n Interactiva');
  var gameName=rawName.length>80?rawName.substring(0,80):rawName;
  var tagline=String((data.tagline)||'Supera cada reto y completa la misi\u00F3n.');
  var emoji=data.emoji||(item.pack?item.pack.icon:'')||'\uD83C\uDFAE';
  var numSalas=item.salas;
  var salas=data.salas||[];
  // PART 7 FIX: do NOT pad with empty-preguntas salas — they trigger "Sin preguntas" screens.
  // Only trim or stop at the requested count. If AI returned fewer salas with content, use what we have.
  // Filter out completely empty salas (no preguntas array or zero-length preguntas) before padding.
  var salasWithContent=salas.filter(function(s){return s&&Array.isArray(s.preguntas)&&s.preguntas.length>0;});
  // If AI returned full count with content, use all. If fewer, use what exists (don't pad with empties).
  if(salasWithContent.length>0&&salasWithContent.length<salas.length){
    // Some salas have content, some don't — keep only those with content up to numSalas
    salas=salasWithContent.slice(0,numSalas);
  } else if(salasWithContent.length===0){
    // AI returned no content at all — keep original salas (may be empty, handled by startSala guard)
    salas=salas.slice(0,numSalas);
  } else {
    salas=salas.slice(0,numSalas);
  }
  // Clamp numSalas to actual number of salas available (never inflate with empty entries)
  numSalas=Math.max(1,Math.min(numSalas,salas.length>0?salas.length:item.salas));
  // If we still have fewer salas than requested AND they have content, pad names only (not empty preguntas)
  // This ensures the SCORM structure matches exactly the salas we have
  var salaNames=salas.map(function(s,i){return(s&&s.name)||('Sala '+(i+1));});
  function xe(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
  var pregJs='var PREGUNTAS={\n';
  for(var pi=0;pi<numSalas;pi++){
    var pqs=(salas[pi]&&salas[pi].preguntas)||[];
    pregJs+='  sala'+(pi+1)+':'+JSON.stringify(pqs)+(pi<numSalas-1?',':'')+'\n';
  }
  pregJs+='};\n';
  // Fase 7B — inject XCOPY constant into SCORM script (used by endGame/gameOver)
  var xcopy=getExperienceCopy(item.pack);
  pregJs+='var XCOPY='+JSON.stringify(xcopy)+';\n';
  var maxPts=0;
  for(var pi=0;pi<numSalas;pi++){maxPts+=((salas[pi]&&salas[pi].preguntas)||[]).length*10;}
  if(!maxPts)maxPts=numSalas*40;
  var h='<!DOCTYPE html>\n<html lang="es">\n<head>\n'
    +'<meta charset="UTF-8">\n'
    +'<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">\n'
    +'<title>'+xe(capTitle)+'</title>\n'
    +'<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    +'<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    +'<link href="'+th.fu+'" rel="stylesheet">\n'
    +'<style>\n'
    +':root{'+th.v+'--bg:'+th.bg+';}\n'
    +'*{box-sizing:border-box}\n'
    +'body{margin:0;padding:0;font-family:"'+th.font+'",sans-serif;background:var(--bg);color:var(--text);line-height:1.5;}\n'
    +'.screen{display:none;position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;overflow-y:auto;background:var(--bg);}\n'
    +'.screen.active{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;}\n'
    +'.gwrap{width:100%;max-width:680px;padding:60px 16px 80px;}\n'
    +'.game-area{width:100%;max-width:680px;}\n'
    +'.hud{position:fixed;top:0;left:0;width:100%;height:44px;z-index:1001;display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:13px;font-weight:700;background:var(--hud);border-bottom:1px solid var(--btnb);}\n'
    +'#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:1002;display:none;padding:12px 24px;border-radius:10px;color:#fff;font-weight:700;pointer-events:none;max-width:90vw;text-align:center;}\n'
    +'.btn-op{background:var(--btn);color:var(--btnt)!important;border:1px solid var(--btnb);cursor:pointer;font-family:inherit;font-weight:700;transition:opacity .15s,transform .12s,box-shadow .15s;min-height:52px;box-sizing:border-box;}\n'
    +'.btn-op *{color:inherit!important;}\n'
    // Cuando varias opciones comparten fila (grid/flex-wrap en columnas), que todas
    // se estiren a la altura de la más alta — evita cajas dispares por texto largo.
    +'div[style*="display:flex"]:not(.hud) > .btn-op,div[style*="display:grid"] > .btn-op{align-self:stretch;}\n'
    // Para mecánicas de lista vertical (sin wrapper flex/grid), _eqOpts() iguala
    // las alturas por JS tras cada render — el selector CSS de arriba no las cubre.
    +'.hud-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;margin-right:10px;}\n'
    +'.btn-op:hover{opacity:.9;transform:translateY(-2px);box-shadow:0 4px 18px rgba(0,0,0,.4);}'
    +'.btn-op:active{transform:translateY(0) scale(.96);transition:transform .07s;}'
    +'@keyframes qi{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}'
    +'@keyframes areaPop{0%{transform:scale(.97)}100%{transform:scale(1)}}'
    +'.qi-anim{animation:qi .22s ease-out both;}\n'
    +'.btn-primary{background:var(--accent);color:#000;border:none;cursor:pointer;font-weight:800;font-family:inherit;font-size:16px;padding:14px 32px;border-radius:12px;letter-spacing:.5px;transition:all .2s;}\n'
    +'.btn-primary:hover{opacity:.9;transform:scale(1.03);}\n'
    +'@keyframes pulse{0%,100%{box-shadow:0 0 8px var(--accent)}50%{box-shadow:0 0 24px var(--accent2)}}\n'
    +'.btn-pulse{animation:pulse 1.5s infinite;}\n'
    +'.game-tagline{font-size:13px;font-weight:600;color:var(--accent2,var(--accent));opacity:.85;letter-spacing:.6px;margin:0 0 18px;max-width:340px;line-height:1.4;text-align:center;}\n'
    +'.mission-brief{background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.14);border-left:3px solid var(--accent);border-radius:0 12px 12px 0;padding:14px 16px;margin-bottom:20px;text-align:left;}\n'
    +'.mission-brief .mb-loc{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;opacity:.5;margin:0 0 5px;}\n'
    +'.mission-brief .mb-char{font-size:13px;font-weight:800;margin:0 0 6px;color:var(--accent);}\n'
    +'.mission-brief .mb-intro{font-size:13px;opacity:.82;margin:0;line-height:1.6;}\n'
    +'@media(max-width:480px){.gwrap{padding:60px 12px 80px;}.game-tagline{font-size:12px;}}\n'
    // ── PREMIUM INTRO: CSS for buildFamilyIntro() ──
    +'/* ── PREMIUM INTRO ── */\n'
    +'.premium-intro{display:flex;flex-direction:column;align-items:flex-start;max-width:500px;width:100%;padding:24px 20px;box-sizing:border-box;}\n'
    +'.intro-kicker{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:var(--accent);margin:0 0 14px;opacity:.9;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-icon{font-size:56px;margin-bottom:10px;animation:pulse 2s infinite;line-height:1;}\n'
    +'.intro-title{font-size:26px;font-weight:900;margin:0 0 6px;line-height:1.2;text-shadow:0 0 14px var(--accent);}\n'
    +'.intro-tagline{font-size:14px;font-weight:600;color:var(--accent2,var(--accent));opacity:.85;letter-spacing:.5px;margin:0 0 4px;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-sub{font-size:11px;color:var(--t2);opacity:.5;margin:0 0 16px;letter-spacing:.3px;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-panel{width:100%;border-left:3px solid var(--accent);background:rgba(255,255,255,.055);border-radius:0 10px 10px 0;padding:12px 14px;margin-bottom:16px;box-sizing:border-box;}\n'
    +'.intro-panel-header{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:1.4px;opacity:.5;margin-bottom:8px;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-loc{font-size:10px;text-transform:uppercase;letter-spacing:1.2px;opacity:.5;margin:0 0 5px;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-char{font-size:13px;font-weight:800;margin:0 0 5px;color:var(--accent);font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-brief{font-size:13px;opacity:.82;margin:0;line-height:1.6;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;margin-bottom:20px;}\n'
    +'.intro-metric{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 8px;text-align:center;}\n'
    +'.intro-metric-val{font-size:20px;font-weight:900;color:var(--accent);line-height:1;}\n'
    +'.intro-metric-lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;opacity:.55;margin-top:3px;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'.intro-action{width:100%;}\n'
    +'.intro-action .btn-primary{width:100%;text-align:center;letter-spacing:1.2px;}\n'
    // Family panel accent colours
    +'.intro-panel-clinica{border-left-color:#ef4444;}.intro-panel-laboratorio_bio{border-left-color:#22d3ee;}.intro-panel-salud_publica{border-left-color:#00b4d8;}\n'
    +'.intro-panel-hseq{border-left-color:#f97316;}.intro-panel-finanzas{border-left-color:#fbbf24;}.intro-panel-tribunal{border-left-color:#a78bfa;}\n'
    +'.intro-panel-ciberseguridad{border-left-color:#4ade80;}.intro-panel-agro{border-left-color:#86efac;}.intro-panel-detective{border-left-color:#94a3b8;}\n'
    +'.intro-panel-compliance{border-left-color:#f59e0b;}.intro-panel-mercado{border-left-color:#fb923c;}.intro-panel-data_center{border-left-color:#38bdf8;}\n'
    // Family kicker colours
    +'.intro-clinica .intro-kicker{color:#ef4444;}.intro-laboratorio_bio .intro-kicker{color:#22d3ee;}.intro-salud_publica .intro-kicker{color:#00b4d8;}\n'
    +'.intro-hseq .intro-kicker{color:#f97316;}.intro-finanzas .intro-kicker{color:#fbbf24;}.intro-tribunal .intro-kicker{color:#a78bfa;}\n'
    +'.intro-ciberseguridad .intro-kicker{color:#4ade80;font-family:monospace;}.intro-agro .intro-kicker{color:#86efac;}\n'
    +'.intro-detective .intro-kicker{color:#94a3b8;}.intro-compliance .intro-kicker{color:#f59e0b;}\n'
    +'.intro-mercado .intro-kicker{color:#fb923c;}.intro-data_center .intro-kicker{color:#38bdf8;font-family:monospace;}\n'
    +'.intro-calidad .intro-kicker{color:#c084fc;}.intro-panel-calidad{border-left-color:#c084fc;}\n'
    +'.intro-timelapse .intro-kicker{color:#0ea5e9;}.intro-panel-timelapse{border-left-color:#0ea5e9;}\n'
    +'.intro-generic_premium .intro-kicker{color:#8b5cf6;}.intro-panel-generic_premium{border-left-color:#6366f1;}\n'
    // Responsive (intro)
    +'@media(max-width:480px){.premium-intro{padding:18px 14px;}.intro-title{font-size:22px;}.intro-grid{gap:7px;}.intro-metric{padding:8px 5px;}.intro-metric-val{font-size:17px;}}\n'
    // ── FASE 7B: TRANSICIÓN Y CIERRE PREMIUM ──
    +'/* ── TRANSITION & RESULT ── */\n'
    +'.transition-card{display:flex;flex-direction:column;align-items:center;max-width:420px;width:100%;padding:28px 20px;text-align:center;box-sizing:border-box;}\n'
    +'.result-card{display:flex;flex-direction:column;align-items:center;max-width:420px;width:100%;padding:28px 20px;text-align:center;box-sizing:border-box;}\n'
    +'.mission-status{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:var(--accent);margin:0 0 16px;opacity:.9;font-family:system-ui,-apple-system,sans-serif;border:1px solid rgba(255,255,255,.12);border-left:3px solid var(--accent);border-radius:0 8px 8px 0;padding:5px 12px;}\n'
    +'.transition-title{font-size:21px;font-weight:900;margin:8px 0 8px;line-height:1.2;}\n'
    +'.transition-text{font-size:14px;opacity:.72;margin:0 0 18px;line-height:1.55;font-family:system-ui,-apple-system,sans-serif;max-width:320px;}\n'
    +'.result-verdict{font-size:15px;font-weight:700;color:var(--accent);margin:0 0 6px;font-family:system-ui,-apple-system,sans-serif;letter-spacing:.3px;}\n'
    +'.next-room-label{font-size:10px;text-transform:uppercase;letter-spacing:1.4px;opacity:.48;margin:0 0 20px;font-family:system-ui,-apple-system,sans-serif;}\n'
    +'@media(max-width:480px){.transition-card,.result-card{padding:20px 14px;}.transition-title{font-size:18px;}}\n'
    // ── LEGIBILITY OVERRIDE: educational content always readable regardless of STHEME font ──
    // h1 / game badges keep the decorative theme font; questions + options + feedback do not.
    +'/* ── LEGIBILITY ── */\n'
    +'.btn-op,.game-area p,.mission-brief .mb-intro,.screen li{'
      +'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;'
      +'line-height:1.5!important;}\n'
    +'.game-area p{font-size:18px!important;}\n'
    +'.btn-op{font-size:16px!important;color:var(--btnt)!important;}\n'
    +'.btn-op *{color:inherit!important;}\n'
    // ── CONTRAST SAFETY NET ──
    // Reset browser UA button color so all <button> elements inherit from the themed body
    // (body color is always light: var(--text)). Inline style="color:..." on individual
    // buttons (Kahoot, V/F, etc.) still overrides this correctly without !important here.
    // .btn-op gets its own explicit color:var(--btnt)!important above for extra safety.
    +'button{color:inherit;}\n'
    +'button *{color:inherit;}\n'
    +'.mission-brief .mb-intro{font-size:14px!important;line-height:1.6!important;}\n'
    // ── FAMILY CSS: scoped theming injected from NFAMILIES.familyCss ──
    +(familyCssStr?familyCssStr+'\n':'')
    +'<\/style>\n<\/head>\n<body class="'+familyCls+'">\n';
  h+='<div class="hud"><span class="hud-title">'+xe(capTitle)+'</span>'
    +'<span id="hud-hearts">\u2764\uFE0F\u2764\uFE0F\u2764\uFE0F</span>'
    +'<span id="hud-streak" style="color:var(--accent);font-weight:900;min-width:52px;text-align:center;font-size:14px;"></span>'
    +'<span id="hud-score">0 pts</span></div>\n';
  h+='<div id="toast"></div>\n';
  var sc=data.scenario||{};
  h+=buildFamilyIntro(item.pack,xe,gameName,tagline,emoji,capTitle,sc,numSalas,maxPts);
  for(var si=1;si<=numSalas;si++){
    h+='<div id="sala'+si+'" class="screen"><div class="gwrap"><div class="game-area" id="area'+si+'"></div></div></div>\n';
  }
  for(var si=1;si<=numSalas;si++){
    var nextAct=si<numSalas?'showScreen(\'sala'+(si+1)+'\');startSala('+(si+1)+')':'endGame()';
    h+='<div id="between'+si+'" class="screen" style="justify-content:center;">\n'
      +'<div class="transition-card">'
      +'<p class="mission-status">'+xe(xcopy.tt)+'</p>'
      +'<div id="bstars'+si+'" style="font-size:52px;margin-bottom:10px;">\u2B50\u2B50\u2B50</div>'
      +'<h2 class="transition-title">'+xe(salaNames[si-1])+'</h2>'
      +'<p class="transition-text">'+xe(xcopy.tx)+'</p>'
      +'<p style="font-size:26px;font-weight:800;color:var(--accent);margin:0 0 6px;"><span id="bpts'+si+'"></span></p>'
      +(si<numSalas
        ?'<p class="next-room-label">Siguiente\u00A0\u2192\u00A0'+xe(salaNames[si])+'</p>'
        :'<p class="next-room-label">Ver resultados finales</p>')
      +'<button class="btn-primary" onclick="'+nextAct+'">'+xe(xcopy.tc)+'</button>'
      +'</div>\n</div>\n';
  }
  h+='<div id="result" class="screen" style="justify-content:center;">\n'
    +'<div class="result-card">'
    +'<h2 id="result-title" style="font-size:48px;margin:0 0 4px;"></h2>'
    +'<p id="result-verdict" class="result-verdict"></p>'
    +'<p id="result-feedback" style="font-size:14px;font-weight:600;margin:0 0 12px;line-height:1.5;font-family:system-ui,-apple-system,sans-serif;"></p>'
    +'<div style="background:var(--btn);border:1px solid var(--btnb);padding:16px;border-radius:12px;margin-bottom:20px;width:100%;">'
    +'<p id="result-stats" style="margin:0;font-size:13px;color:var(--t2);line-height:1.7;font-family:system-ui,-apple-system,sans-serif;"></p>'
    +'</div>'
    +'<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;width:100%;">'
    +'<button class="btn-primary" onclick="resetGame()" style="flex:1;min-width:130px;max-width:200px;">'+xe(xcopy.fc)+'</button>'
    +'<button class="btn-primary" onclick="window.top.location.href=document.referrer||\'//\'" style="flex:1;min-width:130px;max-width:180px;">\u2190 Volver</button>'
    +'</div>'
    +'</div>\n</div>\n';
  var ENGINE=''
    +'var G={score:0,lives:3,idx:0,correct:0,wrong:0,currentOpts:[],maxPts:'+maxPts+',sala:1,streak:0,maxStreak:0,salaCorrect:0};var done=false;\n'
    // ── _qValid: defensive question validator — returns true if question has minimum viable data ──
    +'function _qValid(q,mecName){\n'
    +'  if(!q||typeof q!=="object")return false;\n'
    +'  var isSeq=mecName==="Secuencia de Proceso";var isSeqPro=mecName==="Secuencia de Proceso Pro";\n'
    +'  var isCkl=mecName==="Checklist Crítico";var isEH=mecName==="Error Hunter";\n'
    +'  if(isSeqPro)return Array.isArray(q.steps)&&q.steps.length>=2;\n'
    +'  if(isSeq)return Array.isArray(q.steps)&&q.steps.length>=2;\n'
    +'  if(isCkl)return Array.isArray(q.items)&&q.items.length>=2;\n'
    +'  if(isEH)return typeof q.context==="string"&&q.context.length>=5&&Array.isArray(q.errorSpans)&&q.errorSpans.length>=2&&q.correct;\n'
    +'  var opts=q.opts||[];return opts.length>=2&&q.correct;\n'
    +'}\n'
    +'function hideToastNow(){try{document.getElementById("toast").style.display="none";}catch(e){}}\n'
    +'function showScreen(id){try{document.querySelectorAll(".screen").forEach(function(s){s.classList.remove("active");s.scrollTop=0;});var el=document.getElementById(id);if(el){el.classList.add("active");el.scrollTop=0;}window.scrollTo(0,0);hideToastNow();}catch(e){}}\n'
    +'function shuffle(a){for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=a[i];a[i]=a[j];a[j]=t;}return a;}\n'
    // ── _eqOpts: iguala la altura de las opciones renderizadas — cubre mecánicas
    // de lista vertical sin wrapper flex/grid, que el CSS de arriba no alcanza.
    +'function _eqOpts(n){try{var ar=document.getElementById("area"+n);if(!ar)return;var btns=ar.querySelectorAll(".btn-op");if(!btns.length)return;var mh=0;for(var i=0;i<btns.length;i++){btns[i].style.minHeight="";var h=btns[i].offsetHeight;if(h>mh)mh=h;}for(var i=0;i<btns.length;i++){btns[i].style.minHeight=mh+"px";}}catch(e){}}\n'
    +'function updateHUD(){try{document.getElementById("hud-score").textContent=G.score+" pts";var h="";for(var i=0;i<3;i++)h+=i<G.lives?"\u2764\uFE0F":"\uD83D\uDDA4";document.getElementById("hud-hearts").innerHTML=h;var st=document.getElementById("hud-streak");if(st)st.textContent=G.streak>=3?"\uD83D\uDD25\u00D7"+G.streak:"";}catch(e){}}\n'
    +'function showToast(msg,ok){try{var e=document.getElementById("toast");if(G._tt)clearTimeout(G._tt);e.textContent=msg;e.style.background=ok?"#22c55e":"#ef4444";e.style.display="block";G._tt=setTimeout(function(){e.style.display="none";},2200);}catch(e){}}\n'
    +'function startSala(n){try{if(done)return;G.sala=n;G.idx=0;G.lives=3;G.salaCorrect=0;updateHUD();hideToastNow();var pqs=PREGUNTAS["sala"+n];if(!pqs||!pqs.length){if(G.correct>0){endGame();return;}var ar=document.getElementById("area"+n);if(ar)ar.innerHTML=\'<div style="text-align:center;padding:40px;font-size:16px;opacity:.7;">\u26a0\ufe0f Sin preguntas. Recarga y regenera.</div>\';return;}var _q0=pqs[0];if(_q0&&!_q0.opts&&!_q0.steps&&!_q0.items&&!_q0.errorSpans&&!_q0.correct&&!_q0.context){console.warn("[startSala] sala"+n+" q0 missing all data fields — check AI output");};renderArea(n);_eqOpts(n);(function(){var _a=document.getElementById("area"+n);if(_a){_a.style.animation="none";void _a.offsetWidth;_a.style.animation="qi .2s ease-out both";}})();}catch(e){console.error("startSala",e);}}\n'
    // ── _skipBadQ: skips current question if data is malformed, moves to next or completeSala ──
    +'function _skipBadQ(n){try{G.idx++;if(G.idx>=PREGUNTAS["sala"+n].length){completeSala(n);}else{renderArea(n);_eqOpts(n);}}catch(e){}}\n'
    +'function checkSala(n,i){try{var q=PREGUNTAS["sala"+n][G.idx];if(!q||!q.correct){_skipBadQ(n);return;}var area=document.getElementById("area"+n);var isOk=G.currentOpts[i]===q.correct;if(isOk){G.score+=10;G.correct++;G.salaCorrect++;G.streak++;G.maxStreak=Math.max(G.maxStreak,G.streak);var bonus=G.streak>=3?G.streak*2:0;if(bonus)G.score+=bonus;var msg="\u2705 "+(q.fb||"Correcto!");if(G.streak>=5)msg="\uD83D\uDD25 \u00D7"+G.streak+" COMBO! (+"+bonus+" extra) \u2014 "+(q.fb||"");else if(G.streak===4)msg="\u26A1 RACHA \u00D74! "+(q.fb||"");else if(G.streak===3)msg="\uD83C\uDF1F COMBO \u00D73 "+(q.fb||"");showToast(msg,true);if(area){area.style.transition="box-shadow .15s ease";area.style.boxShadow="0 0 0 3px rgba(34,197,94,.8),0 0 40px rgba(34,197,94,.3)";}}else{G.lives--;G.wrong++;G.streak=0;showToast("\u274C "+q.correct,false);if(area){area.style.transition="box-shadow .15s ease,transform .08s ease";area.style.boxShadow="0 0 0 3px rgba(239,68,68,.8),0 0 40px rgba(239,68,68,.3)";}if(G.lives<=0){gameOver();return;}}updateHUD();setTimeout(function(){if(done)return;if(area){area.style.boxShadow="";area.style.transform="";}G.idx++;if(G.idx>=PREGUNTAS["sala"+n].length){completeSala(n);return;}renderArea(n);_eqOpts(n);(function(){var _a=document.getElementById("area"+n);if(_a){_a.style.animation="none";void _a.offsetWidth;_a.style.animation="qi .2s ease-out both";}})();},390);}catch(e){console.error("checkSala",e);}}\n'
    +'function completeSala(n){try{hideToastNow();showScreen("between"+n);var el=document.getElementById("bpts"+n);if(el)el.textContent=G.score+" pts";var tot=(PREGUNTAS["sala"+n]||[]).length;var pct=tot>0?Math.round(G.salaCorrect/tot*100):0;var stars=pct>=90?"\u2B50\u2B50\u2B50":pct>=60?"\u2B50\u2B50\u2B50":pct>=30?"\u2B50\u2B50":"\u2B50";var stEl=document.getElementById("bstars"+n);if(stEl)stEl.textContent=stars;}catch(e){}}\n'
    +'function _feedback(pct){if(pct>=100)return"\uD83C\uDFC6 \u00A1Perfecto! Dominas completamente este cap\u00EDtulo. \u00A1Felicitaciones!";if(pct>=90)return"\uD83C\uDFAF \u00A1Excelente resultado! Est\u00E1s muy cerca de la perfecci\u00F3n. \u00A1Un esfuerzo m\u00E1s!";if(pct>=70)return"\uD83C\uDF1F \u00A1Muy bien! Demuestras buen dominio del tema. \u00A1Sigue practicando!";if(pct>=50)return"\uD83C\uDF31 \u00A1Vas por buen camino! Con un poco m\u00E1s de repaso lo dominar\u00E1s.";if(pct>0)return"\uD83D\uDCAA \u00A1Sigue adelante! Revisa el material del cap\u00EDtulo y vuelve a intentarlo.";return"\uD83D\uDE14 \u00A1No te rindas! Repasa el contenido y vuelve a intentarlo. \u00A1T\u00FA puedes!";}\n'
    +'function _setFeedback(txt){try{var el=document.getElementById("result-feedback");if(el)el.textContent=txt;}catch(e){}}\n'
    +'function gameOver(){try{done=true;hideToastNow();showScreen("result");document.getElementById("result-title").textContent="\uD83D\uDC94 Sin vidas";document.getElementById("result-stats").innerHTML="Correctas: "+G.correct+" &bull; Fallidas: "+G.wrong;_setFeedback(_feedback(0));try{var _rv=document.getElementById("result-verdict");if(_rv)_rv.textContent=XCOPY.rf||"";}catch(_x){}scSet("cmi.core.lesson_status","failed");}catch(e){}}\n'
    +'function endGame(){try{done=true;var pct=Math.min(100,Math.round(G.score/G.maxPts*100));var em=pct>=100?"\uD83C\uDFC6":pct>=90?"\uD83C\uDFAF":pct>=70?"\uD83C\uDF1F":pct>=50?"\uD83C\uDF31":"\uD83D\uDCDA";hideToastNow();showScreen("result");document.getElementById("result-title").textContent=em+" "+pct+"%";document.getElementById("result-stats").innerHTML="Correctas: "+G.correct+" &bull; Fallidas: "+G.wrong+" &bull; "+G.score+" pts"+(G.maxStreak>=3?" \u00B7 Racha m\u00E1x: "+G.maxStreak+"\uD83D\uDD25":"");_setFeedback(_feedback(pct));try{var _rv=document.getElementById("result-verdict");if(_rv)_rv.textContent=pct>=70?XCOPY.rp:XCOPY.rf;}catch(_x){}scSet("cmi.core.score.raw",pct);scSet("cmi.core.lesson_status",pct>=70?"passed":"failed");try{_scAPI.LMSCommit("");_scAPI.LMSFinish("");}catch(x){}}catch(e){}}\n'
    +'function resetGame(){try{done=false;G={score:0,lives:3,idx:0,correct:0,wrong:0,currentOpts:[],maxPts:'+maxPts+',sala:1,streak:0,maxStreak:0,salaCorrect:0};updateHUD();showScreen("screen-intro");}catch(e){}}\n'
    +'function _nextQ(n){try{if(done)return;G.idx++;if(G.idx>=PREGUNTAS["sala"+n].length){completeSala(n);}else{renderArea(n);}}catch(e){}}\n'
    +'function checkSeq(n,i){try{if(done)return;var q=PREGUNTAS["sala"+n][G.idx];var steps=q.steps||[];if(!G._seqSel)G._seqSel=[];var step=G.currentOpts[i];G._seqSel.push(step);var pos=G._seqSel.length;var btn=document.getElementById("seqb_"+n+"_"+i);var nm=document.getElementById("seqn_"+n+"_"+i);if(btn){btn.disabled=true;btn.style.opacity=".45";}if(nm){nm.textContent=pos;nm.style.background="var(--accent)";nm.style.color="#000";}if(G._seqSel.length<steps.length)return;var ok=true;for(var k=0;k<steps.length;k++){if(G._seqSel[k]!==steps[k]){ok=false;break;}}G._seqSel=[];if(ok){G.score+=10;G.correct++;showToast("✅ "+(q.fb||"Orden correcto!"),true);}else{G.lives--;G.wrong++;showToast("❌ Orden: "+steps[0]+" → "+steps[1]+"...",false);if(G.lives<=0){gameOver();return;}}updateHUD();G.idx++;if(G.idx>=PREGUNTAS["sala"+n].length){completeSala(n);return;}renderArea(n);}catch(e){console.error("checkSeq",e);}}\n'
    +'function _showConsequence(cons,correct,hasLives,next){try{var ov=document.getElementById("_cons_ov");if(!ov){ov=document.createElement("div");ov.id="_cons_ov";ov.style.cssText="position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px;";document.body.appendChild(ov);}ov.style.display="flex";ov.innerHTML="";function mk(tag,css,txt){var el=document.createElement(tag);if(css)el.style.cssText=css;if(txt!==undefined)el.textContent=txt;return el;}var bx=document.createElement("div");bx.style.cssText="background:var(--bg);border:2px solid rgba(239,68,68,.5);border-radius:16px;padding:24px;max-width:360px;width:100%;text-align:center;";bx.appendChild(mk("p","font-size:30px;margin:0 0 8px;","⚠️"));bx.appendChild(mk("p","font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;opacity:.6;margin:0 0 8px;","CONSECUENCIA"));bx.appendChild(mk("p","font-size:14px;line-height:1.5;margin:0 0 12px;",cons));bx.appendChild(mk("p","font-size:12px;opacity:.6;margin:0 0 16px;","Correcta: "+correct));var btn=mk("button","background:var(--accent);color:#000;border:none;padding:10px 24px;border-radius:10px;cursor:pointer;font-weight:700;font-size:14px;font-family:inherit;",hasLives?"Continuar →":"Ver resultado");btn.onclick=function(){ov.style.display="none";next();};bx.appendChild(btn);ov.appendChild(bx);}catch(e){}}\n'
    +'function checkTurno(n,i){try{if(done)return;var q=PREGUNTAS["sala"+n][G.idx];var ok=G.currentOpts[i]===q.correct;if(ok){G.score+=10;G.correct++;showToast("✅ "+(q.fb||"Decisión correcta!"),true);updateHUD();G.idx++;if(G.idx>=PREGUNTAS["sala"+n].length){completeSala(n);return;}renderArea(n);}else{G.lives--;G.wrong++;updateHUD();var cons=q.consequence||("Decisión incorrecta");var corr=q.correct;var lv=G.lives;_showConsequence(cons,corr,lv>0,function(){if(lv<=0){gameOver();return;}_nextQ(n);});}}catch(e){console.error("checkTurno",e);}}\nfunction tapCard(n,i){var fc=document.getElementById("fc_"+n+"_"+i);if(!fc||fc.classList.contains("flipped"))return;fc.classList.add("flipped");setTimeout(function(){checkSala(n,i);},600);}\n'
    // ── CHECKLIST CRÍTICO ENGINE (Fase M2) ──────────────────────────────────
    // _cklToggle: visual toggle para cards del checklist (sin modificar checkSala/checkSeq/checkTurno)
    // checkChecklist: evaluador aislado — correcto si todos los required:true están marcados
    +'function _cklToggle(n,k){try{if(!G._cklSel)G._cklSel=[];G._cklSel[k]=!G._cklSel[k];var card=document.getElementById(\'ckcard_\'+n+\'_\'+k);var dot=document.getElementById(\'ckdot_\'+n+\'_\'+k);if(card){card.style.borderColor=G._cklSel[k]?\'var(--accent)\':\'\';card.style.background=G._cklSel[k]?\'rgba(255,255,255,.09)\':\'\'}if(dot){dot.textContent=G._cklSel[k]?\'✓\':\'\';dot.style.background=G._cklSel[k]?\'var(--accent)\':\'\';dot.style.borderColor=G._cklSel[k]?\'var(--accent)\':\'\';dot.style.color=\'#000\';}}catch(e){}}\n'
    +'function checkChecklist(n){try{var q=PREGUNTAS[\'sala\'+n][G.idx];var items=q.items||[];var reqIdxs=[];items.forEach(function(it,k){if(it.required)reqIdxs.push(k);});var sel=G._cklSel||[];var allReqOk=reqIdxs.length>0&&reqIdxs.every(function(idx){return!!sel[idx];});items.forEach(function(it,k){var card=document.getElementById(\'ckcard_\'+n+\'_\'+k);if(!card)return;var isSel=!!sel[k];if(it.required&&isSel){card.style.borderColor=\'rgba(34,197,94,.8)\';card.style.background=\'rgba(34,197,94,.15)\';}else if(it.required&&!isSel){card.style.borderColor=\'rgba(239,68,68,.8)\';card.style.background=\'rgba(239,68,68,.12)\';}else if(!it.required&&isSel){card.style.borderColor=\'rgba(239,68,68,.6)\';card.style.background=\'rgba(239,68,68,.08)\';}else{card.style.opacity=\'.5\';}});var vbtn=document.getElementById(\'ckbtn_\'+n);if(vbtn){vbtn.disabled=true;vbtn.style.opacity=\'.5\';}if(allReqOk){G.score+=10;G.correct++;G.salaCorrect++;G.streak++;G.maxStreak=Math.max(G.maxStreak,G.streak);showToast(\'✅ \'+(q.fb||\'¡Protocolo verificado correctamente!\'),true);}else{G.lives--;G.wrong++;G.streak=0;showToast(\'❌ \'+(q.fb||\'Marca todos los pasos críticos obligatorios.\'),false);if(G.lives<=0){gameOver();return;}}updateHUD();setTimeout(function(){if(done)return;G.idx++;if(G.idx>=PREGUNTAS[\'sala\'+n].length){completeSala(n);return;}renderArea(n);},1800);}catch(e){console.error(\'checkChecklist\',e);}}\n'
    // ── ERROR HUNTER ENGINE (Fase M3) ────────────────────────────────────────
    // checkErrorHunter: evaluador aislado — sin tocar checkSala/checkSeq/checkTurno
    // Feedback visual inmediato en el chip seleccionado + muestra el correcto si falla
    +'function checkErrorHunter(n,id){try{if(G._ehDone)return;G._ehDone=true;var q=PREGUNTAS[\'sala\'+n][G.idx];var spans=q.errorSpans||[];var isOk=id===q.correct;var allBtns=[];spans.forEach(function(sp){var btn=document.getElementById(\'ehchip_\'+n+\'_\'+sp.id);if(btn){allBtns.push(btn);btn.style.pointerEvents=\'none\';}});var selBtn=document.getElementById(\'ehchip_\'+n+\'_\'+id);if(selBtn){if(isOk){selBtn.style.borderColor=\'rgba(34,197,94,.9)\';selBtn.style.background=\'rgba(34,197,94,.18)\';selBtn.style.color=\'#4ade80\';}else{selBtn.style.borderColor=\'rgba(239,68,68,.9)\';selBtn.style.background=\'rgba(239,68,68,.15)\';selBtn.style.color=\'#f87171\';}}if(!isOk&&q.correct){var corrBtn=document.getElementById(\'ehchip_\'+n+\'_\'+q.correct);if(corrBtn){corrBtn.style.borderColor=\'rgba(34,197,94,.9)\';corrBtn.style.background=\'rgba(34,197,94,.12)\';corrBtn.style.opacity=\'1\';}}if(isOk){G.score+=10;G.correct++;G.salaCorrect++;G.streak++;G.maxStreak=Math.max(G.maxStreak,G.streak);showToast(\'✅ \'+(q.fb||\'¡Error detectado correctamente!\'),true);}else{G.lives--;G.wrong++;G.streak=0;showToast(\'❌ \'+(q.fb||\'Ese fragmento no contiene el error principal.\'),false);if(G.lives<=0){gameOver();return;}}updateHUD();setTimeout(function(){if(done)return;G.idx++;if(G.idx>=PREGUNTAS[\'sala\'+n].length){completeSala(n);return;}renderArea(n);},2000);}catch(e){console.error(\'checkErrorHunter\',e);}}\n'
    // ── SECUENCIA DE PROCESO PRO ENGINE (Fase M4) ────────────────────────────
    // _seqProCards: genera HTML de las cards desde G._seqOrder[n] + G._seqSteps[n]
    // _seqProRender: actualiza el div#spcontainer_N sin reemplazar toda el área
    // _seqMove: sube/baja una card; bloqueado después de validar
    // checkSeqPro: evaluador aislado — no toca checkSala/checkSeq/checkTurno
    +'function _seqProCards(n){try{var order=G._seqOrder&&G._seqOrder[n]?G._seqOrder[n]:[];var steps=G._seqSteps&&G._seqSteps[n]?G._seqSteps[n]:[];var map={};steps.forEach(function(s){map[s.id]=s;});var total=order.length;var html=\'\';var locked=!!(G._seqDone&&G._seqDone[n]);order.forEach(function(sid,k){var s=map[sid]||{id:sid,label:sid,order:k+1};var isFirst=k===0;var isLast=k===total-1;var upDis=isFirst||locked;var dnDis=isLast||locked;html+=\'<div id="spcard_\'+n+\'_\'+k+\'" style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:10px;border:1.5px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);transition:border-color .2s,background .2s;">\'  +\'<span style="min-width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;flex-shrink:0;font-family:system-ui,-apple-system,sans-serif;">\'+(k+1)+\'</span>\'  +\'<span style="flex:1;font-size:15px;font-weight:600;line-height:1.45;font-family:system-ui,-apple-system,sans-serif;text-align:left;">\'+(s.label||\'—\')+\'</span>\'  +\'<div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">\'  +\'<button onclick="_seqMove(\'+n+\',\'+k+\',-1)" \'+( upDis?\'disabled \':\'\' )+\'style="min-width:36px;min-height:36px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.07);color:var(--text);cursor:\'+( upDis?\'default\':\'pointer\')+\';font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;opacity:\'+( upDis?\'.3\':\'1\')+\';font-family:system-ui,-apple-system,sans-serif;transition:background .12s;" aria-label="Subir">↑</button>\'  +\'<button onclick="_seqMove(\'+n+\',\'+k+\',1)" \'+( dnDis?\'disabled \':\'\' )+\'style="min-width:36px;min-height:36px;border-radius:7px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.07);color:var(--text);cursor:\'+( dnDis?\'default\':\'pointer\')+\';font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;opacity:\'+( dnDis?\'.3\':\'1\')+\';font-family:system-ui,-apple-system,sans-serif;transition:background .12s;" aria-label="Bajar">↓</button>\'  +\'</div></div>\';});return html;}catch(e){return\'\';}}\n'
    +'function _seqProRender(n){try{var c=document.getElementById(\'spcontainer_\'+n);if(c)c.innerHTML=_seqProCards(n);}catch(e){}}\n'
    +'function _seqMove(n,idx,dir){try{if(G._seqDone&&G._seqDone[n])return;if(!G._seqOrder||!G._seqOrder[n])return;var order=G._seqOrder[n];var target=idx+dir;if(target<0||target>=order.length)return;var tmp=order[idx];order[idx]=order[target];order[target]=tmp;_seqProRender(n);}catch(e){}}\n'
    +'function checkSeqPro(n){try{if(G._seqDone&&G._seqDone[n])return;if(!G._seqDone)G._seqDone={};G._seqDone[n]=true;var q=PREGUNTAS[\'sala\'+n][G.idx];var steps=G._seqSteps&&G._seqSteps[n]?G._seqSteps[n]:[];var order=G._seqOrder&&G._seqOrder[n]?G._seqOrder[n]:[];var correct=steps.slice().sort(function(a,b){return a.order-b.order;}).map(function(s){return s.id;});var tol=(q.tolerance!=null)?Number(q.tolerance):0;var wrongs=0;for(var k=0;k<order.length;k++){if(order[k]!==correct[k])wrongs++;}var isOk=wrongs<=tol;_seqProRender(n);order.forEach(function(sid,k){var card=document.getElementById(\'spcard_\'+n+\'_\'+k);if(!card)return;if(order[k]===correct[k]){card.style.borderColor=\'rgba(34,197,94,.85)\';card.style.background=\'rgba(34,197,94,.14)\';}else{card.style.borderColor=\'rgba(239,68,68,.85)\';card.style.background=\'rgba(239,68,68,.13)\';}});var vbtn=document.getElementById(\'seqpro_btn_\'+n);if(vbtn){vbtn.disabled=true;vbtn.style.opacity=\'.5\';}if(isOk){G.score+=10;G.correct++;G.salaCorrect++;G.streak++;G.maxStreak=Math.max(G.maxStreak,G.streak);showToast(\'✅ \'+(q.fb||\'¡Secuencia correcta! Procedimiento dominado.\'),true);}else{G.lives--;G.wrong++;G.streak=0;showToast(\'❌ \'+(q.fb||\'Orden incorrecto. Revisa el procedimiento correcto.\'),false);if(G.lives<=0){gameOver();return;}}updateHUD();setTimeout(function(){if(done)return;G.idx++;if(G.idx>=PREGUNTAS[\'sala\'+n].length){completeSala(n);return;}renderArea(n);},2200);}catch(e){console.error(\'checkSeqPro\',e);}}\n'
    +'for(var _n=1;_n<='+numSalas+';_n++){(function(n){window["startSala"+n]=function(){startSala(n);};window["checkSala"+n]=function(i){checkSala(n,i);};}(_n));}\n'
    +'var _scAPI=null;\n'
    +'function _findAPI(w){try{if(w.API)return w.API;if(w.parent&&w.parent!=w)return _findAPI(w.parent);return null;}catch(e){return null;}}\n'
    +'function scSet(k,v){try{if(_scAPI){_scAPI.LMSSetValue(k,String(v));_scAPI.LMSCommit("");}}catch(e){}}\n'
    +'window.onload=function(){try{_scAPI=_findAPI(window);if(_scAPI)_scAPI.LMSInitialize("");}catch(e){}updateHUD();};\n';
  h+='<script>\n'+pregJs+ENGINE+renderFn+'\n<\/script>\n<\/body><\/html>';
  return h;
}


// ── MECHANIC SELECTOR — assigns best mechanic based on chapter content ──
// Solo usa mecánicas activas (no deprecated). buildScormHtml() sigue aceptando
// cualquier índice para compatibilidad con SCORMs ya generados.
function mecForCap(cap){
  var t=((cap.t||'')+' '+(cap.mn||'')).toLowerCase();
  var preferred=null;
  // Error detection/analysis chapters → Error Hunter (evaluated first — highest specificity)
  if(/error|falla|fallo|problema|incorrecto|detectar|identificar|revisi[oó]n cr[ií]tica|no conformidad|vulnerabilidad|c[aá]lculo err[oó]neo|despeje|prescripci[oó]n|contraindicaci[oó]n|cl[aá]usula incorrecta|configuraci[oó]n incorrecta|mal configurad|encontrar el error|encontrar la falla|encontrar el problema/.test(t))
    preferred=['Error Hunter','Inspector de Planta','Diagnóstico Sectorial'];
  // Checklist/verification chapters → Checklist Crítico (evaluated second for precision)
  else if(/verificaci[oó]n|checklist|lista de chequeo|protocolo|cumplimiento|administraci[oó]n de|control de|revisi[oó]n de|previo al|validaci[oó]n de|antes de|requisito|auditor[ií]a/.test(t))
    preferred=['Checklist Crítico','Inspector de Planta','Secuencia de Proceso'];
  // Process/sequence/procedure chapters → Secuencia de Proceso Pro (preferred) + old as fallback
  else if(/procedimiento|proceso|etapa|paso|secuencia|orden de|operaci[oó]n|mantenimiento|instalaci[oó]n|calibra|montaje|flujo|ciclo|protocolo de|ruta de|algoritmo|preparaci[oó]n|configuraci[oó]n paso|c[oó]mo se|resoluci[oó]n paso|despeje de/.test(t))
    preferred=['Secuencia de Proceso Pro','Checklist Crítico','Secuencia de Proceso','Simulador de Decisiones'];
  // Diagnostic/safety → Inspector
  else if(/diagn[oó]stico|falla|anomal|inspecci[oó]n|hseq|seguridad|riesgo|peligro|accidente/.test(t))
    preferred=['Inspector de Planta','Diagnóstico Sectorial','Cartas Ocultas'];
  // Decision/emergency → Turno
  else if(/decisi[oó]n|emergencia|turno|guardia|incidente|crisis|respuesta|alerta/.test(t))
    preferred=['Turno de Operario','Simulador de Decisiones','Caso de Estudio'];
  // Concepts/definitions → conceptual mechanics
  else if(/concepto|definici[oó]n|vocabulario|t[eé]rmino|clasificaci[oó]n|identifica/.test(t))
    preferred=['Cartas Ocultas','Match de Tarjetas','Galería de Conceptos','Cronología Interactiva','Conectar Flechas'];
  // Narrative/story chapters → Escape room
  else if(/historia|contexto|antecedente|origen|introducci[oó]n|fundamento|marco|normativa|regulaci[oó]n|legislaci[oó]n/.test(t))
    preferred=['Sala de Escape','Caso de Estudio','Diagnóstico Sectorial'];
  // Data/measurement/technical → direct KPI mechanics (Francotirador deprecated)
  else if(/datos|medici[oó]n|c[aá]lculo|f[oó]rmula|variable|instrumento|sensor|indicador|gr[aá]fica/.test(t))
    preferred=['Inspector de Planta','Speed Round','Kahoot Relámpago'];
  if(preferred){
    // Pass A: preferred list, not deprecated, not used yet, not consecutive
    for(var k=0;k<preferred.length;k++){
      var m=MECS.filter(function(x){return x.name===preferred[k]&&!x.deprecated;})[0];
      if(m&&uMec.indexOf(m)<0&&(uMec.length===0||uMec[uMec.length-1]!==m)){uMec.push(m);return m;}
    }
    // Pass B: preferred list, not deprecated, not consecutive (allow reuse)
    for(var k=0;k<preferred.length;k++){
      var m=MECS.filter(function(x){return x.name===preferred[k]&&!x.deprecated;})[0];
      if(m&&(uMec.length===0||uMec[uMec.length-1]!==m)){uMec.push(m);return m;}
    }
    // Pass C: preferred list, not deprecated (allow consecutive only as last resort)
    var fb=MECS.filter(function(x){return x.name===preferred[0]&&!x.deprecated;})[0];
    if(fb){uMec.push(fb);return fb;}
  }
  // Fallback aleatorio: solo mecánicas activas, no consecutivas si hay alternativas
  var activeMecs=getActiveMecs();
  var lastMec=uMec.length>0?uMec[uMec.length-1]:null;
  var nonConsec=activeMecs.filter(function(m){return m!==lastMec;});
  if(nonConsec.length>0)return pick(nonConsec,uMec);
  return pick(activeMecs,uMec);
}

// ── PACK MECHANIC SELECTOR — picks best mechanic from pack.mecNames ──
// Salta mecánicas deprecated aunque estén en el pack.mecNames.
// Falls back to mecForCap() if all pack mechanics have been used or are deprecated.
function mecFromPack(pack,cap){
  if(pack&&pack.mecNames&&pack.mecNames.length){
    var lastMec=uMec.length>0?uMec[uMec.length-1]:null;
    // Primera pasada: mecánica activa no usada aún y no consecutiva
    for(var k=0;k<pack.mecNames.length;k++){
      var m=MECS.filter(function(x){return x.name===pack.mecNames[k]&&!x.deprecated;})[0];
      if(m&&uMec.indexOf(m)<0&&m!==lastMec){uMec.push(m);return m;}
    }
    // Segunda pasada: mecánica activa no usada aún (ignora anti-consecutive)
    for(var k=0;k<pack.mecNames.length;k++){
      var m=MECS.filter(function(x){return x.name===pack.mecNames[k]&&!x.deprecated;})[0];
      if(m&&uMec.indexOf(m)<0){uMec.push(m);return m;}
    }
    // Tercera pasada: cualquier activa del pack no consecutiva (permite reuso)
    for(var k=0;k<pack.mecNames.length;k++){
      var m=MECS.filter(function(x){return x.name===pack.mecNames[k]&&!x.deprecated;})[0];
      if(m&&m!==lastMec){uMec.push(m);return m;}
    }
    // Todas usadas y todas consecutivas → reusar la primera activa del pack
    var fb=MECS.filter(function(x){return pack.mecNames.indexOf(x.name)>=0&&!x.deprecated;})[0];
    if(fb){uMec.push(fb);return fb;}
  }
  return mecForCap(cap);
}

// ── ADAPTIVE EXPERIENCE SELECTOR — Fase 3 ────────────────────────────────────
// resolveSectorIds: looks up SECTOR_MAP by exact key, then tries partial match.
// Returns array of family IDs (may be empty).
function resolveSectorIds(sectorNorm){
  if(!sectorNorm)return[];
  if(SECTOR_MAP[sectorNorm])return SECTOR_MAP[sectorNorm];
  // Partial match: sector string contains a key or a key contains sector string
  var keys=Object.keys(SECTOR_MAP);
  for(var i=0;i<keys.length;i++){
    if(sectorNorm.indexOf(keys[i])>=0||keys[i].indexOf(sectorNorm)>=0)
      return SECTOR_MAP[keys[i]];
  }
  return[];
}

// resolveSector: normalizes raw sector string and returns matching family objects.
// When sector is unknown, returns premium fallback pool (never empty/poor).
function resolveSector(sectorStr){
  var norm=normalizeText(sectorStr||'');
  var ids=resolveSectorIds(norm);
  if(ids.length===0){
    // Premium fallback pool — visually diverse, all have CSS + premium intro
    ids=['generic_premium','detective','timelapse','arcade_universal','mercado','calidad'];
  }
  return ids.map(function(id){
    return NFAMILIES.filter(function(f){return f.id===id;})[0];
  }).filter(Boolean);
}

// scoreFamily: multi-signal scorer for a single family against current chapter context.
// Returns numeric score (higher = better fit).
// Fase 7A: stronger diversity penalties to guarantee ≥5 unique families per 9-cap course.
function scoreFamily(family,Dctx,cap){
  var score=0;
  var tNorm=normalizeText((cap.t||'')+' '+(cap.mn||''));
  var cNorm=normalizeText(Dctx.cn||Dctx.title||'');
  // ── Keyword signals ──
  if(family.keywords){
    if(family.keywords.test(tNorm))score+=4;         // title+module match → strongest
    else if(family.keywords.test(cNorm))score+=2;    // course name match
  }
  // ── Sector map signal ──
  var sectorNorm=normalizeText(Dctx.sector||'');
  if(sectorNorm){
    var sectorIds=resolveSectorIds(sectorNorm);
    if(sectorIds.indexOf(family.id)>=0)score+=2;
    if(family.compatibleSectors&&family.compatibleSectors.indexOf(sectorNorm)>=0)score+=1;
  }
  // ── Diversity penalties (Fase 7A: stronger scale) ──
  var usedCount=uExp.filter(function(f){return f.id===family.id;}).length;
  if(uExp.length>0){
    var prev=uExp[uExp.length-1];
    if(prev&&prev.id===family.id)score-=5;           // consecutive repeat — strongest
  }
  if(usedCount>=3)     score-=8;                     // 3rd use — near-block
  else if(usedCount>=2)score-=4;                     // 2nd use — heavy penalty
  // ── Diversity bonus: reward families not yet used ──
  if(usedCount===0)score+=2;
  return score;
}

// uExp: global history of families assigned in the current generation run.
// Reset at the start of each qScorms() call.
var uExp=[];

// experienceForCap: main adaptive selector — Fase 3 + Fase 7A.
// 1. Sector candidates (from SECTOR_MAP, never empty — falls back to premium pool)
// 2. Keyword-boost candidates (NFAMILIES.keywords vs title+module+course)
// 3. Merge + score (with diversity penalties from scoreFamily)
// 4. Sort with tiebreak by least-used
// 5. Variety filter: no consecutive; push diversity when <5 unique families in 9-cap course
// 6. Relaxed fallback → generic_premium ultimate fallback
function experienceForCap(Dctx,cap,idx){
  try{
    var tNorm=normalizeText((cap.t||'')+' '+(cap.mn||''));
    var cNorm=normalizeText(Dctx.cn||Dctx.title||'');

    // 1. Sector candidates (resolveSector never returns empty — premium fallback built in)
    var sectorFamilies=resolveSector(Dctx.sector||'');

    // 2. Keyword-boost candidates (any family whose keywords match title/module)
    var kwFamilies=NFAMILIES.filter(function(f){
      return f.keywords&&(f.keywords.test(tNorm)||f.keywords.test(cNorm));
    });

    // 3. Merge into scored pool (deduplicated by id)
    var pool={};
    sectorFamilies.concat(kwFamilies).forEach(function(f){
      if(f&&!pool[f.id])pool[f.id]=f;
    });
    var candidates=Object.keys(pool).map(function(id){return pool[id];});
    if(candidates.length===0)candidates=NFAMILIES.slice();

    // 4. Score + sort; tiebreak by least-used family
    var scored=candidates.map(function(f){
      var u=uExp.filter(function(x){return x.id===f.id;}).length;
      return{f:f,s:scoreFamily(f,Dctx,cap),u:u};
    }).sort(function(a,b){
      if(b.s!==a.s)return b.s-a.s;
      return a.u-b.u;                                // tiebreak: prefer least used
    });

    // 5. Variety filter
    var prev=uExp.length>0?uExp[uExp.length-1]:null;
    // Diversity goal: aim for ≥5 unique families in courses with ≥9 caps
    var totalCaps=(Dctx.caps&&Dctx.caps.length)||9;
    var uniqueUsed=Object.keys(uExp.reduce(function(acc,f){acc[f.id]=1;return acc;},{})).length;
    var capsLeft=totalCaps-idx;
    var needsDiversity=(uniqueUsed+capsLeft)<5&&scored.length>1;

    var chosen=null;
    // Pass A: no consecutive + no 3rd use + push diversity when needed
    for(var i=0;i<scored.length;i++){
      var c=scored[i].f;
      var notConsec=!prev||c.id!==prev.id;
      var notBlocked=scored[i].u<3;
      if(notConsec&&notBlocked){
        if(needsDiversity&&scored[i].u>0&&i<scored.length-1)continue; // skip already-used if alternatives exist
        chosen=c;break;
      }
    }
    // Pass B (relax diversity constraint): no consecutive + not blocked
    if(!chosen){
      for(var j=0;j<scored.length;j++){
        var cj=scored[j].f;
        if((!prev||cj.id!==prev.id)&&scored[j].u<3){chosen=cj;break;}
      }
    }
    // Pass C (relax block): just avoid consecutive
    if(!chosen){
      for(var k=0;k<scored.length;k++){
        if(!prev||scored[k].f.id!==prev.id){chosen=scored[k].f;break;}
      }
    }
    // Pass D: take top regardless
    if(!chosen)chosen=scored[0]?scored[0].f:null;

    // 6. Ultimate fallback — generic_premium: safe, premium, visually rich
    if(!chosen){
      var gp=NFAMILIES.filter(function(f){return f.id==='generic_premium';})[0];
      chosen=gp||NFAMILIES[idx%NFAMILIES.length];
    }

    uExp.push(chosen);
    uPack.push(chosen);
    return chosen;
  }catch(e){
    console.warn('[EXP] experienceForCap error:',e);
    var safe=NFAMILIES.filter(function(f){return f.id==='generic_premium';})[0]||NFAMILIES[idx%NFAMILIES.length];
    uExp.push(safe);uPack.push(safe);
    return safe;
  }
}

// Backward compat alias — any existing call to packForCap() is routed to new engine.
function packForCap(cap,idx){return experienceForCap(D,cap,idx);}

var SI=[];
// Motor v2 (06b-scorm-templates.js / 42-scorm-templates-ui.js) reemplaza al
// selector viejo (experienceForCap/mecFromPack) como camino de generacion --
// esas funciones quedan sin usar aca, deprecated (ver spec §10), pero no
// se borran por si hay que renderizar contenido ya generado con el motor viejo.
function qScorms(){
  var activeTemplateIds=sv2ResolveActiveTemplateIds(SEL.scormTemplates,SCORM_V2_TEMPLATES);
  SI=D.caps.map(function(cap,i){
    cap.scormActiveTemplateIds=activeTemplateIds;
    return{n:'🎮 SCORM Cap '+cap.n+': '+cap.t.substring(0,28),
      d:'5 salas · motor v2 ('+activeTemplateIds.length+' plantillas activas)',
      fh:'scorm_cap'+cap.n+'_index.html',fx:'scorm_cap'+cap.n+'_manifest.xml',
      cap:cap};
  });
  return SI.map(function(x){return{name:x.n,detail:x.d};});
}
// Repair truncated or malformed JSON from AI. Returns parsed object or safe fallback.
function repairScormJson(s,item){
  // 1. Direct parse
  try{return JSON.parse(s);}catch(_){}
  // 2. Try common closing suffixes for truncated JSON
  var closes=[']}',']}]',']}}',']}]}',']}]}]',']}]}]}',']}]}]}]'];
  for(var i=0;i<closes.length;i++){
    try{return JSON.parse(s+closes[i]);}catch(_){}
  }
  // 3. Find last complete question ending with "fb":"..." and cut there
  var lastFb=s.lastIndexOf('"fb"');
  if(lastFb<0)lastFb=s.lastIndexOf('"fb":');
  if(lastFb>=0){
    var closeQ=s.indexOf('}',lastFb+4);
    if(closeQ>=0){
      var cut=s.substring(0,closeQ+1);
      var sfx=[']}]}',']}]}',' ]}]}','\n]}]}','\n  ]\n    }\n  ]\n}'];
      for(var j=0;j<sfx.length;j++){
        try{return JSON.parse(cut+sfx[j]);}catch(_){}
      }
    }
  }
  // 4. Todos los intentos fallaron — lanzar para que el caller reintente
  console.error('[repairScormJson] cap '+item.cap.n+': all repair attempts failed');
  throw new Error('SCORM cap '+item.cap.n+' inv\u00E1lido: no se pudieron reparar salas/preguntas');
}

/**
 * Valida que el objeto de datos SCORM tenga contenido m\u00EDnimo real.
 * Retorna {ok, reason, total}.
 */
function _validateScormData(data,capN,mecName){
  if(!data||!Array.isArray(data.salas)||data.salas.length<3){
    var got=(data&&Array.isArray(data.salas))?data.salas.length:0;
    return{ok:false,reason:'solo '+got+' sala(s) (m\u00EDnimo 3)',total:0};
  }
  var totalQ=data.salas.reduce(function(t,s){
    return t+(Array.isArray(s.preguntas)?s.preguntas.length:0);
  },0);
  if(totalQ<9)return{ok:false,reason:totalQ+' preguntas (m\u00EDnimo 9)',total:totalQ};
  for(var si=0;si<data.salas.length;si++){
    if(!Array.isArray(data.salas[si].preguntas)||data.salas[si].preguntas.length===0)
      return{ok:false,reason:'sala '+(si+1)+' sin preguntas',total:totalQ};
    // Respaldo del schema estructurado: por si igual llega un campo vac\u00EDo/mal
    // formado, revisa que cada pregunta traiga lo que su mec\u00E1nica necesita.
    var preguntas=data.salas[si].preguntas;
    for(var qi=0;qi<preguntas.length;qi++){
      var qf=_validateScormQuestionFields(preguntas[qi],mecName);
      if(!qf.ok)return{ok:false,reason:'sala '+(si+1)+' preg '+(qi+1)+': '+qf.reason,total:totalQ};
    }
  }
  return{ok:true,reason:'ok',total:totalQ};
}

/**
 * Escaneo NO bloqueante del sesgo de longitud: cuenta cuántas preguntas
 * (de las mecánicas con opts+correct) tienen la respuesta correcta como la
 * opción más larga por un margen sospechoso (>15 chars sobre el promedio de
 * los distractores) — el "tell" que permite adivinar sin leer. Solo informa
 * para monitorear si el refuerzo del prompt está funcionando; no rechaza ni
 * reintenta, porque ya vimos que agregar más motivos de rechazo puede hacer
 * que se omitan capítulos completos.
 */
function _scanLengthBias(data){
  var flagged=0,total=0;
  if(!data||!Array.isArray(data.salas))return{flagged:0,total:0};
  data.salas.forEach(function(s){
    (s.preguntas||[]).forEach(function(q){
      if(!q||!Array.isArray(q.opts)||typeof q.correct!=='string')return;
      var distractors=q.opts.filter(function(o){return o!==q.correct;});
      if(distractors.length<2)return;
      total++;
      var avgDist=distractors.reduce(function(t,o){return t+String(o).length;},0)/distractors.length;
      var maxDist=Math.max.apply(null,distractors.map(function(o){return String(o).length;}));
      if(q.correct.length>maxDist&&q.correct.length-avgDist>15)flagged++;
    });
  });
  return{flagged:flagged,total:total};
}

/** Verifica que una pregunta individual traiga los campos que su mec\u00E1nica necesita. */
function _validateScormQuestionFields(q,mecName){
  if(!q||typeof q!=='object')return{ok:false,reason:'pregunta vac\u00EDa'};
  if(!q.q||String(q.q).trim().length<3)return{ok:false,reason:'sin texto de pregunta'};
  if(mecName==='Secuencia de Proceso Pro'){
    if(!Array.isArray(q.steps)||q.steps.length<2)return{ok:false,reason:'steps vac\u00EDo/insuficiente'};
    var badStep=q.steps.some(function(s){return !s||typeof s!=='object'||!s.label||String(s.label).trim().length<2;});
    if(badStep)return{ok:false,reason:'steps con label vac\u00EDo'};
  }else if(mecName==='Secuencia de Proceso'){
    if(!Array.isArray(q.steps)||q.steps.length<2)return{ok:false,reason:'steps vac\u00EDo/insuficiente'};
    var badStr=q.steps.some(function(s){return !s||typeof s!=='string'||s.trim().length<2||s.trim()==='?';});
    if(badStr)return{ok:false,reason:'steps con contenido inv\u00E1lido'};
  }else if(mecName==='Checklist Cr\u00EDtico'){
    if(!Array.isArray(q.items)||q.items.length<2)return{ok:false,reason:'items vac\u00EDo/insuficiente'};
  }else if(mecName==='Error Hunter'){
    if(!q.context||String(q.context).trim().length<10)return{ok:false,reason:'context vac\u00EDo/insuficiente'};
    if(!Array.isArray(q.errorSpans)||q.errorSpans.length<2)return{ok:false,reason:'errorSpans vac\u00EDo/insuficiente'};
  }else{
    if(!Array.isArray(q.opts)||q.opts.length<2)return{ok:false,reason:'opts vac\u00EDo/insuficiente'};
    var badOpt=q.opts.some(function(o){return !o||typeof o!=='string'||o.trim().length<1;});
    if(badOpt)return{ok:false,reason:'opts con opci\u00F3n vac\u00EDa'};
  }
  return{ok:true};
}

/** Detecta texto de placeholder gen\u00E9rico en el HTML final del SCORM. */
function _validateScormHtml(html){
  var pregStart=html.indexOf('var PREGUNTAS=');
  if(pregStart<0)return{ok:false,reason:'bloque PREGUNTAS no encontrado en HTML'};
  var pregEnd=html.indexOf(';\n',pregStart);
  var pregBlock=(pregEnd>pregStart)?html.substring(pregStart,pregEnd+2):html.substring(pregStart,pregStart+8000);
  // JSON.stringify serializa las claves con comillas dobles: "fb":"..." no fb:"..."
  var fbCount=(pregBlock.match(/"fb":/g)||[]).length;
  if(fbCount<9)return{ok:false,reason:'solo '+fbCount+' pregunta(s) reales ("fb":) en PREGUNTAS (m\u00EDnimo 9)'};
  return{ok:true,fbCount:fbCount};
}

/** Prompt reforzado para reintentos cuando la primera respuesta fue inv\u00E1lida. */
function _pSCORM_data_retry(item,c){
  // Si el primer intento fall\u00F3, repetir la MISMA exigencia (mismo n\u00FAmero de salas, mismo
  // tope de tokens) casi nunca cambia el resultado \u2014 si la causa fue quedarse sin espacio,
  // pedir lo mismo con lenguaje m\u00E1s insistente empuja al modelo a intentar meter a\u00FAn m\u00E1s
  // contenido en el mismo presupuesto. En el reintento se pide el m\u00EDnimo real (3 salas) en
  // vez del n\u00FAmero original \u2014 el validador acepta cualquier cantidad \u22653, as\u00ED que un juego
  // m\u00E1s chico que s\u00ED carga es mejor que repetir un intento que ya sabemos que falla.
  var retrySalas=Math.min(item.salas,3);
  var retryItem=Object.assign({},item,{salas:retrySalas});
  return pSCORM_data(retryItem,c)
    +'\n\n\u26A0\uFE0F REINTENTO OBLIGATORIO: la respuesta anterior fue inv\u00E1lida (JSON vac\u00EDo, incompleto o sin preguntas) '
    +'\u2014 probablemente por quedarse sin espacio de respuesta. Por eso ahora se piden MENOS salas. '
    +'DEBES generar EXACTAMENTE '+retrySalas+' salas con el campo "preguntas" (array, M\u00CDNIMO 4 \u00EDtems por sala). '
    +'Total m\u00EDnimo: '+Math.max(9,retrySalas*4)+' preguntas. '
    +'JSON puro \u00FAnicamente \u2014 sin texto antes ni despu\u00E9s, sin markdown, sin backticks.';
}

function sysScormData(){
  return 'Eres experto en gamificaci\u00F3n educativa para Moodle/SCORM. '
    +'Generas EXCLUSIVAMENTE JSON v\u00E1lido con preguntas para juegos educativos. '
    +'NUNCA incluyas c\u00F3digo HTML, bloques markdown, backticks o explicaciones. '
    +'Responde SOLO con el objeto JSON puro, sin ning\u00FAn texto antes ni despu\u00E9s.';
}

/**
 * Genera (o regenera) el SCORM gamificado de UN solo item \u2014 llamada AI +
 * validaci\u00F3n + reintento con prompt alternativo + validaci\u00F3n de HTML. No
 * toca el resto del curso. Usada tanto por genScorms() (todos los
 * cap\u00EDtulos) como por retryScormForChapter() (uno solo, manual).
 * Actualiza F[...], la fila de la cola (qSt/qResult) y el log de
 * diagn\u00F3stico \u2014 mismo comportamiento en ambos casos.
 */
/** Botón "🔄 Reintentar" en la fila de la cola para un capítulo que falló — llama
 *  retryScormForChapter(capN), que solo regenera ese capítulo, sin tocar el resto. */
function _qAddScormRetryButton(i,capN){
  var qa=document.getElementById('qa-scorms-'+i);
  if(!qa)return;
  qa.innerHTML='';
  var btn=document.createElement('button');
  btn.className='btn btn-g btn-sm';
  btn.textContent='🔄 Reintentar';
  btn.title='Reintentar solo el Cap '+capN;
  btn.addEventListener('click',function(){
    btn.disabled=true; btn.textContent='⏳ Reintentando…';
    window.retryScormForChapter(capN).finally(function(){
      btn.disabled=false; btn.textContent='🔄 Reintentar';
    });
  });
  qa.appendChild(btn);
}

async function _genScormForItem(item,i){
  qSt('scorms',i,'gen');
  try{
    var result=await genScormChapterV2(item.cap,item.cap.scormActiveTemplateIds);
    if(!result.ok){
      console.error('[genScorms] Cap '+item.cap.n+' inválido: '+result.reason);
      qSt('scorms',i,'err'); _qAddScormRetryButton(i,item.cap.n);
      return{ok:false,reason:result.reason};
    }
    var html=F[item.fh];
    var _qaClear=document.getElementById('qa-scorms-'+i); if(_qaClear)_qaClear.innerHTML='';
    qSt('scorms',i,'done'); qResult('scorms',i,item.fh,html); updStats();
    return{ok:true,reason:'ok'};
  }catch(e){
    console.error('SCORM gen error cap '+item.cap.n+':',e);
    qSt('scorms',i,'err'); _qAddScormRetryButton(i,item.cap.n);
    return{ok:false,reason:e.msg||e.message||String(e)};
  }
}

/**
 * Reintento manual de UN capítulo (por número, ej. retryScormForChapter(1))
 * — no regenera ni toca los demás capítulos ya generados. Al terminar con
 * éxito, F[...] queda actualizado y updStats() ya refrescó el botón de
 * "Exportar .MBZ" para que la próxima descarga incluya el capítulo arreglado.
 */
window.retryScormForChapter = async function(capN){
  if(!getApiKey()){alert('⚠️ Ingresa tu API key en el sidebar.');return{ok:false,reason:'no_api_key'};}
  var idx=SI.findIndex(function(it){return it.cap.n===capN;});
  if(idx<0){console.error('[retryScormForChapter] Cap '+capN+' no encontrado en SI — corre genScorms() primero.');return{ok:false,reason:'cap_not_found'};}
  console.log('[retryScormForChapter] Reintentando SOLO cap '+capN+'…');
  var result=await _genScormForItem(SI[idx],idx);
  if(result.ok) console.log('[retryScormForChapter] Cap '+capN+' listo ✓');
  else console.error('[retryScormForChapter] Cap '+capN+' siguió fallando: '+result.reason);
  return result;
};
async function genScorms(){
  if(!getApiKey()){alert('\u26A0\uFE0F Ingresa tu API key en el sidebar.');return;}
  var btn=document.querySelector('#br-scorms button'); btn.disabled=true;
  for(var i=0;i<SI.length;i++){
    await _genScormForItem(SI[i],i);
  }
  // Validación automática: muestra 9/9 en consola y bloquea si faltan SCORMs
  if(typeof window.showScormValidation==='function') window.showScormValidation();
  btn.disabled=false;
}


// ── Diagnóstico SCORM: leer y mostrar tabla desde localStorage ─────────────────
window.showScormDiag = function(courseId) {
  var key = 'cc_scorm_diag_' + (courseId || window.ACTIVE_COURSE_ID || 'local');
  var rows;
  try { rows = JSON.parse(localStorage.getItem(key) || '[]'); } catch(_) { rows = []; }
  if (!rows.length) {
    console.log('[ScormDiag] Sin datos para clave: ' + key);
    return;
  }
  console.log('[ScormDiag] ' + rows.length + ' registros — clave: ' + key);
  console.table(rows.map(function(d) {
    return {
      Cap: d.cap, TS: d.ts,
      Modelo: d.model1, ms1: d.ms1, HTTP1: d.status1, Bytes1: d.rawLen1, Vacía1: d.empty1,
      RepErr1: d.repairErr1 ? d.repairErr1.substring(0,60) : null,
      VD1: d.vdReason1,
      ms2: d.ms2, HTTP2: d.status2, Bytes2: d.rawLen2,
      RepErr2: d.repairErr2 ? d.repairErr2.substring(0,60) : null,
      VD2: d.vdReason2,
      Resultado: d.result,
      RawHead1: d.rawHead1 ? d.rawHead1.substring(0,80) : null,
      RawHead2: d.rawHead2 ? d.rawHead2.substring(0,80) : null
    };
  }));
  return rows;
};

// ── Limpiar diagnóstico guardado ──────────────────────────────────────────────
window.clearScormDiag = function(courseId) {
  var key = 'cc_scorm_diag_' + (courseId || window.ACTIVE_COURSE_ID || 'local');
  localStorage.removeItem(key);
  window._scormDiagLog = [];
  console.log('[ScormDiag] Diagnóstico borrado para: ' + key);
};

// Valida los SCORMs presentes en window.F y muestra tabla de salas/preguntas por capítulo.
// Se llama automáticamente al terminar genScorms() y también puede llamarse manualmente.
window.showScormValidation = function() {
  var F = window.F || {};
  var rows = [];
  var totalOk = 0;
  for (var n = 1; n <= 9; n++) {
    var key = 'scorm_cap' + n + '_index.html';
    var html = F[key];
    if (!html) { rows.push({cap: n, estado: '❌ FALTANTE', salas: 0, preguntas: 0}); continue; }
    var ps = html.indexOf('var PREGUNTAS=');
    var pe = ps >= 0 ? html.indexOf(';\n', ps) : -1;
    var block = (ps >= 0 && pe > ps) ? html.substring(ps, pe+2) : (ps >= 0 ? html.substring(ps, ps+12000) : '');
    var fbCount = (block.match(/"fb":/g) || []).length;
    var salaCount = (block.match(/sala\d+:/g) || []).length;
    var ok = fbCount >= 9;
    if (ok) totalOk++;
    rows.push({cap: n, estado: ok ? '✅ OK' : '⚠️ '+fbCount+' preg', salas: salaCount, preguntas: fbCount});
  }
  console.log('\n══ VALIDACIÓN SCORM (' + totalOk + '/9 correctos) ══');
  console.table(rows);
  if (totalOk < 9) {
    console.warn('⛔ Faltan SCORMs o tienen preguntas insuficientes. No empaquetar.');
  } else {
    console.log('✅ 9/9 SCORMs listos. Se puede empaquetar.');
  }
  return {ok: totalOk === 9, total: totalOk, detalle: rows};
};

function fixTruncatedJSstr(js){
  var ob=0,cb=0,op=0,cp=0;
  var inStr=null;
  for(var i=0;i<js.length;i++){
    var ch=js[i];
    if(ch==='\\'&&inStr){i++;continue;}
    if((ch==='"'||ch==="'"||ch==='`')&&(inStr===null||inStr===ch)){
      inStr=inStr===null?ch:null;continue;
    }
    if(inStr)continue;
    if(ch==='{')ob++;if(ch==='}')cb++;
    if(ch==='(')op++;if(ch===')')cp++;
  }
  // Close unclosed string
  if(inStr)js+=inStr;
  // Close parens then braces
  var fix='';
  for(var i=0;i<(op-cp);i++)fix+=')';
  if(fix)fix+=';';
  for(var i=0;i<(ob-cb);i++)fix+='}';
  if(fix)js+='\n// auto-fix truncated\n'+fix;
  return js;
}
function patchScormJs(html){
  var s=html;

  // ── FIX 0: Detect and seal truncated AI output ─────────────────────────────
  // A truncated SCORM never closes its main <script> block. Signs: no </script>
  // at all, or cc-scorm-fix appears before the first </script>.
  // Smart repair: if PREGUNTAS is present, cut at the last COMPLETE question
  // (last fb: + closing }) and close PREGUNTAS properly so questions are playable.
  // Fallback: cut at last '}' before truncation if no fb: found.
  (function sealTruncated(){
    var mainMatch=s.match(/<script(?!\s+id=)[^>]*>/i);
    if(!mainMatch)return;
    var bodyStart=mainMatch.index+mainMatch[0].length;
    var ccPos=s.indexOf('<script id="cc-scorm-fix">');
    var firstClose=s.indexOf('</script>');
    var truncated=(firstClose<0)||(ccPos>=0&&ccPos<firstClose);
    if(!truncated)return;
    var rawBody=ccPos>=0?s.substring(bodyStart,ccPos):s.substring(bodyStart);
    var cleanBody, suffix='';
    // Strategy 1: find last COMPLETE question inside PREGUNTAS.
    // Iterate fb: positions from last to first; a complete question has a closing }
    // within ~600 chars. If the last fb: is truncated mid-string, skip it and try
    // the previous one. This handles truncation inside the fb value itself.
    var pregStart=rawBody.indexOf('var PREGUNTAS');
    if(pregStart>=0){
      // Collect all fb: positions inside PREGUNTAS section
      var fbPositions=[];
      var searchFrom=pregStart;
      while(true){
        var fp=rawBody.indexOf('fb:',searchFrom);
        if(fp<0)break;
        fbPositions.push(fp);
        searchFrom=fp+1;
      }
      // Try from last to first
      var salaM=rawBody.match(/\n(\s+)sala\d+\s*:/);
      var ind=salaM?salaM[1]:'    ';
      for(var fi=fbPositions.length-1;fi>=0&&!cleanBody;fi--){
        var fbPos=fbPositions[fi];
        var closePos=-1;
        for(var ci=fbPos;ci<Math.min(rawBody.length,fbPos+600);ci++){
          if(rawBody[ci]==='}'){closePos=ci;break;}
        }
        if(closePos>=0){
          cleanBody=rawBody.substring(0,closePos+1);
          suffix='\n'+ind+']\n};\n';
          console.warn('[patchScormJs] FIX0: sealed after fb: #'+fi+' at pos '+closePos);
        }
      }
    }
    // Strategy 2: fallback — cut at last complete statement (last } not followed by comma)
    if(!cleanBody){
      // Find last } that ends a statement (not inside an array/object)
      var lastSafe=rawBody.lastIndexOf('};');
      if(lastSafe<0) lastSafe=rawBody.lastIndexOf('}');
      cleanBody=lastSafe>=0?rawBody.substring(0,lastSafe+1):rawBody;
      console.warn('[patchScormJs] FIX0: fallback — sealed at last } pos '+lastSafe);
    }
    var preScript=s.substring(0,mainMatch.index);
    s=preScript+mainMatch[0]+cleanBody+suffix+'\n  </script>\n</body></html>';
  })();

  // Fix: q.opts.slice() → (q.opts||[]).slice() — prevents crash on mechanics without opts
  s=s.replace(/\bq\.opts\.slice\(\)/g,'(q.opts||[]).slice()');

  // Fix: bare getElementById().innerHTML = without null check
  // Pattern: var x = document.getElementById('...'); x.innerHTML = ...
  // We can't easily add null checks retroactively, but we can wrap startSala functions
  // Find function startSalaN(){ ... } blocks and wrap body in try-catch if not already wrapped
  s=s.replace(/\b(function\s+startSala\d+\s*\(\s*\))\s*\{(?!\s*try\s*\{)([\s\S]*?)(?=\n\s*function|\n\s*\/\*|\nfunction|<\/script>)/g,
    function(m,sig,body){
      // Only wrap if body doesn't already start with try{
      if(/^\s*try\s*\{/.test(body)) return m;
      return sig+'{\n  try{'+body+'\n  }catch(_e){console.error("'+sig+':",_e);}\n}';
    }
  );

  // Fix: showScreen called without null guard on target element
  // Replace bare showScreen definition to add null guard (if not already present)
  s=s.replace(
    /function showScreen\s*\(id\)\s*\{[^}]*document\.getElementById\(id\)\.classList/g,
    function(m){
      if(m.indexOf('if(')>=0) return m; // already has guard
      return m.replace(
        'document.getElementById(id).classList',
        'var _el=document.getElementById(id);if(_el)_el.classList'
      );
    }
  );

  // ── FIX 1: </script> inside JS strings terminates the HTML script block early.
  // The HTML parser (not JS) sees </script> and closes the block regardless of context.
  // Replace every </script> that appears INSIDE the main <script> block with <\/script>
  // which is invisible to the HTML parser but semantically identical to JS.
  s=s.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi,function(m,open,body,close){
    // Only escape </script> occurrences INSIDE the body (not the legitimate closing tag)
    var fixed=body.replace(/<\/script>/gi,'<\\/script>');
    return open+fixed+close;
  });

  // ── FIX 2: renderArea(n) missing — AI sometimes writes runGame()/attach() instead.
  // If renderArea is not defined, inject a universal fallback that renders a plain
  // question+buttons layout so the game is always playable even if poorly styled.
  if(!/function\s+renderArea\s*\(/.test(s)){
    var fallback=
      '\nfunction renderArea(n){\n'+
      '  try{\n'+
      '    var q=PREGUNTAS["sala"+n][G.idx];\n'+
      '    G.currentOpts=shuffle((q.opts||[]).slice());\n'+
      '    var area=document.getElementById("area"+n);\n'+
      '    if(!area)return;\n'+
      '    var total=PREGUNTAS["sala"+n].length;\n'+
      '    area.innerHTML=\'<p style="font-size:17px;font-weight:700;margin:0 0 18px;line-height:1.4;">\'+\'(\'+( G.idx+1 )+\' / \'+total+\') \'+q.q+\'</p>\'+\n'+
      '      G.currentOpts.map(function(o,i){\n'+
      '        return \'<button class="btn-op" onclick="checkSala(\'+n+\',\'+i+\')" \'+\n'+
      '               \'style="display:block;width:100%;padding:14px 18px;margin:7px 0;\'+\n'+
      '               \'border-radius:12px;text-align:left;font-size:15px;cursor:pointer;">\'+o+\'</button>\';\n'+
      '      }).join(\'\');\n'+
      '  }catch(e){console.error("renderArea fallback",e);}\n'+
      '}\n';
    // Inject just before </script> of the main block
    s=s.replace(/<\/script>/i,fallback+'</script>');
  }

  return s;
}

function defMf(cap){return '<?xml version="1.0" encoding="UTF-8"?>\n<manifest identifier="cap'+cap.n+'_juego" version="1.2" xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2" xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd">\n  <metadata><schema>ADL SCORM</schema><schemaversion>1.2</schemaversion></metadata>\n  <organizations default="cap'+cap.n+'_org"><organization identifier="cap'+cap.n+'_org"><title>Cap '+cap.n+': '+cap.t+'</title><item identifier="item_1" identifierref="resource_1"><title>Juego Cap '+cap.n+'</title></item></organization></organizations>\n  <resources><resource identifier="resource_1" type="webcontent" adlcp:scormtype="sco" href="index.html"><file href="index.html"/></resource></resources>\n</manifest>';}
function pSCORM(item,c){return c+'\n\nGenera SOLO un JSON (sin explicaciones, sin bloques de código) con esta estructura exacta para un juego educativo sobre el Capítulo '+item.cap.n+': "'+item.cap.t+'" del sector '+D.sector+' en '+D.pais+'.\n\n{\n  "gameName": "Nombre creativo del juego",\n  "gameDesc": "Descripción corta de la mecánica (1 línea)",\n  "ptsPerQ": 10,\n  "salas": [\n    {\n      "name": "Nombre de la sala 1",\n      "emoji": "emoji",\n      "questions": [\n        {\n          "q": "Pregunta sobre el tema del capítulo",\n          "correct": "Respuesta correcta",\n          "wrong": ["Distractor 1", "Distractor 2", "Distractor 3"],\n          "fb": "Explicación breve de por qué es correcta"\n        }\n      ]\n    }\n  ]\n}\n\nREGLAS:\n- '+item.salas+' salas con 4-5 preguntas cada una\n- Preguntas ESPECÍFICAS sobre "'+item.cap.t+'" con ejemplos de '+D.sector+' en '+D.pais+'\n- Distractores plausibles de longitud similar a la correcta\n- Variar tipos: conceptuales, aplicadas, casos, verdadero/falso reformulado como pregunta\n- SOLO el JSON, nada más';}

// ════ ENGINE-FIRST SINGLE-PASS PROMPT ════
// Architecture: engine provided verbatim (never fails), AI writes DATA + renderArea() + CSS only.
function pSCORM_full(item,c,maxTok){
  var S=item.salas;
  // With Haiku's 8192-token hard limit, ask for fewer questions to avoid truncation.
  // Sonnet (16000 tok) can comfortably handle 4-5 questions per sala.
  var qPerSala=(maxTok&&maxTok<=8000)?'3':'4-5';
  var maxPts=S*5*10;
  var retUrl=(D.lms||'')+'/course/view.php?id='+(D.mid||'0');

  // ── Engine code provided verbatim — AI copies exactly ──
  var ENGINE=''
    +'var G={score:0,lives:3,idx:0,correct:0,wrong:0,currentOpts:[],maxPts:'+maxPts+',sala:1};\n'
    // ── showScreen: resetea scroll + oculta toast al cambiar pantalla (v6 anti-bug)
    +'function hideToastNow(){try{var e=document.getElementById("toast");e.style.display="none";}catch(e){}}\n'
    +'function showScreen(id){try{document.querySelectorAll(".screen").forEach(function(s){s.classList.remove("active");s.scrollTop=0;});var el=document.getElementById(id);if(el){el.classList.add("active");el.scrollTop=0;}window.scrollTo(0,0);hideToastNow();}catch(e){}}\n'
    +'function shuffle(a){for(var i=a.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var t=a[i];a[i]=a[j];a[j]=t;}return a;}\n'
    +'function updateHUD(){try{document.getElementById("hud-score").textContent=G.score;var h="";for(var i=0;i<3;i++)h+=i<G.lives?"❤️":"🖤";document.getElementById("hud-hearts").innerHTML=h;}catch(e){}}\n'
    // ── Toast con display:block/none — evita que persista entre salas (v6 anti-bug)
    +'function showToast(msg,ok){try{var e=document.getElementById("toast");if(G._tt)clearTimeout(G._tt);e.textContent=msg;e.style.background=ok?"#22c55e":"#ef4444";e.style.display="block";G._tt=setTimeout(function(){e.style.display="none";},2200);}catch(e){}}\n'
    // ── startSala: oculta toast stale antes de renderizar (v6 anti-bug)
    +'function startSala(n){try{G.sala=n;G.idx=0;G.lives=3;updateHUD();hideToastNow();renderArea(n);}catch(e){console.error("startSala",e);}}\n'
    +'function checkSala(n,i){try{var q=PREGUNTAS["sala"+n][G.idx];if(G.currentOpts[i]===q.correct){G.score+=10;G.correct++;showToast("✅ "+q.fb,true);}else{G.lives--;G.wrong++;showToast("❌ "+q.correct,false);if(G.lives<=0){gameOver();return;}}updateHUD();G.idx++;if(G.idx>=PREGUNTAS["sala"+n].length){completeSala(n);return;}renderArea(n);}catch(e){console.error("checkSala",e);}}\n'
    // ── completeSala: oculta toast antes de pasar a between (v6 anti-bug)
    +'function completeSala(n){try{hideToastNow();showScreen("between"+n);var el=document.getElementById("bpts"+n);if(el)el.textContent=G.score+" pts";}catch(e){}}\n'
    +'function _feedback(pct){if(pct>=100)return"🏆 ¡Perfecto! Dominas completamente este capítulo. ¡Felicitaciones!";if(pct>=90)return"🎯 ¡Excelente resultado! Estás muy cerca de la perfección. ¡Un esfuerzo más!";if(pct>=70)return"🌟 ¡Muy bien! Demuestras buen dominio del tema. ¡Sigue practicando!";if(pct>=50)return"🌱 ¡Vas por buen camino! Con un poco más de repaso lo dominarás.";if(pct>0)return"💪 ¡Sigue adelante! Revisa el material del capítulo y vuelve a intentarlo.";return"😔 ¡No te rindas! Repasa el contenido y vuelve a intentarlo. ¡Tú puedes!";}\n'
    +'function _setFeedback(txt){try{var el=document.getElementById("result-feedback");if(el)el.textContent=txt;}catch(e){}}\n'
    +'function gameOver(){try{hideToastNow();showScreen("result");document.getElementById("result-title").textContent="💔 Sin vidas";document.getElementById("result-stats").innerHTML="Correctas: "+G.correct+" &bull; Fallidas: "+G.wrong;_setFeedback(_feedback(0));scSet("cmi.core.lesson_status","failed");}catch(e){}}\n'
    +'function endGame(){try{var pct=Math.round(G.score/G.maxPts*100);var em=pct>=100?"🏆":pct>=90?"🎯":pct>=70?"🌟":pct>=50?"🌱":"📚";hideToastNow();showScreen("result");document.getElementById("result-title").textContent=em+" "+pct+"%";document.getElementById("result-stats").innerHTML="Correctas: "+G.correct+" &bull; Fallidas: "+G.wrong+" &bull; "+G.score+" pts";_setFeedback(_feedback(pct));scSet("cmi.core.score.raw",pct);scSet("cmi.core.lesson_status",pct>=70?"passed":"failed");try{_scAPI.LMSCommit("");_scAPI.LMSFinish("");}catch(x){}}catch(e){}}\n'
    +'function resetGame(){try{G={score:0,lives:3,idx:0,correct:0,wrong:0,currentOpts:[],maxPts:G.maxPts,sala:1};updateHUD();showScreen("screen-intro");}catch(e){}}\n'
    +'/* Auto-alias: genera startSala1..'+S+' y checkSala1..'+S+' automaticamente */\n'
    +'for(var _n=1;_n<='+S+';_n++){(function(n){window["startSala"+n]=function(){startSala(n);};window["checkSala"+n]=function(i){checkSala(n,i);};}(_n));}\n'
    +'var _scAPI=null;\n'
    +'function _findAPI(w){try{if(w.API)return w.API;if(w.parent&&w.parent!=w)return _findAPI(w.parent);return null;}catch(e){return null;}}\n'
    // ── scSet con LMSCommit — garantiza persistencia inmediata (v6)
    +'function scSet(k,v){try{if(_scAPI){_scAPI.LMSSetValue(k,String(v));_scAPI.LMSCommit("");}}catch(e){}}\n'
    +'window.onload=function(){try{_scAPI=_findAPI(window);if(_scAPI)_scAPI.LMSInitialize("");}catch(e){}updateHUD();};';

  return c+'\n\n'
    +'CAPÍTULO '+item.cap.n+': "'+item.cap.t+'" | '+item.cap.mn+'\n'
    +'COLOR: '+item.cap.hex+' | MECÁNICA: '+item.mec.name+' | ESTÉTICA: '+item.est+'\n'
    +'SALAS: '+S+' | SECTOR: '+D.sector+' | PAÍS: '+D.pais+'\n\n'
    +'Genera EXACTAMENTE 2 bloques (```html y ```xml).\n\n'

    +'══ HTML: estructura OBLIGATORIA ══\n'
    +'<head>: meta charset, viewport(width=device-width,initial-scale=1,user-scalable=no), Google Fonts del tema, <style>.\n'
    +'CSS FIJO (no cambiar) + variables del tema en :root:\n'
    +':root{ --bg:#...; --bg2:#...; --accent:#...; --accent2:#...; --text:#...; --text2:rgba(...); --btn:#...; --btn-text:#...; --btn-border:rgba(...); --hud-bg:#...; --card-bg:rgba(...); } /* Rellena con los colores de la estética */\n'
    +'body{margin:0;font-family:\'...\',sans-serif;background:var(--bg);color:var(--text);}\n'
    +'.screen{display:none;position:fixed;top:0;left:0;width:100%;height:100%;z-index:10;overflow-y:auto;background:var(--bg);}\n'
    +'.screen.active{display:flex;flex-direction:column;align-items:center;justify-content:flex-start;}\n'
    +'.gwrap{width:100%;max-width:680px;padding:60px 16px 80px;}\n'
    +'.game-area{width:100%;max-width:680px;}\n'
    +'.hud{position:fixed;top:0;left:0;width:100%;height:44px;z-index:1001;display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:13px;font-weight:700;background:var(--hud-bg);border-bottom:1px solid var(--btn-border);}\n'
    +'#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:1002;display:none;padding:12px 24px;border-radius:10px;color:#fff;font-weight:700;pointer-events:none;max-width:90vw;text-align:center;}\n'
    +'.flip-front,.flip-back{backface-visibility:hidden;-webkit-backface-visibility:hidden;}\n'
    +'/* Botones de opción: usa var() — NUNCA dejar el gris por defecto del navegador */\n'
    +'.btn-op{background:var(--btn);color:var(--btn-text);border:1px solid var(--btn-border);cursor:pointer;font-family:inherit;transition:opacity .15s;}\n'
    +'.btn-op:hover{opacity:.85;}\n'
    +'/* Botón primario (Iniciar, Siguiente, Reintentar) */\n'
    +'.btn-primary{background:var(--accent);color:#000;border:none;cursor:pointer;font-weight:800;font-family:inherit;font-size:16px;padding:14px 32px;border-radius:12px;letter-spacing:.5px;}\n'
    +'+ estilos adicionales propios de la estética "'+item.est+'" (animaciones, glow, texturas, etc.)\n\n'

    +'DISEÑO PREMIUM — aplica la estética en CADA elemento:\n'
    +'• HUD: usa var(--hud-bg), separador visual inferior, texto brillante\n'
    +'• INTRO: hero centrado con emoji/icono grande (64px+), nombre del juego con tipografía del tema (font-size:32px+, font-weight:900), subtítulo, row de stats ('+S+' salas • 3 vidas • '+maxPts+' pts) con cards compactas, .btn-primary para iniciar\n'
    +'• SALA (gwrap/game-area): los botones de opciones SIEMPRE usan .btn-op + inline styles adicionales del tema — JAMÁS button sin estilo\n'
    +'• ENTRE SALAS: emoji de éxito grande (56px), score en grande con var(--accent), .btn-primary para continuar\n'
    +'• RESULTADO: título grande con emoji de victoria/derrota, stats en card, 2 botones .btn-primary\n\n'

    +'<body>:\n'
    +'1. <div class="hud"><span>'+item.cap.t.substring(0,20)+'</span><span id="hud-hearts">❤️❤️❤️</span><span id="hud-score">0 pts</span></div>\n'
    +'2. <div id="toast"></div>\n'
    +'3. #screen-intro.screen.active style="justify-content:center" — diseño hero premium (ver DISEÑO PREMIUM arriba)\n'
    +'4. '+S+'× #salaN.screen — <div class="gwrap"><div class="game-area" id="areaN"></div></div>\n'
    +'5. '+S+'× #betweenN.screen style="justify-content:center" — celebración premium: emoji grande, <span id="bptsN"></span>, .btn-primary "Siguiente →" (última sala: onclick="endGame()")\n'
    +'6. #result.screen style="justify-content:center" — game-over premium: <h2 id="result-title"></h2> <p id="result-stats"></p> .btn-primary Reintentar + Volver al curso\n\n'

    +'══ JS: REGLAS ABSOLUTAS ══\n'
    +'PASO 1 — Copia el siguiente motor VERBATIM (no modificar ni una línea):\n'
    +ENGINE+'\n\n'
    +'PASO 2 — Define PREGUNTAS con datos REALES sobre "'+item.cap.t+'" ('+D.sector+', '+D.pais+'):\n'
    +'var PREGUNTAS={\n'
    +'  sala1:[{q:"pregunta real",correct:"resp correcta",opts:["resp correcta","dist 1","dist 2","dist 3"],fb:"explicación"},... /* '+qPerSala+' preguntas */],\n'
    +'  sala2:[...], /* etc hasta sala'+S+' */\n'
    +'};\n'
    +'REGLAS datos: correct NUNCA la más larga; opts misma longitud aprox; fb educativo; contenido REAL del sector.\n'
    +'⚠️ shuffle SIEMPRE se asigna: G.currentOpts=shuffle(q.opts.slice()); — NUNCA shuffle(arr) sin asignar el resultado.\n\n'
    +'PASO 3 — Implementa renderArea(n) para la mecánica "'+item.mec.name+'":\n'
    +'function renderArea(n){\n'
    +'  try{\n'
    +'    var q=PREGUNTAS["sala"+n][G.idx];\n'
    +'    G.currentOpts=shuffle(q.opts.slice());\n'
    +'    var area=document.getElementById("area"+n);\n'
    +'    if(!area)return;\n'
    +'    /* USA el hint de la mecánica para construir area.innerHTML */\n'
    +'  }catch(e){console.error("renderArea",e);}\n'
    +'}\n\n'

    +'🔴 REGLA DE ORO — EL ONCLICK (leer antes de escribir renderArea):\n'
    +'El onclick de cada opción DEBE ser una CONCATENACIÓN de strings JavaScript, NO texto literal:\n'
    +'  ✅ CORRECTO: \'<button onclick="checkSala(\'+n+\',\'+i+\')">\'+o+\'</button>\'\n'
    +'  ❌ ROTO:     \'<button onclick="checkSala(n,i)">\'+o+\'</button>\'   ← n,i como texto = no funciona\n'
    +'  ❌ ROTO:     \'<button onclick="checkSala(1,0)">\'+o+\'</button>\'   ← números fijos = solo funciona para 1 sala\n'
    +'Donde: n = el parámetro de renderArea(n), i = el índice del .map(function(o,i){...})\n\n'

    +'MECÁNICA "'+item.mec.name+'" — construye area.innerHTML EXACTAMENTE así (copia el patrón, personaliza solo el CSS inline):\n'
    +item.mec.hint+'\n\n'
    +'🎨 REGLA DE DISEÑO — todos los <button> de opciones DEBEN tener class="btn-op" además del style inline:\n'
    +'  CORRECTO: \'<button class="btn-op" onclick="checkSala(\'+n+\',\'+i+\')" style="display:block;width:100%;padding:14px;border-radius:12px;">\'+o+\'</button>\'\n'
    +'Los estilos inline del hint son el LAYOUT (width, padding, margin, border-radius, flex, etc).\n'
    +'Los colores y tipografía los aporta .btn-op via CSS variables — así el tema se aplica automáticamente.\n\n'
    +'NO escribas startSala1..'+S+', checkSala1..'+S+' ni ninguna función del motor — ya generadas por el bucle for.\n'
    +'Solo añade funciones auxiliares específicas si las necesitas (ej: animaciones CSS).';
}







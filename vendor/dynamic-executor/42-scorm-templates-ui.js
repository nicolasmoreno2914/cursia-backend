// ════ SCORM v2 — UI de selección (galería + picker) ════
// Alimenta dos vistas (galería de solo lectura en el sidebar, picker
// manual/aleatorio en Datos del curso) desde el mismo catálogo
// SCORM_V2_TEMPLATES (06b-scorm-templates.js). No conecta la selección a
// la generación real — eso es integración futura.

/**
 * Resuelve qué ids de plantilla están "activos" para un curso, dado lo
 * que el usuario eligió (SEL.scormTemplates) y el catálogo disponible.
 * - selection 'auto' (o cualquier valor que no sea un array con >=2 ids
 *   válidos del catálogo) cae siempre a "usar todo el catálogo completo"
 *   — ver spec §5, sin preselección por sector ya que el diseño es
 *   agnóstico de sector.
 * - selection manual (array) se respeta tal cual si tiene >=2 ids que
 *   existen en el catálogo, descartando cualquier id que ya no exista.
 */
function sv2ResolveActiveTemplateIds(selection, catalog) {
  var catalogIds = (catalog || []).map(function (t) { return t.id; });
  if (Array.isArray(selection)) {
    var valid = selection.filter(function (id) { return catalogIds.indexOf(id) >= 0; });
    if (valid.length >= 2) return valid;
  }
  return catalogIds;
}

function _sv2UiEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ════ Preview en vivo de cada plantilla (galería + picker) ════
// Datos de ejemplo fijos, genéricos/agnósticos de sector (mismo principio
// que el resto del catálogo — spec §4), uno por plantilla. Sirven SOLO
// para mostrar cómo se ve/juega cada plantilla en las tarjetas — nunca se
// usan para generar contenido real de un curso.
var SV2_PREVIEW_FIXTURES = {
  equipar_escena: { scenario: 'Antes de ingresar a planta.', items: [
    { id: 'i1', label: 'Casco', zone: 'head' },
    { id: 'i2', label: 'Chaleco', zone: 'torso' },
    { id: 'i3', label: 'Guantes', zone: 'hands' },
    { id: 'i4', label: 'Botas', zone: 'feet' },
    { id: 'i5', label: 'Gafas de sol', zone: 'none' }
  ] },
  decision_consecuencia: { scenario: 'Notas una costura suelta en el arnés.', options: [
    { id: 'o1', label: 'Reportarlo', correct: true, consequence: 'Se revisa antes de reutilizarlo.' },
    { id: 'o2', label: 'Usarlo igual', correct: false, consequence: 'Puede fallar bajo carga real.' },
    { id: 'o3', label: 'Repararlo con cinta', correct: false, consequence: 'No restituye la resistencia certificada.' }
  ] },
  sopa_letras: { scenario: 'Encuentra el equipo de protección.', words: [
    { id: 'w1', text: 'CASCO' }, { id: 'w2', text: 'GUANTES' }, { id: 'w3', text: 'BOTAS' },
    { id: 'w4', text: 'ARNES' }, { id: 'w5', text: 'CHALECO' }, { id: 'w6', text: 'GAFAS' }
  ] },
  crucigrama: { scenario: 'Resuelve el crucigrama de EPP.', pairs: [
    { id: 'p1', term: 'CASCO', clue: 'protege la cabeza' },
    { id: 'p2', term: 'GUANTES', clue: 'protegen las manos' },
    { id: 'p3', term: 'BOTAS', clue: 'protegen los pies' },
    { id: 'p4', term: 'ARNES', clue: 'previene caídas' },
    { id: 'p5', term: 'CHALECO', clue: 'protege el torso' },
    { id: 'p6', term: 'GAFAS', clue: 'protegen los ojos' }
  ] },
  ruleta_preguntas: { scenario: 'Gira la ruleta.', categories: [
    { id: 'c1', label: 'Cascos', questions: [{ id: 'q1', text: '¿Cuándo se descarta un casco?', options: [
      { id: 'o1', label: 'Tras un golpe fuerte', correct: true },
      { id: 'o2', label: 'Nunca', correct: false },
      { id: 'o3', label: 'Solo si se ve sucio', correct: false }
    ] }] },
    { id: 'c2', label: 'Guantes', questions: [{ id: 'q2', text: '¿Qué guante usar con químicos?', options: [
      { id: 'o4', label: 'Guante de tela', correct: false },
      { id: 'o5', label: 'Guante resistente a químicos', correct: true },
      { id: 'o6', label: 'Sin guantes', correct: false }
    ] }] },
    { id: 'c3', label: 'Botas', questions: [{ id: 'q3', text: '¿Qué protegen las botas de seguridad?', options: [
      { id: 'o7', label: 'Los dedos de los pies', correct: true },
      { id: 'o8', label: 'Las manos', correct: false },
      { id: 'o9', label: 'La cabeza', correct: false }
    ] }] }
  ] },
  multicamino: { scenario: 'Notas una fuga de gas.', nodes: [
    { id: 'start', text: '¿Qué haces primero?', options: [
      { id: 'o1', label: 'Reportar de inmediato', leadsTo: 'n2', isGoodPath: true },
      { id: 'o2', label: 'Seguir trabajando', leadsTo: 'n3', isGoodPath: false }
    ] },
    { id: 'n2', text: 'Reportaste, ¿qué haces ahora?', options: [
      { id: 'o3', label: 'Evacuar el área', leadsTo: 'end', isGoodPath: true },
      { id: 'o4', label: 'Ignorar y continuar', leadsTo: 'end', isGoodPath: false }
    ] },
    { id: 'n3', text: 'El olor empeora.', options: [
      { id: 'o5', label: 'Reportar tarde', leadsTo: 'end', isGoodPath: false },
      { id: 'o6', label: 'Seguir ignorando', leadsTo: 'end', isGoodPath: false }
    ] }
  ] },
  armar_proceso: { scenario: 'Ordena el procedimiento de bloqueo.', steps: [
    { id: 's1', label: 'Notificar al equipo', order: 1 },
    { id: 's2', label: 'Apagar la máquina', order: 2 },
    { id: 's3', label: 'Colocar el candado', order: 3 },
    { id: 's4', label: 'Verificar energía cero', order: 4 },
    { id: 's5', label: 'Iniciar el trabajo', order: 5 }
  ] }
};

/**
 * Arma un documento HTML autocontenido con la sala REAL de una plantilla
 * (mismo html/css/script del motor, 06b-scorm-templates.js) para mostrar
 * en un <iframe> chico dentro de la tarjeta — nunca se desincroniza del
 * SCO real porque reusa exactamente su HTML/CSS/JS, no una captura ni un
 * mockup aparte. Nunca conecta a SCORM real ni a `genScormChapterV2` —
 * `sv2CompleteRoom` queda como no-op, solo para que el script de la sala
 * no lance si el alumno alcanza a interactuar con el preview.
 */
function sv2BuildTemplatePreviewHtml(templateId) {
  var renderer = (typeof SV2_ROOM_RENDERERS !== 'undefined') ? SV2_ROOM_RENDERERS[templateId] : null;
  var fixture = SV2_PREVIEW_FIXTURES[templateId];
  if (!renderer || !fixture) {
    throw new Error('sv2BuildTemplatePreviewHtml: plantilla desconocida "' + templateId + '"');
  }
  var css = (typeof sv2GetRoomCss === 'function') ? sv2GetRoomCss() : '';
  var bodyHtml = renderer.html(fixture);
  var script = 'function sv2CompleteRoom(){}\n'
    + '(' + renderer.script.toString().replace(/^function\s+\w+/, 'function') + ')(document.getElementById("sv2-preview-room"));';
  return '<!DOCTYPE html>\n<html lang="es">\n<head>\n<meta charset="UTF-8">\n<style>' + css + '</style>\n</head>\n<body>\n'
    + '<div class="sv2-shell"><div class="sv2-panel" id="sv2-preview-room">' + bodyHtml + '</div></div>\n'
    + '<script>' + script + '</script>\n</body>\n</html>';
}

function sv2TemplateCardHtml(template, selectable, selected) {
  var cls = 'sv2-tpl-card' + (selectable ? ' sv2-tpl-selectable' : '') + (selected ? ' sv2-tpl-selected' : '');
  var attrs = 'class="' + cls + '" data-template-id="' + _sv2UiEsc(template.id) + '"';
  if (selectable) {
    attrs += ' role="button" tabindex="0" aria-pressed="' + (selected ? 'true' : 'false') + '"';
  }
  // El preview es decorativo y no interactivo a propósito (pointer-events:
  // none en CSS) — clickear cualquier parte de la tarjeta selecciona la
  // plantilla, nunca interactúa con la mini-demo. Si algo falla al armar
  // el preview (plantilla sin fixture, motor no cargado en un contexto de
  // prueba aislado), la tarjeta se degrada a solo texto en vez de romper
  // toda la grilla — a diferencia del motor de generación real, acá una
  // tarjeta sin preview no le cuesta nada al curso del usuario.
  var previewHtml = '';
  try {
    if (typeof sv2BuildTemplatePreviewHtml === 'function') {
      var previewDoc = sv2BuildTemplatePreviewHtml(template.id);
      previewHtml = '<div class="sv2-tpl-preview" aria-hidden="true"><iframe class="sv2-tpl-preview-frame" tabindex="-1" srcdoc="' + _sv2UiEsc(previewDoc) + '"></iframe></div>';
    }
  } catch (e) {
    previewHtml = '';
  }
  return '<div ' + attrs + '>'
    + previewHtml
    + '<p class="sv2-tpl-label">' + _sv2UiEsc(template.label) + '</p>'
    + '<p class="sv2-tpl-desc">' + _sv2UiEsc(template.description) + '</p>'
    + '</div>';
}

function sv2GroupByCategory(catalog) {
  var groups = {};
  (catalog || []).forEach(function (t) {
    if (!groups[t.category]) groups[t.category] = [];
    groups[t.category].push(t);
  });
  return groups;
}

// El iframe de preview se renderiza a tamaño real (640px, el ancho del
// .sv2-shell del motor) y se achica con transform:scale — pero el ancho
// final de la tarjeta varía según el grid (auto-fill minmax(220px,1fr)),
// así que un scale fijo por CSS deja una franja vacía en tarjetas más
// anchas. Se mide el ancho real después de insertar el HTML y se ajusta
// el scale (y el alto del contenedor, para no recortar de más ni dejar
// espacio de sobra) por tarjeta.
var SV2_PREVIEW_DOC_WIDTH = 640;
var SV2_PREVIEW_DOC_HEIGHT = 340;

function _sv2ScalePreviews(root) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('.sv2-tpl-preview').forEach(function (wrap) {
    var frame = wrap.querySelector('.sv2-tpl-preview-frame');
    if (!frame) return;
    // El alto real del contenido varía por plantilla (una ruleta no mide
    // lo mismo que un crucigrama con lista de pistas) — SV2_PREVIEW_DOC_HEIGHT
    // es solo un valor de arranque para no dejar el contenedor en 0px
    // mientras el iframe carga; en cuanto carga, se mide el alto real
    // (frame.contentDocument.body.scrollHeight) y se recalcula, así ninguna
    // plantilla queda recortada ni con espacio de sobra por una altura
    // asumida que no le corresponde.
    function applyScale() {
      var w = wrap.getBoundingClientRect ? wrap.getBoundingClientRect().width : wrap.offsetWidth;
      if (!w) return;
      var scale = w / SV2_PREVIEW_DOC_WIDTH;
      var contentHeight = SV2_PREVIEW_DOC_HEIGHT;
      try {
        var frameDoc = frame.contentDocument;
        if (frameDoc && frameDoc.body && frameDoc.body.scrollHeight) contentHeight = frameDoc.body.scrollHeight;
      } catch (e) {}
      // El <iframe> tiene su propio viewport interno — si se deja en el
      // alto de arranque (SV2_PREVIEW_DOC_HEIGHT) y el contenido real mide
      // más, ese excedente queda recortado DENTRO del iframe antes de que
      // el transform:scale tenga oportunidad de encogerlo. Hay que agrandar
      // el iframe al alto real medido primero, recién después escalarlo.
      frame.style.height = contentHeight + 'px';
      frame.style.transform = 'scale(' + scale + ')';
      wrap.style.height = Math.round(contentHeight * scale) + 'px';
    }
    frame.addEventListener('load', applyScale);
    applyScale();
  });
}

var SV2_CATEGORY_LABELS = {
  practica: 'Práctica',
  palabras: 'Palabras',
  trivia: 'Trivia',
  narrativa: 'Narrativa',
  construccion: 'Construcción'
};

window.sv2RenderGallery = function () {
  var root = document.getElementById('sv2-gallery-root');
  if (!root) return;
  var grouped = sv2GroupByCategory(typeof SCORM_V2_TEMPLATES !== 'undefined' ? SCORM_V2_TEMPLATES : []);
  var html = '';
  Object.keys(grouped).forEach(function (category) {
    var label = SV2_CATEGORY_LABELS[category] || category;
    html += '<div class="sv2-tpl-category"><p class="sv2-tpl-category-label">' + _sv2UiEsc(label) + '</p><div class="sv2-tpl-grid">';
    grouped[category].forEach(function (t) {
      html += sv2TemplateCardHtml(t, false, false);
    });
    html += '</div></div>';
  });
  root.innerHTML = html || '<p class="sv2-tpl-desc">Todavía no hay plantillas en el catálogo.</p>';
  _sv2ScalePreviews(root);
};

/**
 * Calcula la selección siguiente al togglear una tarjeta. Función pura —
 * no toca SEL ni el DOM, eso lo hace sv2PickerToggleTemplate.
 */
function sv2PickerComputeNextSelection(currentSelection, toggledId, catalog) {
  var catalogIds = (catalog || []).map(function (t) { return t.id; });
  if (catalogIds.indexOf(toggledId) < 0) {
    var unchanged = Array.isArray(currentSelection) ? currentSelection.slice() : [];
    return { selection: unchanged, isAuto: false };
  }
  var base = Array.isArray(currentSelection) ? currentSelection.slice() : [];
  var idx = base.indexOf(toggledId);
  if (idx >= 0) {
    base.splice(idx, 1);
  } else {
    base.push(toggledId);
  }
  return { selection: base, isAuto: false };
}

function _sv2PickerPersist() {
  try { localStorage.setItem('cc_sel', JSON.stringify(SEL)); } catch (e) {}
}

window.sv2RenderPicker = function (focusId) {
  var root = document.getElementById('sv2-picker-root');
  var autoBtn = document.getElementById('sv2-picker-auto-btn');
  var errorEl = document.getElementById('sv2-picker-error');
  if (!root || !autoBtn || !errorEl) return;
  var catalog = typeof SCORM_V2_TEMPLATES !== 'undefined' ? SCORM_V2_TEMPLATES : [];
  var catalogIds = catalog.map(function (t) { return t.id; });
  var isManual = Array.isArray(SEL.scormTemplates);
  autoBtn.classList.toggle('is-on', !isManual);
  // Review Focus: SEL.scormTemplates puede traer ids de una sesión anterior
  // que ya no existen en el catálogo actual — se filtran ANTES de contar,
  // para que el aviso de "mínimo 2" no dé un falso negativo con ids fantasma.
  var rawSelected = isManual ? SEL.scormTemplates : [];
  var validSelected = rawSelected.filter(function (id) { return catalogIds.indexOf(id) >= 0; });
  root.innerHTML = catalog.map(function (t) {
    return sv2TemplateCardHtml(t, true, validSelected.indexOf(t.id) >= 0);
  }).join('');
  _sv2ScalePreviews(root);
  root.querySelectorAll('.sv2-tpl-card').forEach(function (card) {
    card.addEventListener('click', function () {
      sv2PickerToggleTemplate(card.getAttribute('data-template-id'));
    });
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        sv2PickerToggleTemplate(card.getAttribute('data-template-id'));
      }
    });
  });
  if (isManual && validSelected.length < 2) {
    errorEl.hidden = false;
    errorEl.textContent = 'Elige al menos 2 para modo manual — con menos de 2, se usa automático.';
  } else {
    errorEl.hidden = true;
  }
  // Fix: re-renderizar reemplaza toda la grilla con innerHTML, lo que
  // destruye el elemento enfocado — sin esto, un usuario de teclado
  // pierde el foco (cae a <body>) en cada toggle, haciendo el soporte
  // de Enter/Espacio impracticable para navegar varias tarjetas seguidas.
  if (focusId) {
    var toFocus = root.querySelector('[data-template-id="' + focusId + '"]');
    if (toFocus) toFocus.focus();
  }
};

window.sv2PickerToggleTemplate = function (id) {
  var catalog = typeof SCORM_V2_TEMPLATES !== 'undefined' ? SCORM_V2_TEMPLATES : [];
  var current = Array.isArray(SEL.scormTemplates) ? SEL.scormTemplates : [];
  var next = sv2PickerComputeNextSelection(current, id, catalog);
  SEL.scormTemplates = next.selection;
  _sv2PickerPersist();
  sv2RenderPicker(id);
};

window.sv2PickerSetAuto = function () {
  SEL.scormTemplates = 'auto';
  _sv2PickerPersist();
  sv2RenderPicker();
};

if (typeof sv2RenderPicker === 'function') sv2RenderPicker();

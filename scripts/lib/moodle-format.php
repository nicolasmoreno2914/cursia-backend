<?php
// R2 (Cursia V2.1) — puente de SOLO LECTURA hacia format_text() de un Moodle local, con
// los filtros activos del sitio (activitynames, emoticon, urltolink, mediaplugin…).
// Reproduce cómo Moodle muestra la descripción de un label: variante `noclean` (default de
// mod_label) y variante limpia (equivalente a forceclean=1). No escribe configuración ni
// datos: la sesión de admin se fija solo en memoria del proceso para que activitynames vea
// las actividades del curso.
//
// Entrada (stdin, JSON):
//   {"mode":"probe"}                         → {"cmid":…, "courseid":…, "names":[…]}
//   {"mode":"format","cmid":N,"items":[…]}   → {"noclean":[…], "clean":[…]}
define('CLI_SCRIPT', true);
$config = getenv('MOODLE_CONFIG');
if (!$config || !is_readable($config)) {
    fwrite(STDERR, "MOODLE_CONFIG no apunta a un config.php legible\n");
    exit(2);
}
require($config);
\core\session\manager::set_user(get_admin());
$in = json_decode(stream_get_contents(STDIN), true);
if (!is_array($in) || empty($in['mode'])) {
    fwrite(STDERR, "entrada inválida\n");
    exit(3);
}
if ($in['mode'] === 'probe') {
    // Primer curso con ≥ 3 actividades visibles: una da el contexto, las otras dan nombres
    // que el filtro activitynames enlazaría.
    $courses = $DB->get_records_sql(
        "SELECT course, COUNT(1) n FROM {course_modules} WHERE visible = 1 AND deletioninprogress = 0 GROUP BY course HAVING COUNT(1) >= 3 ORDER BY course"
    );
    foreach ($courses as $c) {
        $mi = get_fast_modinfo($c->course);
        $cms = array_values(array_filter($mi->get_cms(), fn($cm) => $cm->uservisible && $cm->url && core_text::strlen($cm->name) >= 6 && preg_match("/^[\\p{L}\\p{N} ]+$/u", $cm->name)));
        if (count($cms) < 3) {
            continue;
        }
        $names = [];
        foreach (array_slice($cms, 1) as $cm) {
            if (!in_array($cm->name, $names, true)) {
                $names[] = $cm->name;
            }
        }
        echo json_encode(['cmid' => (int)$cms[0]->id, 'courseid' => (int)$c->course, 'names' => $names], JSON_UNESCAPED_UNICODE);
        exit(0);
    }
    fwrite(STDERR, "no hay un curso con ≥ 3 actividades visibles\n");
    exit(4);
}
$ctx = context_module::instance((int)$in['cmid']);
$f = \core\di::get(\core\formatting::class);
$out = ['noclean' => [], 'clean' => []];
foreach ($in['items'] as $html) {
    // format_text(text, format, context, trusted, clean, filter, para, newlines)
    $out['noclean'][] = $f->format_text((string)$html, FORMAT_HTML, $ctx, false, false, true, false, false);
    $out['clean'][] = $f->format_text((string)$html, FORMAT_HTML, $ctx, false, true, true, false, false);
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

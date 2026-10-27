<?php
// r77 «Mobile-first» — apoyo CLI (como admin) para medir cursos restaurados en un Moodle local DESECHABLE.
//
//   --action=cms --courseid=<id>              JSON: secciones y TODAS las actividades del curso (cmid, modname, idnumber,
//                                             sección, URL de la actividad) para recorrerlas con el navegador
//   --action=forceclean [--set=0|1]           lee (y opcionalmente cambia) $CFG->forceclean («Limpiar contenido en todo
//                                             el sitio»). Solo para el Moodle local de pruebas: el check lo devuelve al
//                                             valor de antes al terminar
//   --action=webservice-contents --courseid=<id> --username=<u>
//                                             JSON: lo que recibe la app oficial de Moodle (core_course_get_contents
//                                             formateado con external_format_text, como lo pide la app) para cada label
//
// Uso: php -c php.ini r77-mobile.php --moodle=<raíz de Moodle> --action=… [opciones]
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'action:', 'courseid:', 'set:', 'username:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/externallib.php');
global $DB, $USER, $CFG;
\core\session\manager::set_user(get_admin());
$action = $opts['action'] ?? '';

if ($action === 'cms') {
    $courseid = (int)$opts['courseid'];
    $course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);
    $modinfo = get_fast_modinfo($course);
    $out = ['courseid' => $courseid, 'fullname' => $course->fullname, 'format' => $course->format, 'sections' => [], 'cms' => []];
    foreach ($modinfo->get_section_info_all() as $s) {
        $out['sections'][] = ['section' => (int)$s->section, 'id' => (int)$s->id, 'name' => get_section_name($course, $s), 'visible' => (bool)$s->visible];
    }
    foreach ($modinfo->cms as $cm) {
        $out['cms'][] = ['cmid' => (int)$cm->id, 'modname' => $cm->modname, 'idnumber' => (string)$cm->idnumber, 'section' => (int)$cm->sectionnum,
            'name' => $cm->name, 'visible' => (bool)$cm->visible, 'url' => $cm->url ? $cm->url->out(false) : null];
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}

if ($action === 'forceclean') {
    $before = (int)($CFG->forceclean ?? 0);
    if (isset($opts['set'])) {
        set_config('forceclean', (int)$opts['set'] ? 1 : 0);
        purge_caches(['muc' => true]);
    }
    echo json_encode(['before' => $before, 'now' => (int)get_config('core', 'forceclean')]), "\n";
    exit(0);
}

if ($action === 'webservice-contents') {
    // La app oficial pide core_course_get_contents; el servidor formatea cada descripción con external_format_text
    // (filtros + limpieza según la configuración del sitio). Se llama a la API externa como el usuario dado.
    $user = $DB->get_record('user', ['username' => $opts['username'], 'deleted' => 0], '*', MUST_EXIST);
    \core\session\manager::set_user($user);
    $sections = \core_course_external::get_course_contents((int)$opts['courseid'], []);
    $sections = \core_external\external_api::clean_returnvalue(\core_course_external::get_course_contents_returns(), $sections);
    $out = [];
    foreach ($sections as $s) {
        foreach ($s['modules'] as $m) {
            $out[] = ['cmid' => (int)$m['id'], 'modname' => $m['modname'], 'section' => (int)$s['section'], 'description' => $m['description'] ?? null,
                'contents' => array_map(fn($c) => ['filename' => $c['filename'] ?? null, 'mimetype' => $c['mimetype'] ?? null, 'filesize' => $c['filesize'] ?? null, 'fileurl' => isset($c['fileurl']) ? 'present' : null], $m['contents'] ?? [])];
        }
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}
fwrite(STDERR, "acción desconocida\n");
exit(2);

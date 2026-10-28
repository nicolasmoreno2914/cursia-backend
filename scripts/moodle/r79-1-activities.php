<?php
// r79.1 · Tipos de Actividad de Aplicación — apoyo CLI (como admin) para un Moodle local DESECHABLE.
//
//   --action=enrol --courseid=<id> --username=<u> --role=student|editingteacher
//                                             matricula al usuario con ese rol (manual)
//   --action=pages --courseid=<id>            JSON: cada página/tarea de Actividad de Aplicación (idnumber cv3:ch:*:application
//                                             y :application_solution): cmid, nombre, visible, visibleold, el HTML que ve el
//                                             estudiante (format_text con los filtros del contexto, como mod/page/view.php),
//                                             y sus PDF (nombre, bytes)
//   --action=access --courseid=<id> --username=<u>
//                                             JSON: por cada una de esas actividades, si el usuario PUEDE verla (cm visible
//                                             para él y mod/page:view o mod/assign:view)
//   --action=app --courseid=<id> --username=<u>
//                                             JSON: lo que recibe la app oficial como ese usuario: mod_page_get_pages_by_courses
//                                             (contenido con external_format_text) y core_course_get_contents (index.html y
//                                             archivos de cada página)
//
// Uso: php -c php.ini r79-1-activities.php --moodle=<raíz de Moodle> --action=… [opciones]
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'action:', 'courseid:', 'username:', 'role:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/externallib.php');
require_once($CFG->dirroot . '/mod/page/lib.php');
global $DB, $USER, $CFG;
\core\session\manager::set_user(get_admin());
$action = $opts['action'] ?? '';

function r791_out($v, $code = 0) { echo json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n"; exit($code); }
function r791_app_cms($course) {
    $out = [];
    foreach (get_fast_modinfo($course)->cms as $cm) {
        if (!preg_match('/^cv3:ch:[^:]+:application(_solution)?$/', (string)$cm->idnumber)) continue;
        $out[] = $cm;
    }
    return $out;
}

if ($action === 'enrol') {
    $courseid = (int)$opts['courseid'];
    $user = $DB->get_record('user', ['username' => $opts['username'], 'deleted' => 0], '*', MUST_EXIST);
    $course = get_course($courseid);
    $plugin = enrol_get_plugin('manual');
    if (!$DB->record_exists('enrol', ['enrol' => 'manual', 'courseid' => $courseid])) $plugin->add_default_instance($course);
    $role = in_array($opts['role'] ?? 'student', ['student', 'editingteacher'], true) ? $opts['role'] : 'student';
    $roleid = (int)$DB->get_field('role', 'id', ['shortname' => $role], MUST_EXIST);
    $ok = enrol_try_internal_enrol($courseid, $user->id, $roleid);
    r791_out(['ok' => (bool)$ok, 'role' => $role, 'enrolled' => is_enrolled(context_course::instance($courseid), $user)], $ok ? 0 : 1);
}

if ($action === 'pages') {
    $course = get_course((int)$opts['courseid']);
    $fs = get_file_storage();
    $out = ['courseid' => (int)$course->id, 'fullname' => $course->fullname, 'activities' => []];
    foreach (r791_app_cms($course) as $cm) {
        $ctx = context_module::instance($cm->id);
        if ($cm->modname === 'page') {
            $page = $DB->get_record('page', ['id' => $cm->instance], '*', MUST_EXIST);
            $raw = file_rewrite_pluginfile_urls($page->content, 'pluginfile.php', $ctx->id, 'mod_page', 'content', $page->revision);
            $html = format_text($raw, $page->contentformat, ['noclean' => true, 'overflowdiv' => true, 'context' => $ctx]);
            $area = ['mod_page', 'content'];
        } else if ($cm->modname === 'assign') {
            $a = $DB->get_record('assign', ['id' => $cm->instance], '*', MUST_EXIST);
            $raw = file_rewrite_pluginfile_urls($a->intro, 'pluginfile.php', $ctx->id, 'mod_assign', 'intro', null);
            $html = format_text($raw, $a->introformat, ['noclean' => false, 'context' => $ctx]);
            $area = ['mod_assign', 'intro'];
        } else continue;
        $files = [];
        foreach ($fs->get_area_files($ctx->id, $area[0], $area[1], false, 'filename', false) as $f) $files[] = ['filename' => $f->get_filename(), 'bytes' => (int)$f->get_filesize(), 'mimetype' => $f->get_mimetype()];
        $row = $DB->get_record('course_modules', ['id' => $cm->id], 'visible, visibleold', MUST_EXIST);
        $out['activities'][] = ['cmid' => (int)$cm->id, 'modname' => $cm->modname, 'idnumber' => (string)$cm->idnumber, 'name' => $cm->name,
            'visible' => (int)$row->visible, 'visibleold' => (int)$row->visibleold, 'section' => (int)$cm->sectionnum, 'html' => $html, 'files' => $files,
            'url' => $cm->url ? $cm->url->out(false) : null];
    }
    r791_out($out);
}

if ($action === 'access') {
    $course = get_course((int)$opts['courseid']);
    $user = $DB->get_record('user', ['username' => $opts['username'], 'deleted' => 0], '*', MUST_EXIST);
    $modinfo = get_fast_modinfo($course, $user->id);
    $out = [];
    foreach (r791_app_cms($course) as $cm0) {
        $cm = $modinfo->get_cm($cm0->id);
        $ctx = context_module::instance($cm->id);
        $cap = $cm->modname === 'assign' ? 'mod/assign:view' : 'mod/page:view';
        $out[] = ['cmid' => (int)$cm->id, 'idnumber' => (string)$cm->idnumber, 'uservisible' => (bool)$cm->uservisible, 'capability' => has_capability($cap, $ctx, $user)];
    }
    r791_out($out);
}

if ($action === 'app') {
    $user = $DB->get_record('user', ['username' => $opts['username'], 'deleted' => 0], '*', MUST_EXIST);
    \core\session\manager::set_user($user);
    $courseid = (int)$opts['courseid'];
    $pages = \mod_page_external::get_pages_by_courses([$courseid]);
    $pages = \core_external\external_api::clean_returnvalue(\mod_page_external::get_pages_by_courses_returns(), $pages);
    $contents = \core_course_external::get_course_contents($courseid, []);
    $contents = \core_external\external_api::clean_returnvalue(\core_course_external::get_course_contents_returns(), $contents);
    $byCm = [];
    foreach ($contents as $s) foreach ($s['modules'] as $m) $byCm[(int)$m['id']] = ['modname' => $m['modname'], 'description' => $m['description'] ?? null, 'files' => array_map(fn($c) => $c['filename'] ?? null, $m['contents'] ?? [])];
    $out = ['pages' => [], 'modules' => $byCm];
    foreach ($pages['pages'] as $p) $out['pages'][] = ['coursemodule' => (int)$p['coursemodule'], 'name' => $p['name'], 'content' => $p['content']];
    r791_out($out);
}
fwrite(STDERR, "acción desconocida\n");
exit(2);

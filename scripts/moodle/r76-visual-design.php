<?php
// r76 «Diseño visual» — restauración y lectura del diseño en un Moodle local desechable (CLI, como admin).
//
//   --action=restore-new --file=<x.mbz> --categoryid=<id>   restaura como curso NUEVO → «Course ID: N»
//   --action=labels      --courseid=<id>                    JSON: por actividad (label / page / resource / quiz / scorm) su
//                                                            idnumber, el HTML GUARDADO en la base, el HTML que ve el
//                                                            estudiante (format_text con los filtros del contexto, igual que
//                                                            la página del curso) y los archivos del contexto (sha1
//                                                            recalculado del archivo en disco)
//   --action=delete      --courseid=<id> --title=<prefijo>  borra el curso de prueba (solo si el nombre empieza así)
// Uso: php -c php.ini r76-visual-design.php --moodle=<raíz de Moodle> --action=… [opciones]
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'action:', 'file:', 'categoryid:', 'courseid:', 'title:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->dirroot . '/course/lib.php');
global $DB, $USER, $CFG;
$admin = get_admin();
\core\session\manager::set_user($admin);
$action = $opts['action'] ?? '';

if ($action === 'restore-new') {
    $category = $DB->get_record('course_categories', ['id' => (int)$opts['categoryid']], 'id', MUST_EXIST);
    if (!file_exists($opts['file'])) throw new \moodle_exception('filenotfound');
    $backupdir = restore_controller::get_tempdir_name(SITEID, $USER->id);
    $path = make_backup_temp_directory($backupdir);
    get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($opts['file'], $path);
    list($fullname, $shortname) = restore_dbops::calculate_course_names(0, get_string('restoringcourse', 'backup'), get_string('restoringcourseshortname', 'backup'));
    $courseid = restore_dbops::create_new_course($fullname, $shortname, $category->id);
    $rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_NEW_COURSE);
    $rc->execute_precheck();
    $rc->execute_plan();
    $rc->destroy();
    echo "Course ID: {$courseid}\n";
    exit(0);
}

if ($action === 'labels') {
    $courseid = (int)$opts['courseid'];
    $course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);
    $modinfo = get_fast_modinfo($course);
    $fs = get_file_storage();
    $out = ['courseid' => $courseid, 'fullname' => $course->fullname, 'activities' => []];
    $areas = ['label' => ['label', 'intro', 'mod_label', 'intro'], 'page' => ['page', 'content', 'mod_page', 'content'],
        'resource' => ['resource', 'intro', 'mod_resource', 'intro'], 'quiz' => ['quiz', 'intro', 'mod_quiz', 'intro'], 'scorm' => ['scorm', 'intro', 'mod_scorm', 'intro']];
    foreach ($modinfo->cms as $cm) {
        if (!isset($areas[$cm->modname])) continue;
        list($table, $field, $component, $filearea) = $areas[$cm->modname];
        $raw = (string)$DB->get_field($table, $field, ['id' => $cm->instance]);
        $ctx = context_module::instance($cm->id);
        $html = file_rewrite_pluginfile_urls($raw, 'pluginfile.php', $ctx->id, $component, $filearea, $cm->modname === 'page' ? 0 : null);
        // Lo mismo que hace la página del curso para la intro de un label (format_module_intro → format_text, noclean=false).
        $rendered = format_text($html, FORMAT_HTML, ['context' => $ctx, 'noclean' => false, 'overflowdiv' => false]);
        $files = [];
        foreach ($fs->get_area_files($ctx->id, $component, $cm->modname === 'resource' ? 'content' : $filearea, false, 'filename', false) as $f) {
            $c = $f->get_content();
            $files[] = ['filename' => $f->get_filename(), 'mimetype' => $f->get_mimetype(), 'bytes' => strlen($c), 'sha1' => sha1($c), 'contenthash' => $f->get_contenthash()];
        }
        if ($cm->modname === 'resource') {
            foreach ($fs->get_area_files($ctx->id, $component, 'intro', false, 'filename', false) as $f) {
                $c = $f->get_content();
                $files[] = ['filename' => $f->get_filename(), 'mimetype' => $f->get_mimetype(), 'bytes' => strlen($c), 'sha1' => sha1($c), 'contenthash' => $f->get_contenthash()];
            }
        }
        $out['activities'][] = ['cmid' => (int)$cm->id, 'modname' => $cm->modname, 'idnumber' => (string)$cm->idnumber, 'section' => (int)$cm->sectionnum,
            'name' => $cm->name, 'stored' => $raw, 'rendered' => $rendered, 'files' => $files];
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}

if ($action === 'delete') {
    $c = $DB->get_record('course', ['id' => (int)$opts['courseid']]);
    $title = $opts['title'] ?? '';
    if ($c && strlen($title) >= 10 && strpos($c->fullname, $title) === 0) { ob_start(); delete_course($c->id, false); ob_end_clean(); }
    echo json_encode(['courseid' => (int)$opts['courseid'], 'deleted' => !$DB->record_exists('course', ['id' => (int)$opts['courseid']])]), "\n";
    exit(0);
}
fwrite(STDERR, "acción desconocida\n");
exit(2);

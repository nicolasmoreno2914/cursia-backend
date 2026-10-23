<?php
// E2E Fase 9 — restaura un .mbz en el Moodle 4.5 local (curso nuevo, categoría 1)
// capturando el resultado del PRECHECK (warnings/errors), y vuelca desde la DB
// de Moodle la estructura restaurada con el texto de cada actividad (label.intro,
// url.externalurl, preguntas del quiz, archivos de contenido del scorm/resource)
// para que el driver haga las aserciones por UUID (marcadores MARK*-<uuid>).
// Uso: php -c php.ini moodle-restore-inspect.php <file.mbz> <out.json>
define('CLI_SCRIPT', 1);
$MOODLE = getenv('MOODLE_ROOT');
require($MOODLE . '/config.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');

$file = $argv[1];
$out = $argv[2];
global $DB, $USER;
$admin = get_admin();
\core\session\manager::set_user($admin);

$backupdir = restore_controller::get_tempdir_name(SITEID, $admin->id);
$path = make_backup_temp_directory($backupdir);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($file, $path);
list($fullname, $shortname) = restore_dbops::calculate_course_names(0, 'E2E restore', 'E2E');
$courseid = restore_dbops::create_new_course($fullname, $shortname, 1);
$rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_NEW_COURSE);
$precheckok = $rc->execute_precheck();
$pre = $rc->get_precheck_results();
$status = null;
$error = null;
try {
    $rc->execute_plan();
    $status = $rc->get_status();
} catch (Throwable $e) {
    $error = get_class($e) . ': ' . $e->getMessage();
}
$rc->destroy();

$fs = get_file_storage();
$res = [
    'courseid' => (int)$courseid,
    'precheck_ok' => (bool)$precheckok,
    'precheck_warnings' => array_values($pre['warnings'] ?? []),
    'precheck_errors' => array_values($pre['errors'] ?? []),
    'restore_error' => $error,
    'sections' => [],
];
$course = $DB->get_record('course', ['id' => $courseid]);
$res['fullname'] = $course->fullname;
$res['moodle_release'] = $CFG->release;
$sections = $DB->get_records('course_sections', ['course' => $courseid], 'section ASC');
foreach ($sections as $s) {
    $sd = ['section' => (int)$s->section, 'name' => $s->name, 'activities' => []];
    $seq = trim((string)$s->sequence);
    foreach (($seq === '' ? [] : explode(',', $seq)) as $cmid) {
        $cm = $DB->get_record('course_modules', ['id' => (int)$cmid]);
        if (!$cm) { $sd['activities'][] = ['cmid' => (int)$cmid, 'modname' => null, 'error' => 'orphan']; continue; }
        $modname = $DB->get_field('modules', 'name', ['id' => $cm->module]);
        $inst = $DB->get_record($modname, ['id' => $cm->instance]);
        $ctx = context_module::instance($cm->id);
        $text = '';
        $extra = [];
        if (isset($inst->intro)) $text .= $inst->intro . "\n";
        if ($modname === 'url') { $extra['externalurl'] = $inst->externalurl; $text .= $inst->externalurl . "\n"; }
        if ($modname === 'quiz') {
            $qs = $DB->get_records_sql(
                "SELECT qv.id, q.name, q.questiontext, q.qtype FROM {quiz_slots} s
                   JOIN {question_references} qr ON qr.itemid = s.id AND qr.component = 'mod_quiz' AND qr.questionarea = 'slot'
                   JOIN {question_versions} qv ON qv.questionbankentryid = qr.questionbankentryid
                   JOIN {question} q ON q.id = qv.questionid
                  WHERE s.quizid = ?", [$inst->id]);
            $extra['question_count'] = count($qs);
            foreach ($qs as $q) $text .= $q->name . ' ' . $q->questiontext . "\n";
        }
        if ($modname === 'scorm' || $modname === 'resource') {
            $component = 'mod_' . $modname;
            $files = [];
            foreach ($fs->get_area_files($ctx->id, $component, 'content', false, 'filepath, filename', false) as $f) {
                $fn = $f->get_filepath() . $f->get_filename();
                $files[] = $fn;
                if (preg_match('/\.(html?|xml|js|json|txt|css)$/i', $fn)) $text .= $f->get_content() . "\n";
            }
            $extra['content_files'] = $files;
            if ($modname === 'scorm') {
                $extra['sco_count'] = $DB->count_records('scorm_scoes', ['scorm' => $inst->id, 'scormtype' => 'sco']);
            }
        }
        $sd['activities'][] = ['cmid' => (int)$cm->id, 'modname' => $modname, 'name' => $inst->name ?? null, 'visible' => (int)$cm->visible,
            'text' => $text, 'extra' => $extra];
    }
    $res['sections'][] = $sd;
}
file_put_contents($out, json_encode($res, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
echo "OK course=$courseid warnings=" . count($res['precheck_warnings']) . " errors=" . count($res['precheck_errors']) . "\n";

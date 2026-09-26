<?php
// Cursia V2.1 / R8 — utilidades CLI para verificar el video interactivo en un
// Moodle LOCAL desechable. Nunca borra datos ni cambia la configuración del sitio.
//
//   php v21-video-moodle.php <moodleDir> restore <file.mbz>
//       Restaura el .mbz en un curso NUEVO (categoría 1) como admin y devuelve
//       JSON: precheck (errors/warnings), warnings del log de restore, cm,
//       intro crudo y formateado, archivos de los fileareas package/intro,
//       grade item y ajustes de completion.
//   php v21-video-moodle.php <moodleDir> enrol <courseid> <username>
//       Matricula a un usuario EXISTENTE como estudiante (instancia manual).
//   php v21-video-moodle.php <moodleDir> state <courseid> <cmid> <username>
//       Intentos, resultados (subcontent), nota y estado de completion.
//
// Siempre imprime una sola línea "RESULT_JSON {…}".
define('CLI_SCRIPT', 1);
if (empty($argv[1]) || empty($argv[2]) || !is_file(rtrim($argv[1], '/') . '/config.php')) {
    fwrite(STDERR, "usage: php v21-video-moodle.php <moodleDir> restore|enrol|state …\n");
    exit(2);
}
require(rtrim($argv[1], '/') . '/config.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/enrollib.php');

\core\session\manager::set_user(get_admin());
$cmd = $argv[2];
$out = [];

function v21v_out(array $out, int $code = 0): void {
    echo 'RESULT_JSON ' . json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";
    exit($code);
}

if ($cmd === 'restore') {
    $mbz = $argv[3] ?? '';
    if (!is_file($mbz)) {
        v21v_out(['error' => "no existe $mbz"], 2);
    }
    $admin = get_admin();
    $backupdir = restore_controller::get_tempdir_name(SITEID, $admin->id);
    $path = make_backup_temp_directory($backupdir);
    get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($mbz, $path);
    [$fullname, $shortname] = restore_dbops::calculate_course_names(0, 'Cursia V2.1 R8 video', 'v21r8-video');
    $courseid = restore_dbops::create_new_course($fullname, $shortname, 1);
    $rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id,
        backup::TARGET_NEW_COURSE);
    $restoreid = $rc->get_restoreid();
    $precheckok = $rc->execute_precheck(true);
    $precheck = $rc->get_precheck_results();
    if (!$precheckok && !empty($precheck['errors'])) {
        $rc->destroy();
        v21v_out(['courseid' => (int)$courseid, 'precheck' => $precheck, 'error' => 'precheck con errores'], 1);
    }
    $rc->execute_plan();
    $rc->destroy();

    $logs = $DB->get_records_select('backup_logs', 'backupid = ? AND loglevel <= ?', [$restoreid, backup::LOG_WARNING],
        'id', 'id,loglevel,message');
    $out['courseid'] = (int)$courseid;
    $out['precheck'] = ['errors' => array_values($precheck['errors'] ?? []), 'warnings' => array_values($precheck['warnings'] ?? [])];
    $out['logWarnings'] = array_values(array_map(fn($l) => ['level' => (int)$l->loglevel, 'message' => trim($l->message)], $logs));

    $course = get_course($courseid);
    $modinfo = get_fast_modinfo($course);
    $cms = array_values(array_filter($modinfo->get_cms(), fn($cm) => $cm->modname === 'h5pactivity'));
    $out['h5pactivityCount'] = count($cms);
    if (count($cms) !== 1) {
        v21v_out($out, 1);
    }
    $cm = $cms[0];
    $ctx = context_module::instance($cm->id);
    $rec = $DB->get_record('h5pactivity', ['id' => $cm->instance], '*', MUST_EXIST);
    $cmrec = $DB->get_record('course_modules', ['id' => $cm->id], '*', MUST_EXIST);
    $out['cmid'] = (int)$cm->id;
    $out['instance'] = (int)$cm->instance;
    $out['contextid'] = (int)$ctx->id;
    $out['sectionnum'] = (int)$cm->sectionnum;
    $out['h5pactivity'] = ['name' => $rec->name, 'grade' => (int)$rec->grade, 'grademethod' => (int)$rec->grademethod,
        'enabletracking' => (int)$rec->enabletracking, 'introformat' => (int)$rec->introformat];
    $out['cm'] = ['completion' => (int)$cmrec->completion, 'completionpassgrade' => (int)$cmrec->completionpassgrade,
        'completiongradeitemnumber' => $cmrec->completiongradeitemnumber === null ? null : (int)$cmrec->completiongradeitemnumber,
        'showdescription' => (int)$cmrec->showdescription, 'visible' => (int)$cmrec->visible];
    $out['introRaw'] = $rec->intro;
    $out['introFormatted'] = format_module_intro('h5pactivity', $rec, $cm->id);
    $out['wwwroot'] = $CFG->wwwroot;
    $files = [];
    foreach (['package', 'intro'] as $area) {
        foreach (get_file_storage()->get_area_files($ctx->id, 'mod_h5pactivity', $area, false, 'filename', false) as $f) {
            $files[] = ['filearea' => $area, 'filename' => $f->get_filename(), 'contenthash' => $f->get_contenthash(),
                'filesize' => (int)$f->get_filesize(), 'mimetype' => $f->get_mimetype()];
        }
    }
    $out['files'] = $files;
    $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'h5pactivity',
        'iteminstance' => $cm->instance, 'itemnumber' => 0]);
    $out['gradeItem'] = $gi ? ['grademax' => (float)$gi->grademax, 'gradepass' => (float)$gi->gradepass] : null;
    v21v_out($out);
}

if ($cmd === 'enrol') {
    $courseid = (int)($argv[3] ?? 0);
    $username = $argv[4] ?? '';
    $user = $DB->get_record('user', ['username' => $username, 'deleted' => 0]);
    if (!$user) {
        v21v_out(['error' => "no existe el usuario $username"], 1);
    }
    $course = get_course($courseid);
    $plugin = enrol_get_plugin('manual');
    if (!$DB->record_exists('enrol', ['enrol' => 'manual', 'courseid' => $courseid])) {
        $plugin->add_default_instance($course);
    }
    $roleid = (int)$DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
    $ok = enrol_try_internal_enrol($courseid, $user->id, $roleid);
    v21v_out(['ok' => (bool)$ok, 'userid' => (int)$user->id, 'enrolled' => is_enrolled(context_course::instance($courseid), $user)],
        $ok ? 0 : 1);
}

if ($cmd === 'state') {
    $courseid = (int)($argv[3] ?? 0);
    $cmid = (int)($argv[4] ?? 0);
    $user = $DB->get_record('user', ['username' => $argv[5] ?? '', 'deleted' => 0], '*', MUST_EXIST);
    $course = get_course($courseid);
    $cm = get_fast_modinfo($course, $user->id)->get_cm($cmid);
    $g = grade_get_grades($course->id, 'mod', 'h5pactivity', $cm->instance, $user->id);
    $item = $g->items[0] ?? null;
    $grade = $item ? ($item->grades[$user->id]->grade ?? null) : null;
    $cinfo = new completion_info($course);
    $state = $cinfo->get_data($cm, false, $user->id)->completionstate;
    $names = [COMPLETION_INCOMPLETE => 'INCOMPLETE', COMPLETION_COMPLETE => 'COMPLETE',
        COMPLETION_COMPLETE_PASS => 'COMPLETE_PASS', COMPLETION_COMPLETE_FAIL => 'COMPLETE_FAIL'];
    $atts = $DB->get_records('h5pactivity_attempts', ['h5pactivityid' => $cm->instance, 'userid' => $user->id], 'attempt',
        'id,attempt,rawscore,maxscore,scaled,completion,success');
    $results = [];
    foreach ($atts as $a) {
        $results[] = ['attempt' => (int)$a->attempt, 'rows' => array_values(array_map(fn($r) => [
            'subcontent' => $r->subcontent, 'rawscore' => (float)$r->rawscore, 'maxscore' => (float)$r->maxscore,
            'success' => $r->success === null ? null : (int)$r->success, 'interactiontype' => $r->interactiontype,
        ], $DB->get_records('h5pactivity_attempts_results', ['attemptid' => $a->id], 'id')))];
    }
    v21v_out([
        'grade' => $grade === null ? null : (float)$grade,
        'grademax' => $item ? (float)$item->grademax : null,
        'gradepass' => $item ? (float)$item->gradepass : null,
        'completion' => $names[$state] ?? $state,
        'attempts' => array_values(array_map(fn($a) => ['attempt' => (int)$a->attempt, 'rawscore' => (float)$a->rawscore,
            'maxscore' => (float)$a->maxscore, 'scaled' => (float)$a->scaled, 'completion' => $a->completion === null ? null : (int)$a->completion,
            'success' => $a->success === null ? null : (int)$a->success], $atts)),
        'results' => $results,
    ]);
}

v21v_out(['error' => "comando desconocido $cmd"], 2);

<?php
// Cursia V2.1 — R6: inspección + simulación de notas sobre un curso YA
// restaurado (por restore-and-inspect.sh) en el Moodle 4.5 local desechable.
// Solo AGREGA datos (usuarios de prueba, matrículas, notas, tracks SCORM).
// No borra nada ni cambia configuración del sitio.
//
// Uso: php -c php.ini v21-assessment-inspect.php <input.json> <output.json>
//   input: { moodleRoot, courseid, mbz, grades: { pass: {cmName: grade}, fail: {cmName: grade|null} } }
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/mod/scorm/locallib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');
require_once($CFG->dirroot . '/completion/completion_criteria_completion.php');

global $DB, $CFG;
$admin = get_admin();
\core\session\manager::set_user($admin);
$courseid = (int)$in['courseid'];
$course = get_course($courseid);
$out = ['courseid' => $courseid, 'enablecompletion' => (int)$course->enablecompletion];

// ── 1. Warnings del restore ya hecho (file logger del controller, nivel WARNING) ──
$rc = $DB->get_record_sql("SELECT backupid, status FROM {backup_controllers}
    WHERE operation = 'restore' AND type = 'course' AND itemid = ? ORDER BY id DESC", [$courseid], IGNORE_MULTIPLE);
$out['restoreStatus'] = $rc ? (int)$rc->status : null;
$logfile = $rc ? make_backup_temp_directory('', false) . '/' . $rc->backupid . '.log' : null;
$out['restoreLogFound'] = $logfile && file_exists($logfile);
$out['restoreLogLines'] = $out['restoreLogFound']
    ? array_values(array_filter(array_map('trim', file($logfile)), 'strlen')) : null;
$out['restoreDbLogWarnings'] = $rc ? array_values($DB->get_fieldset_select('backup_logs', 'message',
    'backupid = ? AND loglevel <= ?', [$rc->backupid, backup::LOG_WARNING])) : null;

// ── 2. Precheck del mismo .mbz (sin ejecutar el plan: no escribe nada) ──
$tmp = restore_controller::get_tempdir_name(SITEID, $admin->id);
$path = make_backup_temp_directory($tmp);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($in['mbz'], $path);
$prc = new restore_controller($tmp, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id,
    backup::TARGET_EXISTING_ADDING);
$prc->execute_precheck(true);
$pre = $prc->get_precheck_results();
$prc->destroy();
fulldelete($path);
$out['precheck'] = ['warnings' => array_values($pre['warnings'] ?? []), 'errors' => array_values($pre['errors'] ?? [])];

// ── 3. Estructura restaurada ──
$modinfo = get_fast_modinfo($course);
$cms = [];
foreach ($modinfo->get_cms() as $cm) {
    $row = $DB->get_record('course_modules', ['id' => $cm->id]);
    $cms[$cm->name] = [
        'cmid' => (int)$cm->id, 'modname' => $cm->modname, 'instance' => (int)$cm->instance,
        'completion' => (int)$row->completion, 'completiongradeitemnumber' => $row->completiongradeitemnumber,
        'completionpassgrade' => (int)$row->completionpassgrade, 'completionview' => (int)$row->completionview,
        'showdescription' => (int)$row->showdescription,
    ];
}
$out['cms'] = $cms;

$cats = [];
foreach (grade_category::fetch_all(['courseid' => $courseid]) as $c) {
    $ci = $c->load_grade_item();
    $cats[] = ['id' => (int)$c->id, 'fullname' => $c->fullname, 'depth' => (int)$c->depth,
        'aggregation' => (int)$c->aggregation, 'aggregateonlygraded' => (int)$c->aggregateonlygraded,
        'itemAggregationcoef' => (float)$ci->aggregationcoef, 'itemGradepass' => (float)$ci->gradepass];
}
usort($cats, fn($a, $b) => $a['id'] <=> $b['id']);
$out['categories'] = $cats;
$catname = [];
foreach ($cats as $c) { $catname[$c['id']] = $c['fullname']; }

$items = [];
foreach (grade_item::fetch_all(['courseid' => $courseid, 'itemtype' => 'mod']) as $gi) {
    $items[$gi->itemname] = ['itemmodule' => $gi->itemmodule, 'category' => $catname[$gi->categoryid] ?? null,
        'gradepass' => (float)$gi->gradepass, 'grademax' => (float)$gi->grademax, 'grademin' => (float)$gi->grademin];
}
$out['items'] = $items;
$courseitem = grade_item::fetch_course_item($courseid);
$out['courseItem'] = ['gradepass' => (float)$courseitem->gradepass, 'grademax' => (float)$courseitem->grademax];

$out['quizzes'] = [];
foreach ($DB->get_records('quiz', ['course' => $courseid]) as $q) {
    $out['quizzes'][$q->name] = ['attempts' => (int)$q->attempts, 'grademethod' => (int)$q->grademethod,
        'sumgrades' => (float)$q->sumgrades, 'grade' => (float)$q->grade, 'preferredbehaviour' => $q->preferredbehaviour,
        'slots' => $DB->count_records('quiz_slots', ['quizid' => $q->id])];
}
$out['scorms'] = [];
foreach ($DB->get_records('scorm', ['course' => $courseid]) as $s) {
    $out['scorms'][$s->name] = ['maxgrade' => (float)$s->maxgrade, 'grademethod' => (int)$s->grademethod,
        'whatgrade' => (int)$s->whatgrade, 'maxattempt' => (int)$s->maxattempt, 'masteryoverride' => (int)$s->masteryoverride,
        'completionstatusrequired' => $s->completionstatusrequired, 'completionscorerequired' => $s->completionscorerequired];
}
$fs = get_file_storage();
$out['h5ps'] = [];
foreach ($DB->get_records('h5pactivity', ['course' => $courseid]) as $h) {
    $cm = get_coursemodule_from_instance('h5pactivity', $h->id, $courseid);
    $files = $fs->get_area_files(context_module::instance($cm->id)->id, 'mod_h5pactivity', 'package', 0, 'id', false);
    $out['h5ps'][$h->name] = ['grade' => (int)$h->grade, 'grademethod' => (int)$h->grademethod,
        'enabletracking' => (int)$h->enabletracking, 'reviewmode' => (int)$h->reviewmode,
        'displayoptions' => (int)$h->displayoptions, 'packageFiles' => array_values(array_map(fn($f) => $f->get_filename(), $files))];
}

$cmname = [];
foreach ($cms as $n => $c) { $cmname[$c['cmid']] = $n; }
$out['criteria'] = [];
foreach ($DB->get_records('course_completion_criteria', ['course' => $courseid], 'id') as $cr) {
    $out['criteria'][] = ['criteriatype' => (int)$cr->criteriatype, 'module' => $cr->module,
        'cmName' => $cr->moduleinstance ? ($cmname[(int)$cr->moduleinstance] ?? 'UNKNOWN_CM') : null,
        'gradepass' => $cr->gradepass === null ? null : (float)$cr->gradepass];
}
$out['aggr'] = array_values(array_map(fn($a) => ['criteriatype' => $a->criteriatype === null ? null : (int)$a->criteriatype,
    'method' => (int)$a->method], $DB->get_records('course_completion_aggr_methd', ['course' => $courseid], 'id')));

// ── 4. Simulación de notas (API de módulo para SCORM; grade_update para quiz y h5pactivity) ──
$roles = $DB->get_records_menu('role', null, '', 'shortname,id');
$users = [];
foreach (['pass', 'fail'] as $k) {
    $uname = 'r6assess' . $k;
    $u = $DB->get_record('user', ['username' => $uname]);
    if (!$u) {
        $u = (object)['username' => $uname, 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id,
            'firstname' => 'R6', 'lastname' => $k, 'email' => $uname . '@example.invalid', 'password' => ''];
        $u->id = $DB->insert_record('user', $u);
    }
    enrol_try_internal_enrol($courseid, $u->id, $roles['student']);
    $users[$k] = $u;
}
foreach ($in['grades'] as $k => $plan) {
    $u = $users[$k];
    foreach ($plan as $name => $g) {
        if ($g === null) continue;
        $c = $cms[$name];
        if ($c['modname'] === 'scorm') {
            $scorm = $DB->get_record('scorm', ['id' => $c['instance']]);
            $sco = $DB->get_record_select('scorm_scoes', 'scorm = ? AND launch <> ?', [$scorm->id, '']);
            \core\session\manager::set_user($u);
            scorm_insert_track($u->id, $scorm->id, $sco->id, 1, 'cmi.core.score.raw', (string)$g);
            scorm_insert_track($u->id, $scorm->id, $sco->id, 1, 'cmi.core.lesson_status', 'completed');
            \core\session\manager::set_user($admin);
            scorm_update_grades($scorm, $u->id);
        } else {
            $r = grade_update('mod/' . $c['modname'], $courseid, 'mod', $c['modname'], $c['instance'], 0,
                ['userid' => $u->id, 'rawgrade' => $g]);
            if ($r !== GRADE_UPDATE_OK) throw new Exception("grade_update falló para $name");
        }
    }
}
grade_regrade_final_grades($courseid);
$ci = new completion_info($course);
$modinfo = get_fast_modinfo($course);
$out['sim'] = [];
foreach ($users as $k => $u) {
    $states = [];
    $grades = [];
    foreach ($cms as $name => $c) {
        if (!in_array($c['modname'], ['quiz', 'scorm', 'h5pactivity'])) continue;
        $cm = get_fast_modinfo($course, $u->id)->get_cm($c['cmid']);
        $states[$name] = (int)$ci->get_data($cm, false, $u->id)->completionstate;
        $gg = grade_get_grades($courseid, 'mod', $c['modname'], $c['instance'], $u->id);
        $grades[$name] = $gg->items[0]->grades[$u->id]->grade === null ? null : (float)$gg->items[0]->grades[$u->id]->grade;
    }
    $cf = $courseitem->get_final($u->id);
    // Criterios de completion del curso → revisar y agregar (lo que hace el cron, solo para este usuario/curso).
    foreach ($ci->get_criteria() as $criterion) {
        $ccc = new completion_criteria_completion(['course' => $courseid, 'userid' => $u->id, 'criteriaid' => $criterion->id]);
        $criterion->review($ccc);
    }
    $ccid = $DB->get_field('course_completions', 'id', ['course' => $courseid, 'userid' => $u->id]);
    if ($ccid) aggregate_completions((int)$ccid);
    $out['sim'][$k] = ['states' => $states, 'grades' => $grades,
        'courseTotal' => $cf && $cf->finalgrade !== null ? (float)$cf->finalgrade : null,
        'courseComplete' => $ci->is_course_complete($u->id)];
}
file_put_contents($argv[2], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

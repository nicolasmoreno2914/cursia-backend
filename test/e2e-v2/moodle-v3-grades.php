<?php
// V2.1 R13 — simulación de notas en un curso v3 YA restaurado (Moodle 4.5 local
// desechable), por la API de Moodle (mismo método que R6): grade_update para
// quiz y h5pactivity; pistas SCORM 1.2 + scorm_update_grades para SCORM. Usa
// usuarios de prueba locales r13grade{pass,fail,mixed} (se crean si no
// existen; nunca se borra nada). Luego revisa completion por ítem y del curso.
// EV6 P2-B5: también la disponibilidad (para cada usuario) de cada página «Respuestas explicadas»
// (`pages`: idnumber → { quiz, available, uservisible }). Con notas escritas un quiz reprobado queda
// INCOMPLETE (sin intentos agotados) → su página sigue bloqueada; aprobado → disponible. Los intentos
// REALES (revisión, agotar, ilimitados, curso) los cubre moodle-p2-exams.php.
// Uso: php -c php.ini moodle-v3-grades.php <input.json> <output.json>
//   input: { moodleRoot, courseid, grades: { pass|fail|mixed: { <idnumber cv3:…>: nota } } }
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->dirroot . '/mod/scorm/locallib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');
require_once($CFG->dirroot . '/completion/completion_criteria_completion.php');

global $DB, $CFG;
$admin = get_admin();
\core\session\manager::set_user($admin);
$courseid = (int)$in['courseid'];
$course = get_course($courseid);
$cms = [];
foreach ($DB->get_records_sql("SELECT cm.id, cm.idnumber, cm.instance, m.name AS modname FROM {course_modules} cm
    JOIN {modules} m ON m.id = cm.module WHERE cm.course = ?", [$courseid]) as $r) {
    if ($r->idnumber) $cms[$r->idnumber] = ['cmid' => (int)$r->id, 'instance' => (int)$r->instance, 'modname' => $r->modname];
}
$roles = $DB->get_records_menu('role', null, '', 'shortname,id');
$users = [];
foreach (array_keys($in['grades']) as $k) {
    $uname = 'r13grade' . $k;
    $u = $DB->get_record('user', ['username' => $uname]);
    if (!$u) {
        $u = (object)['username' => $uname, 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id,
            'firstname' => 'R13', 'lastname' => $k, 'email' => $uname . '@example.invalid', 'password' => ''];
        $u->id = $DB->insert_record('user', $u);
    }
    enrol_try_internal_enrol($courseid, $u->id, $roles['student']);
    $users[$k] = $u;
}
foreach ($in['grades'] as $k => $plan) {
    $u = $users[$k];
    foreach ($plan as $idn => $g) {
        $c = $cms[$idn] ?? null;
        if (!$c) throw new Exception("idnumber desconocido: $idn");
        if ($c['modname'] === 'scorm') {
            $scorm = $DB->get_record('scorm', ['id' => $c['instance']]);
            $sco = $DB->get_record_select('scorm_scoes', 'scorm = ? AND launch <> ?', [$scorm->id, ''], '*', IGNORE_MULTIPLE);
            \core\session\manager::set_user($u);
            scorm_insert_track($u->id, $scorm->id, $sco->id, 1, 'cmi.core.score.raw', (string)$g);
            scorm_insert_track($u->id, $scorm->id, $sco->id, 1, 'cmi.core.lesson_status', 'completed');
            \core\session\manager::set_user($admin);
            scorm_update_grades($scorm, $u->id);
        } else {
            $r = grade_update('mod/' . $c['modname'], $courseid, 'mod', $c['modname'], $c['instance'], 0, ['userid' => $u->id, 'rawgrade' => $g]);
            if ($r !== GRADE_UPDATE_OK) throw new Exception("grade_update falló para $idn");
        }
    }
}
grade_regrade_final_grades($courseid);
$courseitem = grade_item::fetch_course_item($courseid);
$ci = new completion_info($course);
$out = ['courseid' => $courseid, 'sim' => []];
foreach ($users as $k => $u) {
    $states = [];
    $grades = [];
    foreach ($in['grades'][$k] as $idn => $g) {
        $c = $cms[$idn];
        $cm = get_fast_modinfo($course, $u->id)->get_cm($c['cmid']);
        $states[$idn] = (int)$ci->get_data($cm, false, $u->id)->completionstate;
        $gg = grade_get_grades($courseid, 'mod', $c['modname'], $c['instance'], $u->id);
        $grades[$idn] = $gg->items[0]->grades[$u->id]->grade === null ? null : (float)$gg->items[0]->grades[$u->id]->grade;
    }
    $cf = $courseitem->get_final($u->id);
    foreach ($ci->get_criteria() as $criterion) {
        $ccc = new completion_criteria_completion(['course' => $courseid, 'userid' => $u->id, 'criteriaid' => $criterion->id]);
        $criterion->review($ccc);
    }
    $ccid = $DB->get_field('course_completions', 'id', ['course' => $courseid, 'userid' => $u->id]);
    if ($ccid) aggregate_completions((int)$ccid);
    $pages = [];
    get_fast_modinfo($courseid, 0, true);
    $mi = get_fast_modinfo($course, $u->id);
    foreach ($cms as $idn => $c) {
        if ($c['modname'] !== 'page' || !preg_match('/^cv3:(exam_explanations:(.+)|final_exam_explanations)$/', $idn, $m)) continue;
        $pcm = $mi->get_cm($c['cmid']);
        $pages[$idn] = ['quiz' => isset($m[2]) ? 'cv3:exam:' . $m[2] : 'cv3:final_exam', 'available' => (bool)$pcm->available, 'uservisible' => (bool)$pcm->uservisible];
    }
    $out['sim'][$k] = ['states' => $states, 'grades' => $grades, 'pages' => $pages,
        'courseTotal' => $cf && $cf->finalgrade !== null ? (float)$cf->finalgrade : null,
        'courseComplete' => $ci->is_course_complete($u->id)];
}
file_put_contents($argv[2], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
echo "OK\n";

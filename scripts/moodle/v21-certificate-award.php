<?php
// Cursia EV6 (T3): prueba de que la insignia-certificado de un curso YA restaurado se otorga sola
// al completar el curso, en el Moodle 4.5 LOCAL desechable. Pasos (lo que haría el gestor + un
// estudiante, sin atajos en la parte de la insignia):
//   1. «Habilitar acceso» a la insignia (core la restaura SIEMPRE inactiva);
//   2. crea un usuario de prueba y lo matricula como estudiante (enrol manual);
//   3. r55 (R3): todos los ítems calificables por DEBAJO de la nota mínima del curso (nota REAL en su grade_item) y
//      la tarea real de completion ×2 (\core\task\completion_regular_task): nota final < mínimo → sin curso completo
//      ni insignia;
//   4. todo a 100 salvo la evaluación final REPROBADA: nota final ≥ mínimo → curso completo (un ítem bajo su nota
//      mínima no bloquea) → evento course_completed → observer de core_badges → insignia otorgada y PNG
//      «horneado» (Open Badges) en el perfil del usuario.
// Crea un usuario y datos de completion en ESE curso de prueba; no cambia configuración del sitio.
//
// Uso: php -c php.ini v21-certificate-award.php <input.json> <output.json>   (input: { moodleRoot, courseid })
//
// P2-B1 (EV6 Fase 2 — exámenes) rebase sobre T3: el quiz de la evaluación final ahora lleva
// completionattemptsexhausted = (attempts > 0), así que su completion YA NO es pura nota (reprobar
// con intentos restantes = INCOMPLETE, no COMPLETE_FAIL — ver P2-design.md §1). Reprobar/aprobar un
// quiz con grade_update() directo (como hacía esta prueba antes de B1) ya no reproduce
// COMPLETE_FAIL: no hay ningún intento REAL agotado. Para el último criterio, cuando es un quiz, se
// toman intentos REALES (como simulate-b1.php) en vez de escribir la nota a mano.
namespace PHPUnit\Framework { if (!class_exists('PHPUnit\Framework\TestCase', false)) { abstract class TestCase { public function __construct($name = null) {} } } }
namespace PHPUnit\Framework\Constraint { if (!class_exists('PHPUnit\Framework\Constraint\Constraint', false)) { abstract class Constraint {} } }
namespace {
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->libdir . '/badgeslib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');

use mod_quiz\quiz_attempt;

global $DB, $CFG;
\core\session\manager::set_user(get_admin());
$courseid = (int)$in['courseid'];
$course = get_course($courseid);
$out = ['courseid' => $courseid, 'site' => ['enablebadges' => (int)$CFG->enablebadges,
    'badges_allowcoursebadges' => (int)$CFG->badges_allowcoursebadges, 'enablecompletion' => (int)$CFG->enablecompletion]];
if (empty($CFG->enablebadges) || empty($CFG->enablecompletion)) {
    fwrite(STDERR, "el sitio tiene insignias o completion deshabilitadas\n");
    exit(2);
}

$rec = $DB->get_record('badge', ['courseid' => $courseid], '*', MUST_EXIST);
$badge = new badge($rec->id);
$out['badgeid'] = (int)$badge->id;
$out['statusAfterRestore'] = (int)$badge->status;
$badge->set_status(BADGE_STATUS_ACTIVE); // = botón «Habilitar acceso» en Insignias del curso.
$out['statusAfterEnable'] = (int)(new badge($rec->id))->status;

// Usuario de prueba + matrícula manual como estudiante.
$uname = 'cursia_t3_' . $courseid . '_' . substr(sha1(uniqid('', true)), 0, 8);
$userid = user_create_user(['username' => $uname, 'password' => 'Cursia-T3-' . random_string(12), 'firstname' => 'Estudiante',
    'lastname' => 'Certificado', 'email' => $uname . '@example.invalid', 'auth' => 'manual', 'confirmed' => 1,
    'mnethostid' => $CFG->mnet_localhost_id], false, false);
$manual = enrol_get_plugin('manual');
$instance = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
if (!$instance) {
    $manual->add_instance($course);
    $instance = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual'], '*', MUST_EXIST);
}
$studentrole = $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
$manual->enrol_user($instance, $userid, $studentrole);
$out['userid'] = (int)$userid;

// Fix 0b: label oculto para docentes (cv3:shell:certificate_teacher) — lo ve un docente con edición
// (atenuado: visible=0 + moodle/course:viewhiddenactivities), nunca un estudiante.
$tname = 'cursia_t3_doc_' . $courseid . '_' . substr(sha1(uniqid('', true)), 0, 8);
$teacherid = user_create_user(['username' => $tname, 'password' => 'Cursia-T3-' . random_string(12), 'firstname' => 'Docente',
    'lastname' => 'Certificado', 'email' => $tname . '@example.invalid', 'auth' => 'manual', 'confirmed' => 1,
    'mnethostid' => $CFG->mnet_localhost_id], false, false);
$manual->enrol_user($instance, $teacherid, $DB->get_field('role', 'id', ['shortname' => 'editingteacher'], MUST_EXIST));
$visibility = [];
foreach (['student' => $userid, 'editingteacher' => $teacherid] as $role => $uid) {
    $mi = get_fast_modinfo($course, $uid);
    foreach ($mi->get_cms() as $cmx) {
        if (!in_array($cmx->idnumber, ['cv3:shell:closing', 'cv3:shell:certificate_teacher'], true)) continue;
        $visibility[$role][$cmx->idnumber] = ['visible' => (int)$cmx->visible, 'uservisible' => (bool)$cmx->uservisible,
            'onCoursePage' => (bool)$cmx->is_visible_on_course_page() && (bool)$cmx->uservisible];
    }
}
$out['visibility'] = $visibility;
$tcm = null;
foreach (get_fast_modinfo($course)->get_cms() as $cmx) { if ($cmx->idnumber === 'cv3:shell:certificate_teacher') $tcm = $cmx; }
if ($tcm) {
    $intro = $DB->get_field('label', 'intro', ['id' => $tcm->instance]);
    preg_match_all('#href="([^"]*badges/index\.php[^"]*)"#', $intro, $m);
    $out['teacherLabel'] = ['section' => (int)$tcm->sectionnum, 'links' => array_map('html_entity_decode', $m[1]),
        'text' => trim(preg_replace('/\s+/', ' ', html_entity_decode(strip_tags($intro))))];
}
$hidden = [];
foreach (get_fast_modinfo($course)->get_cms() as $cmx) { if (!$cmx->visible) $hidden[] = $cmx->idnumber; }
$out['hiddenModules'] = $hidden;

$state = function () use ($courseid, $userid, $badge): array {
    $cc = new completion_completion(['userid' => $userid, 'course' => $courseid]);
    return ['courseComplete' => (bool)$cc->is_complete(), 'issued' => (new badge($badge->id))->is_issued($userid)];
};
$runTask = function (): void {
    // aggregate_completions solo toma filas con reaggregate < time(): se deja pasar el segundo.
    sleep(2);
    ob_start();
    (new \core\task\completion_regular_task())->execute();
    ob_end_clean();
};

// r55 (R3): la completion del curso es UN criterio de nota (tipo 6); no hay criterios de actividad.
$modinfo = get_fast_modinfo($course);
$out['criteriaCount'] = $DB->count_records('course_completion_criteria', ['course' => $courseid, 'criteriatype' => COMPLETION_CRITERIA_TYPE_ACTIVITY]);
$out['otherCriteria'] = $DB->count_records_select('course_completion_criteria', 'course = ? AND criteriatype <> ?', [$courseid, COMPLETION_CRITERIA_TYPE_ACTIVITY]);
$gc = $DB->get_record('course_completion_criteria', ['course' => $courseid, 'criteriatype' => COMPLETION_CRITERIA_TYPE_GRADE]);
$gradepass = $gc ? (float)$gc->gradepass : null;
$out['gradeCriterion'] = $gradepass;
$completion = new completion_info($course);
// Ítems calificables (los que entran en la nota final): nota REAL en su grade_item (grade_update, la vía de la
// actividad). El criterio de nota lo evalúa completion_regular_task (dos pasadas: moodle-versions.md).
$graded = array_values(array_filter($modinfo->get_cms(), fn($cm) => (bool)preg_match('/^cv3:(ch:[^:]+:(video|activity)|exam:.+|final_exam)$/', (string)$cm->idnumber)));
$setAll = function (callable $rawOf) use ($graded, $courseid, $userid, $completion): array {
    $marks = [];
    foreach ($graded as $cm) {
        $raw = $rawOf($cm);
        grade_update('mod/' . $cm->modname, $courseid, 'mod', $cm->modname, $cm->instance, 0, ['userid' => $userid, 'rawgrade' => $raw]);
        $completion->update_state($cm, COMPLETION_UNKNOWN, $userid);
        $marks[] = ['idnumber' => $cm->idnumber, 'rawgrade' => $raw];
    }
    grade_regrade_final_grades($courseid);
    return $marks;
};
$courseGrade = function () use ($courseid, $userid) {
    $g = grade_item::fetch_course_item($courseid)->get_final($userid);
    return $g && $g->finalgrade !== null ? round((float)$g->finalgrade, 2) : null;
};
$runTwice = function () use ($runTask) { $runTask(); $runTask(); };
$out['beforeAny'] = $state();
$out['marks'] = [];
if ($gradepass !== null && $graded) {
    // Todo por debajo del mínimo del curso → nota final < mínimo → ni curso completo ni insignia.
    $out['marks']['low'] = $setAll(fn($cm) => max(0, $gradepass - 30));
    $runTwice();
    $out['low'] = $state() + ['courseGrade' => $courseGrade()];
    // La evaluación final reprobada pero la nota final ≥ mínimo → curso completo (r55: no hace falta aprobar cada ítem).
    $out['marks']['high'] = $setAll(fn($cm) => $cm->idnumber === 'cv3:final_exam' ? max(0, $gradepass - 30) : 100);
    $runTwice();
}
$after = $state() + ['courseGrade' => $courseGrade()];
$issued = $DB->get_record('badge_issued', ['badgeid' => $badge->id, 'userid' => $userid]);
if ($issued) {
    $after['dateissued'] = (int)$issued->dateissued;
    $fs = get_file_storage();
    $ph = badges_bake($issued->uniquehash, $badge->id, $userid, true);
    $f = $ph ? $fs->get_file_by_hash($ph) : false;
    $info = $f ? getimagesizefromstring($f->get_content()) : false;
    $after['bakedPng'] = $f ? ['filearea' => $f->get_filearea(), 'filename' => $f->get_filename(), 'w' => $info ? $info[0] : null,
        'h' => $info ? $info[1] : null, 'hasOpenBadgesChunk' => strpos($f->get_content(), 'openbadges') !== false] : null;
    $after['badgeUrl'] = (new moodle_url('/badges/badge.php', ['hash' => $issued->uniquehash]))->out(false);
}
$out['after'] = $after;
file_put_contents($argv[2], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

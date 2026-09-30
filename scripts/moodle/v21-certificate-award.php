<?php
// Cursia EV6 (T3): prueba de que la insignia-certificado de un curso YA restaurado se otorga sola
// al completar el curso, en el Moodle 4.5 LOCAL desechable. Pasos (lo que haría el gestor + un
// estudiante, sin atajos en la parte de la insignia):
//   1. «Habilitar acceso» a la insignia (core la restaura SIEMPRE inactiva);
//   2. crea un usuario de prueba y lo matricula como estudiante (enrol manual);
//   3. aprueba (nota REAL en el grade_item; Moodle calcula la completion por nota aprobatoria) los
//      criterios de completion del curso MENOS el último (la evaluación final si existe) y corre la
//      tarea real de completion (\core\task\completion_regular_task): sin curso completo ni insignia;
//   4. el último criterio primero REPROBADO (nota < gradepass → COMPLETION_COMPLETE_FAIL: sin
//      insignia) y luego APROBADO (nota ≥ gradepass → COMPLETION_COMPLETE_PASS); tarea otra vez:
//      curso completo → evento course_completed → observer de core_badges →
//      insignia otorgada y PNG «horneado» (Open Badges) en el perfil del usuario.
// Crea un usuario y datos de completion en ESE curso de prueba; no cambia configuración del sitio.
//
// Uso: php -c php.ini v21-certificate-award.php <input.json> <output.json>   (input: { moodleRoot, courseid })
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->libdir . '/badgeslib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');

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

// Criterios de completion del curso (tipo actividad), la evaluación final al final.
$modinfo = get_fast_modinfo($course);
$crit = [];
foreach ($DB->get_records('course_completion_criteria', ['course' => $courseid, 'criteriatype' => COMPLETION_CRITERIA_TYPE_ACTIVITY], 'id') as $cr) {
    $cm = $modinfo->get_cm((int)$cr->moduleinstance);
    $crit[] = $cm;
}
$other = $DB->count_records_select('course_completion_criteria', 'course = ? AND criteriatype <> ?', [$courseid, COMPLETION_CRITERIA_TYPE_ACTIVITY]);
$out['criteriaCount'] = count($crit);
$out['otherCriteria'] = $other;
usort($crit, fn($a, $b) => (int)($a->idnumber === 'cv3:final_exam') <=> (int)($b->idnumber === 'cv3:final_exam'));
$last = end($crit);
$out['lastIdnumber'] = $last ? $last->idnumber : null;

$completion = new completion_info($course);
// Ítem calificable: nota REAL en su grade_item (la completion por nota aprobatoria la calcula Moodle);
// ítem por vista (Libro Guía de un curso sin nota): completion marcada.
$mark = function ($cm, bool $pass) use ($completion, $userid, $courseid): array {
    if ((int)$cm->completionpassgrade === 1) {
        $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => $cm->modname, 'iteminstance' => $cm->instance, 'itemnumber' => 0]);
        $raw = $pass ? min(100, (float)$gi->gradepass + 20) : max(0, (float)$gi->gradepass - 30);
        grade_update('mod/' . $cm->modname, $courseid, 'mod', $cm->modname, $cm->instance, 0, ['userid' => $userid, 'rawgrade' => $raw]);
        $completion->update_state($cm, COMPLETION_UNKNOWN, $userid);
    } else {
        $completion->update_state($cm, COMPLETION_COMPLETE, $userid, true);
        $raw = null;
    }
    $st = (int)$GLOBALS['DB']->get_field('course_modules_completion', 'completionstate', ['coursemoduleid' => $cm->id, 'userid' => $userid]);
    return ['idnumber' => $cm->idnumber, 'rawgrade' => $raw, 'completionstate' => $st];
};

$out['beforeAny'] = $state();
$out['marks'] = [];
if (count($crit) > 1) {
    foreach (array_slice($crit, 0, -1) as $cm) { $out['marks'][] = $mark($cm, true); }
    $runTask();
    $out['withoutLast'] = $state();
}
if ($last && (int)$last->completionpassgrade === 1) {
    // El último (la evaluación final si existe) REPROBADO: el curso sigue sin completarse.
    $out['marks'][] = $mark($last, false);
    $runTask();
    $out['lastFailed'] = $state();
}
if ($last) { $out['marks'][] = $mark($last, true); }
$runTask();
$after = $state();
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

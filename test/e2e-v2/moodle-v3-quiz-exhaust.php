<?php
// P2-B1 (EV6 Fase 2 — exámenes) rebase gate fix: moodle-v3-grades.php simula notas por
// grade_update() directo, sin tomar ningún intento REAL de quiz. Eso ya no reproduce
// COMPLETE_FAIL (3) para un quiz: con completionattemptsexhausted = (attempts > 0), un quiz
// solo llega a COMPLETE_FAIL cuando sus intentos de verdad se agotan (ver P2-design.md §1,
// mod/quiz/classes/completion/custom_completion.php). moodle-v3-grades.php sigue
// comprobando esa parte con una nota escrita a mano → INCOMPLETE (ajustado en e2e-v3.js);
// este script, aparte, prueba el camino REAL: toma intentos reprobados hasta agotar
// `attempts` (mod_quiz_generator, como simulate-b1.php / v21-certificate-award.php) con un
// usuario de prueba dedicado (nunca el mismo que la simulación de notas, para no pisar su
// nota ni romper el chequeo de "notas registradas = las simuladas").
//
// Uso: php -c php.ini moodle-v3-quiz-exhaust.php <input.json> <output.json>
//   input: { moodleRoot, courseid, idnumber }  (idnumber del cv3:exam:… o cv3:final_exam a agotar)
//   output: { completionstate, courseComplete, attemptsUsed }
namespace PHPUnit\Framework { if (!class_exists('PHPUnit\Framework\TestCase', false)) { abstract class TestCase { public function __construct($name = null) {} } } }
namespace PHPUnit\Framework\Constraint { if (!class_exists('PHPUnit\Framework\Constraint\Constraint', false)) { abstract class Constraint {} } }
namespace {
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');

use mod_quiz\quiz_attempt;

global $DB, $CFG;
$CFG->noemailever = true;
$admin = get_admin();
\core\session\manager::set_user($admin);
$courseid = (int)$in['courseid'];
$idnumber = $in['idnumber'];
$course = get_course($courseid);
$modinfo = get_fast_modinfo($course);
$cm = null;
foreach ($modinfo->get_cms() as $x) { if ($x->idnumber === $idnumber) $cm = $x; }
if (!$cm || $cm->modname !== 'quiz') { fwrite(STDERR, "idnumber de quiz no encontrado: $idnumber\n"); exit(1); }

$uname = 'r13examexhaust_' . $courseid;
$u = $DB->get_record('user', ['username' => $uname]);
if (!$u) {
    $u = (object)['username' => $uname, 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id,
        'firstname' => 'R13', 'lastname' => 'ExamExhaust', 'email' => $uname . '@example.invalid', 'password' => ''];
    $u->id = $DB->insert_record('user', $u);
}
$studentrole = $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
enrol_try_internal_enrol($courseid, $u->id, $studentrole);

$gen = new \testing_data_generator();
$doAttempt = function () use ($gen, $cm, $u, $admin) {
    \core\session\manager::set_user($u);
    $quizgen = $gen->get_plugin_generator('mod_quiz');
    $attempt = $quizgen->create_attempt($cm->instance, $u->id);
    $ao = quiz_attempt::create($attempt->id);
    $post = [];
    foreach ($ao->get_slots() as $slot) {
        $qa = $ao->get_question_attempt($slot);
        $q = $qa->get_question();
        $right = $q->get_correct_response();
        // Siempre REPROBADO: la respuesta incorrecta (nunca la correcta).
        if ($q->get_type_name() === 'multichoice') {
            $val = ($right['answer'] + 1) % count($q->get_order($qa));
        } else { // truefalse
            $val = 1 - $right['answer'];
        }
        $post[$qa->get_control_field_name('sequencecheck')] = (string)$qa->get_sequence_check_count();
        $post[$qa->get_qt_field_name('answer')] = (string)$val;
    }
    $ao->process_submitted_actions(time(), false, $post);
    $ao->process_finish(time(), false);
    \core\session\manager::set_user($admin);
};

$attempts = (int)$DB->get_field('quiz', 'attempts', ['id' => $cm->instance]);
$n = max(1, $attempts); // intentos ilimitados (0): un solo intento reprobado (nunca se agota, documental).
for ($i = 0; $i < $n; $i++) $doAttempt();

sleep(2); // aggregate_completions solo toma filas con reaggregate < time().
ob_start();
(new \core\task\completion_regular_task())->execute();
ob_end_clean();
get_fast_modinfo($courseid, 0, true);
$mi = get_fast_modinfo($course, $u->id);
$ci = new completion_info($course);
$state = (int)$ci->get_data($mi->get_cm($cm->id), false, $u->id)->completionstate;
$courseComplete = (bool)(new completion_completion(['userid' => $u->id, 'course' => $courseid]))->is_complete();

file_put_contents($argv[2], json_encode([
    'idnumber' => $idnumber,
    'attemptsConfigured' => $attempts,
    'attemptsUsed' => $n,
    'completionstate' => $state,
    'courseComplete' => $courseComplete,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
echo "OK\n";
}

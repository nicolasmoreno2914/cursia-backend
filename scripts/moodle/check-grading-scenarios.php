<?php
// Cursia r55 (R1–R6) — escenarios REALES de calificación / aprobación / certificado sobre un curso Cursia YA restaurado
// en el Moodle 4.5 LOCAL desechable (nunca un Moodle remoto). Basado en audit-1353/reports/grading-scenarios.md.
//
// Estudiantes ficticios (r55gs_<curso>_<escenario>@example.invalid) con las APIs reales:
//   - evaluaciones: intentos REALES (quiz_prepare_and_start_new_attempt + motor de preguntas + process_finish);
//   - H5P evaluativo: sentencia xAPI «completed» por \core_xapi\handler (la misma vía del reproductor);
//   - «Repaso»: completion_info::set_module_viewed (lo que hace view.php);
//   - override manual del docente: completion_info::update_state(..., override).
// Después: regrade; activación de la insignia del curso de prueba (el paso del docente: Moodle la restaura desactivada);
// completion_regular_task ×2 (el criterio de nota lo evalúa el cron) y review_all_criteria SOLO de esa insignia.
// Review r1 (I4): sin completion_daily_task ni badges_cron_task (tareas de todo el sitio, el gate comparte Moodle).
//
// Escenarios (curso con ≥ 1 evaluación de módulo, evaluación final y «Repaso»; 3 intentos por evaluación):
//   s1_pass_all             todo aprobado (1 intento)                       → completo + insignia; «Respuestas» ocultas
//   s2_exam_fail_x3         evaluación de módulo 60 ×3, resto alto           → nota final ≥ mínimo → completo + insignia
//   s3_low_final            todo bajo                                         → nota final < mínimo → NO completo, sin insignia
//   s4_final_fail_x3        evaluación final 50 ×3, resto alto                → nota final ≥ mínimo → completo
//   s5a_dc_viewed / s5b_dc_not_viewed  mismas notas, «Repaso» visto o no     → misma nota, ambos completos
//   s6_pass_exhaust         aprueba en el 1.er intento (oculta) y usa los 3   → «Respuestas explicadas» visible solo al final
//   s7_override             notas bajas + override manual del docente de TODA la completion de actividades → NO completo
// Asserts: configuración restaurada (UN criterio tipo 6 = gradepass del ítem del curso, sin criterios de actividad,
// ALL; quiz completionusegrade + completionminattempts = intentos, sin passgrade/attemptsexhausted; «Repaso» sin nota),
// curso completo ⇔ nota final ≥ mínimo, insignia ⇔ completo, «Repaso» sin efecto en la nota, visibilidad de «Respuestas
// explicadas» antes / después de agotar intentos, y que nada se completa antes del cron.
//
// Uso: php -c php.ini check-grading-scenarios.php --moodle=<raíz> --courseid=<id> [--out=<json>] [--cleanup]
//      [--teacherid=<id del docente que restauró, para borrarlo con --cleanup>]
// --cleanup borra los estudiantes creados aquí y, si el curso NO es protegido, el curso (solo pásalo para un curso creado
// por quien llama). Exit 0 = todos los asserts OK.
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'courseid:', 'out:', 'cleanup', 'teacherid:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/badgeslib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->dirroot . '/question/engine/lib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');
use mod_quiz\quiz_attempt;
use mod_quiz\quiz_settings;
global $DB, $CFG;
// T7 (r57): compatibilidad con Moodle 4.1 (antes de 4.2 las clases del quiz y de la insignia no tenían namespace).
// En 4.2+ las clases existen y estas líneas no hacen nada.
if (!class_exists('\mod_quiz\quiz_settings') && class_exists('quiz')) class_alias('quiz', 'mod_quiz\quiz_settings');
if (!class_exists('\mod_quiz\quiz_attempt') && class_exists('quiz_attempt')) class_alias('quiz_attempt', 'mod_quiz\quiz_attempt');
if (!class_exists('\core_badges\badge') && class_exists('badge')) class_alias('badge', 'core_badges\badge');

const PROTECTED_COURSES = [5372, 5374, 5375, 5377, 5378];
$courseid = (int)$opts['courseid'];
$admin = get_admin();
\core\session\manager::set_user($admin);
$course = get_course($courseid);
mt_srand(55);
$R = ['course' => $courseid, 'asserts' => [], 'config' => [], 'users' => []];
$ok = function (bool $c, string $m) use (&$R) { $R['asserts'][] = ['ok' => $c, 'msg' => $m]; };
$NAMES = [0 => 'incomplete', 1 => 'complete', 2 => 'complete_pass', 3 => 'complete_fail', 4 => 'complete_fail_hidden'];

// ── Inventario por idnumber cv3:… ──
$mi = get_fast_modinfo($courseid);
$byidn = [];
foreach ($mi->get_cms() as $cm) if ($cm->idnumber) $byidn[$cm->idnumber] = $cm;
$exams = []; $final = null; $graded = []; $dialog = []; $expl = [];
foreach ($byidn as $idn => $cm) {
    if (preg_match('/^cv3:exam:/', $idn) && $cm->modname === 'quiz') $exams[$idn] = $cm;
    if ($idn === 'cv3:final_exam') $final = $cm;
    if (preg_match('/^cv3:ch:[^:]+:(video|activity)$/', $idn) && $cm->modname === 'h5pactivity') $graded[$idn] = $cm;
    if (preg_match('/^cv3:ch:[^:]+:review_cards$/', $idn)) $dialog[$idn] = $cm;
    if (preg_match('/^cv3:(exam_explanations:(.+)|final_exam_explanations)$/', $idn, $m)) $expl[$m[2] ?? 'final'] = $cm;
}
$quizzes = $exams + ($final ? ['cv3:final_exam' => $final] : []);
$explFor = function (string $quizidn) use ($expl) { return $quizidn === 'cv3:final_exam' ? ($expl['final'] ?? null) : ($expl[substr($quizidn, strlen('cv3:exam:'))] ?? null); };
$R['inventory'] = ['exams' => count($exams), 'final' => (bool)$final, 'graded_h5p' => count($graded), 'review_cards' => count($dialog), 'explanations' => count($expl)];
$ok(count($exams) >= 1 && $final && count($graded) >= 1 && count($dialog) >= 1 && count($expl) === count($quizzes), 'inventario: evaluaciones de módulo, final, H5P evaluativo, «Repaso» y una página de respuestas por evaluación');

// ── Configuración restaurada ──
$ci = grade_item::fetch_course_item($courseid);
$crit = array_values($DB->get_records('course_completion_criteria', ['course' => $courseid]));
$aggr = array_values($DB->get_records('course_completion_aggr_methd', ['course' => $courseid]));
$R['config'] = ['course_gradepass' => (float)$ci->gradepass, 'criteria' => array_map(fn($c) => ['type' => (int)$c->criteriatype, 'gradepass' => $c->gradepass === null ? null : (float)$c->gradepass, 'moduleinstance' => $c->moduleinstance], $crit),
    'aggr' => array_map(fn($a) => ['criteriatype' => $a->criteriatype, 'method' => (int)$a->method], $aggr),
    'badges' => array_values(array_map(fn($b) => ['id' => (int)$b->id, 'status' => (int)$b->status, 'name' => $b->name], $DB->get_records('badge', ['courseid' => $courseid])))];
$gp = (float)$ci->gradepass;
$ok((int)$course->enablecompletion === 1, 'el curso restaurado tiene la finalización habilitada (sin ella los criterios no hacen nada)');
$ok(count($crit) === 1 && (int)$crit[0]->criteriatype === COMPLETION_CRITERIA_TYPE_GRADE && abs((float)$crit[0]->gradepass - $gp) < 1e-6 && $gp > 0,
    "completion del curso = UN criterio de nota (tipo 6) con gradepass = ítem del curso ($gp); sin criterios de actividad");
$ok(count($aggr) === 1 && $aggr[0]->criteriatype === null && (int)$aggr[0]->method === COMPLETION_AGGREGATION_ALL, 'agregación global ALL');
foreach ($quizzes as $idn => $cm) {
    $q = $DB->get_record('quiz', ['id' => $cm->instance]);
    $ok((int)$cm->completion === 2 && $cm->completiongradeitemnumber !== null && (int)$cm->completionpassgrade === 0 && (int)$q->completionattemptsexhausted === 0 && (int)$q->completionminattempts === (int)$q->attempts,
        "$idn: completion por nota + completionminattempts {$q->completionminattempts} = intentos {$q->attempts}, sin passgrade ni attemptsexhausted");
}
foreach ($dialog as $idn => $cm) {
    $a = $DB->get_record('h5pactivity', ['id' => $cm->instance]);
    $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'h5pactivity', 'iteminstance' => $cm->instance]);
    $ok((int)$a->grade === 0 && (int)$a->enabletracking === 0 && !$gi && (int)$cm->completion === 2 && (int)$cm->completionview === 1, "$idn: «Repaso» sin nota ni tracking, completion por vista");
}
foreach ($graded as $idn => $cm) {
    $a = $DB->get_record('h5pactivity', ['id' => $cm->instance]);
    $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'h5pactivity', 'iteminstance' => $cm->instance]);
    $ok((int)$a->enabletracking === 1 && $gi && (int)$cm->completionpassgrade === 0 && $cm->completiongradeitemnumber !== null, "$idn: H5P evaluativo con tracking, ítem de nota y completion al recibir nota");
}
$ok(count($R['config']['badges']) === 1, 'una insignia-certificado restaurada (' . json_encode($R['config']['badges']) . ')');

// ── Escenarios ──
$EX = fn($v) => array_fill_keys(array_keys($exams), $v);
$S = [
    's1_pass_all' => ['h5p' => 85, 'q' => $EX([85]) + ['cv3:final_exam' => [85]], 'dc' => true, 'expect' => true],
    's2_exam_fail_x3' => ['h5p' => 95, 'q' => $EX([60, 60, 60]) + ['cv3:final_exam' => [95]], 'dc' => true, 'expect' => true],
    's3_low_final' => ['h5p' => 40, 'q' => $EX([55]) + ['cv3:final_exam' => [55]], 'dc' => true, 'expect' => false],
    's4_final_fail_x3' => ['h5p' => 95, 'q' => $EX([95]) + ['cv3:final_exam' => [50, 50, 50]], 'dc' => true, 'expect' => true],
    's5a_dc_viewed' => ['h5p' => 80, 'q' => $EX([80]) + ['cv3:final_exam' => [80]], 'dc' => true, 'expect' => true],
    's5b_dc_not_viewed' => ['h5p' => 80, 'q' => $EX([80]) + ['cv3:final_exam' => [80]], 'dc' => false, 'expect' => true],
    's6_pass_exhaust' => ['h5p' => 85, 'q' => $EX([85, 85, 85]) + ['cv3:final_exam' => [85, 85, 85]], 'dc' => true, 'expect' => true, 'probe' => true],
    's7_override' => ['h5p' => 40, 'q' => $EX([50]) + ['cv3:final_exam' => [50]], 'dc' => false, 'expect' => false, 'override' => true],
];

$enrol = enrol_get_plugin('manual');
$inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
if (!$inst) { $enrol->add_default_instance($course); $inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual'], '*', MUST_EXIST); }
$studentrole = $DB->get_field('role', 'id', ['shortname' => 'student']);
$handler = \core_xapi\handler::create('mod_h5pactivity');
$cinfo = new completion_info($course);

function r55_wrong_response(question_definition $q, array $correct): array {
    $cands = [];
    if ($q instanceof qtype_truefalse_question) $cands[] = ['answer' => $q->rightanswer ? 0 : 1];
    else if ($q instanceof qtype_multichoice_single_question) { for ($k = 0; $k < count($q->answers); $k++) $cands[] = ['answer' => $k]; }
    else if ($q instanceof qtype_match_question) { $v = array_values($correct); $k = array_keys($correct); if (count($v) > 1) $cands[] = array_combine($k, array_merge(array_slice($v, 1), [$v[0]])); }
    foreach ($cands as $c) { if ($c == $correct) continue; try { [$f] = $q->grade_response($c); } catch (\Throwable $e) { continue; } if ($f <= 0) return $c; }
    return [];
}
$explAvailable = function (int $uid, $pagecm) use ($courseid) {
    \cache::make('core', 'completion')->purge();
    get_fast_modinfo($courseid, 0, true);
    return (bool)get_fast_modinfo($courseid, $uid)->get_cm($pagecm->id)->available;
};
$quizState = function (int $uid, $cm) use ($cinfo, $NAMES, $courseid) {
    \cache::make('core', 'completion')->purge();
    get_fast_modinfo($courseid, 0, true);
    return $NAMES[$cinfo->get_data(get_fast_modinfo($courseid)->get_cm($cm->id), false, $uid)->completionstate] ?? '?';
};

$t0 = time() - 86400 * 5;
$users = [];
foreach ($S as $tag => $sc) {
    $uname = strtolower("r55gs_{$courseid}_{$tag}");
    if ($old = $DB->get_record('user', ['username' => $uname])) delete_user($old);
    $uid = user_create_user((object)['username' => $uname, 'password' => 'Fict-' . random_string(14) . '!1', 'firstname' => 'R55', 'lastname' => "Ficticio $tag",
        'email' => "$uname@example.invalid", 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id], false, false);
    $enrol->enrol_user($inst, $uid, $studentrole, $t0);
    $users[$tag] = $uid;
    $user = core_user::get_user($uid);
    \core\session\manager::set_user($user);
    $log = ['uid' => $uid, 'quiz' => [], 'probe' => []];
    $t = $t0 + 3600;
    foreach (array_values($graded) as $i => $cm) {
        $score = $sc['h5p'];
        $ctx = context_module::instance($cm->id);
        $st = \core_xapi\local\statement::create_from_data((object)[
            'actor' => (object)['objectType' => 'Agent', 'account' => (object)['homePage' => $CFG->wwwroot, 'name' => (string)$uid]],
            'verb' => (object)['id' => 'http://adlnet.gov/expapi/verbs/completed'],
            'object' => (object)['objectType' => 'Activity', 'id' => \core_xapi\iri::generate((string)$ctx->id, 'activity'),
                'definition' => (object)['interactionType' => 'compound', 'name' => (object)['es' => $cm->name], 'extensions' => (object)['http://h5p.org/x-api/h5p-local-content-id' => 1]]],
            'result' => (object)['score' => (object)['min' => 0, 'max' => 100, 'raw' => $score, 'scaled' => $score / 100], 'completion' => true, 'success' => $score >= 70, 'duration' => 'PT5M'],
        ]);
        $handler->process_statements([$st]);
    }
    if ($sc['dc']) foreach ($dialog as $cm) $cinfo->set_module_viewed(cm_info::create($cm, $uid), $uid);
    foreach ($quizzes as $idn => $cm) {
        $quizobj = quiz_settings::create($cm->instance, $uid);
        $last = null; $attemptlog = [];
        foreach ($sc['q'][$idn] ?? [] as $n => $target) {
            $t += 600;
            if ($prevent = $quizobj->get_access_manager($t)->prevent_new_attempt($n, $last)) { $attemptlog[] = ['blocked' => strip_tags(implode(' ', (array)$prevent))]; break; }
            $attempt = quiz_prepare_and_start_new_attempt($quizobj, $n + 1, $last, false, [], [], $uid);
            $quba = question_engine::load_questions_usage_by_activity($attempt->uniqueid);
            $slots = $quba->get_slots();
            $k = (int)ceil($target * count($slots) / 100 - 1e-9);
            $order = $slots; shuffle($order); $right = array_flip(array_slice($order, 0, $k));
            foreach ($slots as $slot) {
                $correct = $quba->get_correct_response($slot);
                $quba->process_action($slot, isset($right[$slot]) ? $correct : r55_wrong_response($quba->get_question($slot), $correct), $t + 60);
            }
            question_engine::save_questions_usage_by_activity($quba);
            quiz_attempt::create($attempt->id)->process_finish($t + 120, false);
            $last = $DB->get_record('quiz_attempts', ['id' => $attempt->id]);
            $attemptlog[] = ['target' => $target, 'slots' => count($slots), 'sumgrades' => round((float)$last->sumgrades, 2)];
            if (!empty($sc['probe'])) {
                \core\session\manager::set_user($admin);
                $log['probe'][] = ['quiz' => $idn, 'after_attempt' => $n + 1, 'quiz_state' => $quizState($uid, $cm), 'explanations_available' => $explAvailable($uid, $explFor($idn))];
                \core\session\manager::set_user($user);
            }
        }
        $log['quiz'][$idn] = $attemptlog;
    }
    \core\session\manager::set_user($admin);
    if (!empty($sc['override'])) {
        // El docente marca a mano como completadas todas las actividades (evaluaciones, H5P, «Repaso»).
        foreach (array_merge(array_values($quizzes), array_values($graded), array_values($dialog)) as $cm) {
            $cinfo->update_state(cm_info::create($cm, $uid), COMPLETION_COMPLETE, $uid, true);
        }
    }
    $R['users'][$tag] = $log;
}

// ── Antes del cron: nadie completo (el criterio de nota lo evalúa completion_regular_task) ──
\core\session\manager::set_user($admin);
grade_regrade_final_grades($courseid);
$pre = [];
foreach ($users as $tag => $uid) $pre[$tag] = (bool)$DB->get_field('course_completions', 'timecompleted', ['userid' => $uid, 'course' => $courseid]);
$R['pre_cron_completed'] = $pre;
$ok(!array_filter($pre), 'antes del cron ningún estudiante tiene el curso completo (criterio de nota = tarea programada)');

// review r1 (I4): nada de tareas de todo el sitio que no sean completion_regular_task (el gate comparte este Moodle:
// completion_daily_task / badges_cron_task tocarían otros cursos e insignias). El paso del docente — activar la
// insignia del curso de prueba (Moodle la restaura desactivada) — va ANTES del cron, como en producción; luego
// completion_regular_task ×2 (el criterio de nota) y, acotado a ESA insignia, review_all_criteria (lo mismo que
// hace «Habilitar acceso» para quien ya cumplía). La aserción insignia ⇔ curso completo sigue abajo, por usuario.
$issuedIn = fn(): int => (int)$DB->count_records_sql('SELECT COUNT(1) FROM {badge_issued} bi JOIN {badge} b ON b.id = bi.badgeid WHERE b.courseid = ?', [$courseid]);
$ok($issuedIn() === 0, 'antes del cron no hay insignias emitidas en el curso de prueba');
$testBadges = [];
foreach ($DB->get_records('badge', ['courseid' => $courseid]) as $b) {
    $badge = new \core_badges\badge($b->id);
    if (!$badge->is_active()) $badge->set_status(BADGE_STATUS_ACTIVE);
    $testBadges[] = $badge;
}
$runtask = function (string $cls) { $t = new $cls(); ob_start(); $t->execute(); ob_end_clean(); };
// T7 (r57): aggregate_completions() solo agrega las filas con reaggregate < inicio de la corrida (segundos): dos
// corridas en el MISMO segundo (Moodle 4.1–4.4, donde la marca del criterio no agrega en línea) no completaban a nadie.
// En producción el cron corre con minutos de diferencia; aquí se espera 2 s antes de cada corrida.
foreach (['\core\task\completion_regular_task', '\core\task\completion_regular_task'] as $cls) { sleep(2); $runtask($cls); }
$R['badge_issued_after_completion_tasks'] = $issuedIn();
$R['badge_review_awarded'] = 0;
foreach ($testBadges as $badge) $R['badge_review_awarded'] += (int)$badge->review_all_criteria();

// ── Estado final ──
$ci = grade_item::fetch_course_item($courseid);
$grades = [];
foreach ($S as $tag => $sc) {
    $uid = $users[$tag];
    $g = $ci->get_final($uid);
    $grade = $g && $g->finalgrade !== null ? round((float)$g->finalgrade, 2) : null;
    $complete = (bool)$DB->get_field('course_completions', 'timecompleted', ['userid' => $uid, 'course' => $courseid]);
    $badges = $DB->count_records_sql('SELECT COUNT(1) FROM {badge_issued} bi JOIN {badge} b ON b.id = bi.badgeid WHERE b.courseid = ? AND bi.userid = ?', [$courseid, $uid]);
    $qs = []; $ex = [];
    foreach ($quizzes as $idn => $cm) { $qs[$idn] = $quizState($uid, $cm); $ex[$idn] = $explAvailable($uid, $explFor($idn)); }
    $row = ['course_grade' => $grade, 'gradepass' => (float)$ci->gradepass, 'complete' => $complete, 'badges' => $badges, 'quiz_states' => $qs, 'explanations_available' => $ex];
    $R['users'][$tag] += $row;
    $grades[$tag] = $grade;
    $ok($grade !== null && $complete === ($grade >= (float)$ci->gradepass), "$tag: completo ($complete) ⇔ nota final $grade ≥ {$ci->gradepass}");
    $ok($complete === $sc['expect'], "$tag: resultado esperado del escenario (" . ($sc['expect'] ? 'completo' : 'no completo') . "), nota $grade");
    $ok(($badges > 0) === $complete, "$tag: insignia ($badges) ⇔ curso completo");
    // «Respuestas explicadas»: abierta ⇔ el estudiante usó todos los intentos (o, con override del docente, a pedido del docente).
    foreach ($quizzes as $idn => $cm) {
        $q = $DB->get_record('quiz', ['id' => $cm->instance]);
        $used = count($sc['q'][$idn] ?? []);
        $want = !empty($sc['override']) || ($q->attempts > 0 && $used >= $q->attempts);
        $ok($ex[$idn] === $want, "$tag $idn: «Respuestas explicadas» " . ($want ? 'visible' : 'oculta') . " (intentos usados $used de {$q->attempts}, estado {$qs[$idn]})");
    }
}
$ok($grades['s5a_dc_viewed'] === $grades['s5b_dc_not_viewed'], "«Repaso» visto / no visto: misma nota ({$grades['s5a_dc_viewed']} = {$grades['s5b_dc_not_viewed']})");
foreach ($R['users']['s6_pass_exhaust']['probe'] as $p) {
    $ok($p['explanations_available'] === ($p['after_attempt'] >= 3), "s6 {$p['quiz']} tras el intento {$p['after_attempt']} (aprobado): «Respuestas explicadas» " . ($p['after_attempt'] >= 3 ? 'visible' : 'oculta') . " (estado del quiz {$p['quiz_state']})");
}
foreach (['s2_exam_fail_x3' => array_keys($exams)[0], 's4_final_fail_x3' => 'cv3:final_exam'] as $tag => $idn) {
    $ok($R['users'][$tag]['quiz_states'][$idn] === 'complete_fail', "$tag $idn agotado sin aprobar: estado complete_fail (e=3 abre la página)");
}
$ok($R['users']['s6_pass_exhaust']['quiz_states']['cv3:final_exam'] === 'complete_pass', 's6 final agotado aprobando: estado complete_pass (e=1 abre la página)');

// ── Limpieza ──
if (isset($opts['cleanup'])) {
    foreach ($users as $uid) { $u = $DB->get_record('user', ['id' => $uid]); if ($u && strpos($u->username, 'r55gs_') === 0) delete_user($u); }
    if (!in_array($courseid, PROTECTED_COURSES, true)) { ob_start(); delete_course($courseid, false); ob_end_clean(); }
    if (!empty($opts['teacherid'])) { $u = $DB->get_record('user', ['id' => (int)$opts['teacherid']]); if ($u && strpos($u->username, 'r55t_') === 0) delete_user($u); }
    $R['cleanup'] = ['course_deleted' => !$DB->record_exists('course', ['id' => $courseid]), 'users_left' => $DB->count_records_select('user', "username LIKE ? AND deleted = 0", ["r55gs_{$courseid}_%"])];
}
$R['ok'] = !array_filter($R['asserts'], fn($a) => !$a['ok']);
$json = json_encode($R, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if (!empty($opts['out'])) file_put_contents($opts['out'], $json);
echo $json, "\n";
exit($R['ok'] ? 0 : 1);

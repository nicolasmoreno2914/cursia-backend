<?php
// Cursia EV6 P2-B5 — evaluaciones que certifican, en un curso v3 YA RESTAURADO (Moodle 4.5 local
// desechable). Promovido de scratchpad/r18/p2-ref/simulate.php (+ phpunit-stub.php) y de los
// simulate-b4*.php: ASERTA en vez de imprimir. Quizzes: SIEMPRE intentos REALES (quiz_attempt API:
// create_attempt → process_submitted_actions → process_finish); nunca se escribe una nota de quiz.
// Los demás criterios del curso (H5P/SCORM de práctica) se aprueban con su nota (grade_update), como
// el gate de notas: no son el objeto de esta prueba.
//
// Aserciones (P2-design §1.2/§1.3/§2.2, rulings 1–3):
//  config restaurada  revisión (8 campos §1.3; V542 fix round 1 I1: reviewattempt D|I|C, reviewmarks O|C), completionattemptsexhausted = intentos > 0,
//                     cm 2/0/1; slots todos aleatorios (banco: cada filtercondition → hoja del contexto
//                     del quiz, includesubcategories false) o todos fijos (GIFT); Σ maxmark = 100;
//                     página «Respuestas explicadas»: misma sección, justo después del quiz,
//                     availability remapeada al cmid RESTAURADO de su quiz (e=1|e=3, o solo e=1 con
//                     intentos ilimitados), completion 0, downloadcontent 0, fuera de los criterios.
//  A (intentos > 0)   reprueba el primer examen de módulo hasta agotarlo: con intentos restantes
//                     INCOMPLETE y página BLOQUEADA; agotado COMPLETE_FAIL y página DISPONIBLE; tras
//                     cada intento: página de revisión PERMITIDA al terminar (V542 I4: sin el aviso «No tiene
//                     permiso para revisar este cuestionario») que, renderizada como el estudiante, muestra sus
//                     respuestas SIN nota por pregunta (fix round 1 I1: la nota junto a la respuesta revela la
//                     correcta de una V/F), corrección, respuesta correcta ni feedback; más tarde (abierto) sin
//                     página de revisión y con la nota TOTAL visible (view.php + ítem del libro visible);
//                     QUIZFB: al terminar, la retroalimentación global («aprobaste» / «todavía no», bandas de
//                     la nota mínima del perfil) se ve con el texto de la banda de la nota real; luego aprueba todo lo demás → curso NO completo, sin insignia.
//  U (intentos = 0)   reprueba 2 veces → página bloqueada (aunque Moodle ya marque COMPLETE_FAIL); aprueba
//                     → página disponible; aprueba lo demás → curso completo.
//  B                  aprueba al primer intento → COMPLETE_PASS, página disponible; aprueba lo demás →
//                     curso completo (+ insignia si el paquete la trae, activada como lo haría el docente).
//  C (con final)      aprueba módulos y práctica, agota el final reprobando → final COMPLETE_FAIL, su página
//                     disponible, curso NO completo, sin insignia.
//  banco              cada pregunta sorteada sale de la hoja de SU slot; por hoja, slots = referencias.
//  nota docente       el label oculto para docentes no es visible para el estudiante.
//
// Uso: php -c php.ini moodle-p2-exams.php <moodleRoot> <courseid> <output.json>
//      exit 0 si todas las aserciones pasan; 1 si alguna falla (el JSON trae el detalle).
namespace PHPUnit\Framework { if (!class_exists('PHPUnit\Framework\TestCase', false)) { abstract class TestCase { public function __construct($name = null) {} } } }
namespace PHPUnit\Framework\Constraint { if (!class_exists('PHPUnit\Framework\Constraint\Constraint', false)) { abstract class Constraint {} } }
namespace {
define('CLI_SCRIPT', true);
if ($argc < 4) { fwrite(STDERR, "uso: moodle-p2-exams.php <moodleRoot> <courseid> <output.json>\n"); exit(2); }
require($argv[1] . '/config.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->libdir . '/badgeslib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->dirroot . '/completion/completion_completion.php');

use mod_quiz\quiz_attempt;
use mod_quiz\quiz_settings;
use mod_quiz\question\display_options;

global $DB, $CFG, $PAGE;
$CFG->noemailever = true;
$courseid = (int)$argv[2];
$outfile = $argv[3];
\core\session\manager::set_user(get_admin());
$gen = new testing_data_generator();
$course = get_course($courseid);
$modinfo = get_fast_modinfo($course);
$byid = [];
foreach ($modinfo->get_cms() as $cm) { if ($cm->idnumber !== '') $byid[$cm->idnumber] = $cm; }
$NAMES = [0 => 'INCOMPLETE', 1 => 'COMPLETE', 2 => 'COMPLETE_PASS', 3 => 'COMPLETE_FAIL'];
$RUN = substr(sha1(microtime(true) . random_int(0, PHP_INT_MAX)), 0, 6);

$assertions = [];
function check($name, $ok, $detail = null) {
    global $assertions;
    $assertions[] = ['name' => $name, 'ok' => (bool)$ok] + ($ok ? [] : ['detail' => $detail]);
}

// ── quizzes y sus páginas ──
$quizzes = [];
foreach ($byid as $idn => $cm) {
    if ($cm->modname !== 'quiz') continue;
    $pageidn = $idn === 'cv3:final_exam' ? 'cv3:final_exam_explanations' : 'cv3:exam_explanations:' . substr($idn, strlen('cv3:exam:'));
    $quizzes[$idn] = ['cm' => $cm, 'page' => $byid[$pageidn] ?? null, 'pageidn' => $pageidn,
        'quiz' => $DB->get_record('quiz', ['id' => $cm->instance], '*', MUST_EXIST)];
}
check('el curso tiene al menos un quiz', count($quizzes) > 0, array_keys($byid));
$moduleExams = array_values(array_filter(array_keys($quizzes), fn($k) => str_starts_with($k, 'cv3:exam:')));
$final = isset($quizzes['cv3:final_exam']) ? 'cv3:final_exam' : null;
$criteria = array_map('intval', $DB->get_fieldset_select('course_completion_criteria', 'moduleinstance', 'course = ? AND criteriatype = 4', [$courseid]));

$REVIEW = ['reviewattempt' => 69648, 'reviewcorrectness' => 16, 'reviewmaxmarks' => 69904, 'reviewmarks' => 272,
    'reviewspecificfeedback' => 16, 'reviewgeneralfeedback' => 16, 'reviewrightanswer' => 16, 'reviewoverallfeedback' => 4368];

/** Slot → categoría del filtercondition restaurado (null si el slot es fijo). */
function slot_leaf($cm) {
    global $DB;
    $ctx = context_module::instance($cm->id);
    $out = [];
    foreach ($DB->get_records('quiz_slots', ['quizid' => $cm->instance], 'slot') as $s) {
        $ref = $DB->get_record('question_set_references', ['usingcontextid' => $ctx->id, 'component' => 'mod_quiz', 'questionarea' => 'slot', 'itemid' => $s->id]);
        $out[(int)$s->slot] = $ref ? json_decode($ref->filtercondition, true) : null;
    }
    return $out;
}

$config = [];
foreach ($quizzes as $idn => $Q) {
    $q = $Q['quiz']; $cm = $Q['cm'];
    $ctx = context_module::instance($cm->id);
    $attempts = (int)$q->attempts;
    $got = []; foreach ($REVIEW as $k => $v) $got[$k] = (int)$q->$k;
    check("$idn: revisión = respuestas propias al terminar, sin nota por pregunta/corrección/feedback/respuesta; nota total más tarde (8 campos §1.3 + V542 I1)", $got === $REVIEW, $got);
    check("$idn: completionattemptsexhausted = intentos > 0 ($attempts)", (int)$q->completionattemptsexhausted === ($attempts > 0 ? 1 : 0), (int)$q->completionattemptsexhausted);
    check("$idn: cm completion 2/0/1", [(int)$cm->completion, (string)$cm->completiongradeitemnumber, (int)$cm->completionpassgrade] === [2, '0', 1],
        [$cm->completion, $cm->completiongradeitemnumber, $cm->completionpassgrade]);
    $slots = $DB->count_records('quiz_slots', ['quizid' => $q->id]);
    $random = $DB->count_records('question_set_references', ['usingcontextid' => $ctx->id, 'component' => 'mod_quiz', 'questionarea' => 'slot']);
    $fixed = $DB->count_records('question_references', ['usingcontextid' => $ctx->id, 'component' => 'mod_quiz', 'questionarea' => 'slot']);
    $mode = ($random === $slots && $fixed === 0) ? 'bank' : (($fixed === $slots && $random === 0) ? 'gift' : 'mixed');
    check("$idn: slots todos aleatorios o todos fijos ($slots slots: $random aleatorios, $fixed fijos)", $slots > 0 && $mode !== 'mixed');
    $sum = (float)$DB->get_field_sql('SELECT SUM(maxmark) FROM {quiz_slots} WHERE quizid = ?', [$q->id]);
    check("$idn: Σ maxmark = 100", abs($sum - 100) < 1e-6, $sum);
    $leafRefs = [];
    if ($mode === 'bank') {
        $bad = [];
        foreach (slot_leaf($cm) as $slot => $fc) {
            $cat = $fc['filter']['category'] ?? null;
            $catid = (int)($cat['values'][0] ?? 0);
            $c = $DB->get_record('question_categories', ['id' => $catid]);
            $leaf = $c && !$DB->record_exists('question_categories', ['parent' => $catid]);
            if (!$c || (int)$c->contextid !== (int)$ctx->id || !$leaf || count($cat['values']) !== 1 || ($cat['filteroptions']['includesubcategories'] ?? true) !== false) {
                $bad[$slot] = $fc;
            }
            $leafRefs[$catid] = ($leafRefs[$catid] ?? 0) + 1;
        }
        check("$idn: cada slot aleatorio → UNA hoja del contexto del quiz, includesubcategories false", !$bad, $bad);
        $under = [];
        foreach ($leafRefs as $catid => $refs) {
            $n = $DB->count_records('question_bank_entries', ['questioncategoryid' => $catid]);
            if ($n < max($refs + 1, (int)ceil(1.5 * $refs))) $under[$catid] = [$n, $refs];
        }
        check("$idn: cada hoja con ≥ bankFloor(slots) preguntas", !$under, $under);
    }
    // Página «Respuestas explicadas»
    $p = $Q['page'];
    check("$idn: tiene su página {$Q['pageidn']}", $p && $p->modname === 'page');
    if ($p) {
        $want = $attempts > 0
            ? sprintf('{"op":"|","show":false,"c":[{"type":"completion","cm":%d,"e":1},{"type":"completion","cm":%d,"e":3}]}', $cm->id, $cm->id)
            : sprintf('{"op":"|","show":false,"c":[{"type":"completion","cm":%d,"e":1}]}', $cm->id);
        $avail = $DB->get_field('course_modules', 'availability', ['id' => $p->id]);
        check("{$Q['pageidn']}: availability remapeada al cmid restaurado de su quiz ($cm->id), " . ($attempts > 0 ? 'e=1|e=3' : 'solo e=1'), $avail === $want, $avail);
        $seq = array_map('intval', explode(',', $DB->get_field('course_sections', 'sequence', ['id' => $cm->section])));
        $i = array_search((int)$cm->id, $seq, true);
        check("{$Q['pageidn']}: misma sección y justo después del quiz", (int)$p->section === (int)$cm->section && $i !== false && ($seq[$i + 1] ?? null) === (int)$p->id, $seq);
        check("{$Q['pageidn']}: completion 0, downloadcontent 0, no es criterio del curso",
            (int)$p->completion === 0 && (int)$DB->get_field('course_modules', 'downloadcontent', ['id' => $p->id]) === 0 && !in_array((int)$p->id, $criteria, true));
    }
    $config[$idn] = ['mode' => $mode, 'attempts' => $attempts, 'slots' => $slots, 'leafRefs' => $leafRefs, 'cmid' => (int)$cm->id];
}

// ── insignia (restaurada inactiva; el docente la activa) ──
$badgeid = $DB->get_field('badge', 'id', ['courseid' => $courseid]);
$badge = $badgeid ? new badge($badgeid) : null;
$badgeStatusBefore = $badge ? (int)$badge->status : null; // T3: restaurada inactiva (una corrida previa ya la activó)
if ($badge && !$badge->is_active()) $badge->set_status(BADGE_STATUS_ACTIVE);

// ── intentos reales ──
function answer_post($qa, $correct) {
    $q = $qa->get_question();
    $post = [$qa->get_control_field_name('sequencecheck') => (string)$qa->get_sequence_check_count()];
    $right = $q->get_correct_response();
    $type = $q->get_type_name();
    if ($correct) {
        $resp = $right;
    } else if ($type === 'multichoice' && isset($right['answer'])) {
        $resp = ['answer' => ($right['answer'] + 1) % count($q->get_order($qa))];
    } else if ($type === 'truefalse') {
        $resp = ['answer' => 1 - $right['answer']];
    } else if ($type === 'match') {
        $keys = array_keys($right); $vals = array_values($right);
        $resp = array_combine($keys, array_merge(array_slice($vals, 1), array_slice($vals, 0, 1)));
    } else {
        $resp = []; // sin respuesta = 0 puntos
    }
    foreach ($resp as $k => $v) $post[$qa->get_qt_field_name($k)] = (string)$v;
    return $post;
}
function leaf_of_question($qid) {
    global $DB;
    return (int)$DB->get_field_sql('SELECT qbe.questioncategoryid FROM {question_bank_entries} qbe
        JOIN {question_versions} qv ON qv.questionbankentryid = qbe.id WHERE qv.questionid = ?', [$qid]);
}
/** Un intento REAL, todo correcto o todo incorrecto. Devuelve id, nota y el sorteo por hoja. */
function attempt($idn, $user, $correct) {
    global $gen, $quizzes, $config;
    $cm = $quizzes[$idn]['cm'];
    \core\session\manager::set_user($user);
    $a = $gen->get_plugin_generator('mod_quiz')->create_attempt($cm->instance, $user->id);
    $ao = quiz_attempt::create($a->id);
    $filters = $config[$idn]['mode'] === 'bank' ? slot_leaf($cm) : [];
    $post = []; $outside = []; $perleaf = [];
    foreach ($ao->get_slots() as $slot) {
        $qa = $ao->get_question_attempt($slot);
        $post += answer_post($qa, $correct);
        if ($filters) {
            $leaf = leaf_of_question($qa->get_question()->id);
            if ($leaf !== (int)($filters[$slot]['filter']['category']['values'][0] ?? 0)) $outside[] = $slot;
            $perleaf[$leaf] = ($perleaf[$leaf] ?? 0) + 1;
        }
    }
    $ao->process_submitted_actions(time(), false, $post);
    $ao->process_finish(time(), false);
    $ao = quiz_attempt::create($a->id);
    $grade = (float)quiz_rescale_grade($ao->get_sum_marks(), $ao->get_quiz(), false);
    // Opciones de revisión de ESTE intento, vistas por el estudiante (antes del cierre).
    $o = $ao->get_display_options(true);
    $review = ['attempt' => (bool)$o->attempt, 'correctness' => (int)$o->correctness, 'marks' => (int)$o->marks,
        'rightanswer' => (int)$o->rightanswer, 'feedback' => (int)$o->feedback, 'generalfeedback' => (int)$o->generalfeedback,
        // QUIZFB: la retroalimentación global («aprobaste / todavía no») se ve AL TERMINAR, con el texto de la banda de la nota real.
        'overallfeedback' => (bool)$o->overallfeedback,
        'overallText' => trim(html_entity_decode(strip_tags(quiz_feedback_for_grade($grade, $ao->get_quiz(), context_module::instance($cm->id))), ENT_QUOTES | ENT_HTML5))];
    $gpass = (float)grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'quiz', 'iteminstance' => $cm->instance, 'courseid' => $cm->course])->gradepass;
    $review['passed'] = $grade >= $gpass - 1e-9;
    $qs = quiz_settings::create($ao->get_quizid(), $user->id);
    [$some] = quiz_get_combined_reviewoptions($qs->get_quiz(), quiz_get_user_attempts($ao->get_quizid(), $user->id, 'finished', true));
    // Enlace «Revisión» de la tabla de intentos de view.php (access_manager::make_review_link, la misma regla
    // que usa review.php para dejar pasar o rebotar con «No tiene permiso para revisar este cuestionario»).
    global $PAGE;
    $PAGE = new moodle_page();
    $PAGE->set_url('/mod/quiz/view.php', ['id' => $cm->id]);
    $PAGE->set_context(context_module::instance($cm->id));
    $link = $qs->get_access_manager(time())->make_review_link($ao->get_attempt(), null, $PAGE->get_renderer('mod_quiz'));
    $view = ['gradeColumn' => $some->marks >= display_options::MARK_AND_MAX, 'reviewLink' => str_contains($link, '/mod/quiz/review.php')];
    // V542 fix round 1 (I1): «más tarde, abierto» (LATER_WHILE_OPEN): sin página de revisión, nota total visible;
    // el ítem del libro de calificaciones queda VISIBLE (quiz_grade_item_update: marks en O) con la nota del intento.
    $later = display_options::make_from_quiz($qs->get_quiz(), display_options::LATER_WHILE_OPEN);
    $gi = grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'quiz', 'iteminstance' => $cm->instance, 'courseid' => $cm->course]);
    $gg = $gi ? grade_grade::fetch(['itemid' => $gi->id, 'userid' => $user->id]) : null;
    $view['later'] = ['attempt' => (bool)$later->attempt, 'marks' => (int)$later->marks, 'gradeItemHidden' => $gi ? (int)$gi->hidden : null,
        'gradebookGrade' => $gg && $gg->finalgrade !== null ? (float)$gg->finalgrade : null];
    $review['page'] = render_review($ao, $cm);
    \core\session\manager::set_user(get_admin());
    if ($filters) {
        ksort($perleaf); $want = $config[$idn]['leafRefs']; ksort($want);
        check("$idn: intento " . ($correct ? 'aprobado' : 'reprobado') . ": cada pregunta sorteada sale de la hoja de su slot; por hoja = referencias",
            !$outside && $perleaf === $want, ['outside' => $outside, 'perleaf' => $perleaf, 'want' => $want]);
    }
    return ['id' => (int)$a->id, 'grade' => $grade, 'review' => $review, 'view' => $view];
}
/**
 * V542 I4: renderiza la página de revisión del intento COMO EL ESTUDIANTE (antes del cierre), igual que
 * review.php, y busca lo que NO debe aparecer: corrección por opción, respuesta correcta, feedback
 * específico (incluido el texto del feedback de la opción elegida) y general. Sí debe verse la nota.
 */
function render_review($ao, $cm) {
    global $PAGE;
    $PAGE = new moodle_page();
    $PAGE->set_url('/mod/quiz/review.php', ['attempt' => $ao->get_attemptid()]);
    $PAGE->set_context(context_module::instance($cm->id));
    $PAGE->set_cm($cm);
    $renderer = $PAGE->get_renderer('mod_quiz');
    $leaks = []; $graded = 0; $n = 0;
    foreach ($ao->get_slots() as $slot) {
        $n++;
        $qa = $ao->get_question_attempt($slot);
        $q = $qa->get_question();
        $html = $ao->render_question($slot, true, $renderer, $ao->review_url($slot));
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5);
        $why = [];
        foreach (['rightanswer', 'generalfeedback', 'specificfeedback', 'outcome'] as $cls) {
            if (preg_match('/class="[^"]*\b' . $cls . '\b/', $html)) $why[] = "div.$cls";
        }
        if (preg_match('/class="r\d+ (correct|incorrect|partiallycorrect)\b/', $html)) $why[] = 'opción marcada correcta/incorrecta';
        if (preg_match('/class="[^"]*\b(correct|incorrect|partiallycorrect)\b[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*(Correct|Incorrect|Partially correct|Correcta|Incorrecta)/i', $html)) $why[] = 'estado correcta/incorrecta';
        $gf = trim(html_entity_decode(strip_tags((string)$q->generalfeedback), ENT_QUOTES | ENT_HTML5));
        if ($gf !== '' && str_contains($text, $gf)) $why[] = 'texto del feedback general';
        $type = $q->get_type_name();
        if ($type === 'multichoice' || $type === 'truefalse') {
            $resp = $qa->get_last_qt_data();
            if (isset($resp['answer'])) {
                if ($type === 'multichoice') { $order = $q->get_order($qa); $fbraw = $q->answers[$order[(int)$resp['answer']]]->feedback ?? ''; }
                else { $fbraw = (int)$resp['answer'] ? $q->truefeedback : $q->falsefeedback; }
                $fb = trim(html_entity_decode(strip_tags((string)$fbraw), ENT_QUOTES | ENT_HTML5));
                if ($fb !== '' && str_contains($text, $fb)) $why[] = 'texto del feedback de la opción elegida';
            }
        }
        if (preg_match('/class="grade"/', $html)) $graded++;
        // V542 fix round 1 (I1): la nota OBTENIDA por pregunta («Puntúa 0,00 sobre 5,88») junto a la respuesta propia
        // revela la correcta (V/F). Solo se admite «Puntúa como 5,88» (MAX_ONLY).
        $dp = $ao->get_display_options(true)->markdp;
        $markStr = get_string('markoutofmax', 'question', (object)['mark' => $qa->format_mark($dp), 'max' => $qa->format_max_mark($dp)]);
        if ($qa->get_mark() !== null && str_contains($text, html_entity_decode(strip_tags($markStr), ENT_QUOTES | ENT_HTML5))) $why[] = 'nota obtenida por pregunta';
        if ($why) $leaks[$slot] = $q->name . ': ' . implode(', ', $why);
    }
    return ['questions' => $n, 'withMark' => $graded, 'leaks' => $leaks];
}
function assert_marks_only($label, $r) {
    check("$label: al terminar se puede revisar (sin «No tiene permiso para revisar»): respuestas propias SIN nota por pregunta, corrección, respuesta correcta ni feedback",
        $r['review']['attempt'] === true && $r['review']['correctness'] === 0 && $r['review']['rightanswer'] === 0 && $r['review']['feedback'] === 0
        && $r['review']['generalfeedback'] === 0 && $r['review']['marks'] === display_options::MAX_ONLY && $r['view']['reviewLink'] === true, $r);
    check("$label: más tarde (abierto): sin página de revisión; nota total visible en view.php y en el libro de calificaciones (ítem visible, nota {$r['grade']})",
        $r['view']['later']['attempt'] === false && $r['view']['later']['marks'] >= display_options::MARK_AND_MAX
        && $r['view']['later']['gradeItemHidden'] === 0 && $r['view']['later']['gradebookGrade'] !== null, $r['view']);
    // QUIZFB: al terminar, la retroalimentación global dice si aprobó (la nota por pregunta sigue oculta).
    $want = $r['review']['passed'] ? 'Aprobaste esta evaluación' : 'Todavía no alcanzas la nota mínima';
    check("$label: al terminar se ve la retroalimentación global «" . ($r['review']['passed'] ? 'aprobaste' : 'todavía no') . "» (nota {$r['grade']})",
        $r['review']['overallfeedback'] === true && str_starts_with($r['review']['overallText'], $want), $r['review']);
    $p = $r['review']['page'];
    check("$label: página de revisión renderizada como el estudiante: {$p['questions']} preguntas, «Puntúa como» en cada una, 0 fugas (nota obtenida, respuesta, corrección, feedback)",
        $p['questions'] > 0 && $p['withMark'] === $p['questions'] && !$p['leaks'], $p);
}
/** Aprueba (nota real) todo criterio de completion que no es un quiz. */
function pass_non_quiz($user) {
    global $DB, $course, $courseid, $modinfo;
    $ci = new completion_info($course);
    foreach ($DB->get_fieldset_select('course_completion_criteria', 'moduleinstance', 'course = ? AND criteriatype = 4', [$courseid]) as $cmid) {
        $cm = $modinfo->get_cm($cmid);
        if ($cm->modname === 'quiz') continue;
        grade_update('mod/' . $cm->modname, $courseid, 'mod', $cm->modname, $cm->instance, 0, ['userid' => $user->id, 'rawgrade' => 100]);
        $ci->update_state($cm, COMPLETION_UNKNOWN, $user->id);
    }
}
function state($user, $idn) {
    global $course, $quizzes, $NAMES, $badge, $DB;
    sleep(1); // aggregate_completions solo toma filas con reaggregate < time()
    ob_start(); (new \core\task\completion_regular_task())->execute(); ob_end_clean();
    get_fast_modinfo($course->id, 0, true);
    $mi = get_fast_modinfo($course, $user->id);
    $ci = new completion_info($course);
    $s = ['completion' => $NAMES[$ci->get_data($mi->get_cm($quizzes[$idn]['cm']->id), false, $user->id)->completionstate]];
    if ($quizzes[$idn]['page']) {
        $p = $mi->get_cm($quizzes[$idn]['page']->id);
        $s['page'] = ['available' => (bool)$p->available, 'uservisible' => (bool)$p->uservisible];
    }
    $s['courseComplete'] = (new completion_completion(['userid' => $user->id, 'course' => $course->id]))->is_complete();
    if ($badge) $s['badge'] = $DB->record_exists('badge_issued', ['badgeid' => $badge->id, 'userid' => $user->id]);
    return $s;
}
$studentrole = $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
function student($tag) {
    global $gen, $courseid, $studentrole, $RUN;
    $u = $gen->create_user(['username' => strtolower("p2b5_{$tag}_{$courseid}_{$RUN}"), 'firstname' => $tag, 'lastname' => 'P2B5']);
    $gen->enrol_user($u->id, $courseid, $studentrole);
    return $u;
}
$locked = fn($s) => isset($s['page']) && $s['page']['available'] === false && $s['page']['uservisible'] === false;
$open = fn($s) => isset($s['page']) && $s['page']['available'] === true && $s['page']['uservisible'] === true;
$steps = [];
$exam = $moduleExams[0] ?? $final;
$N = $config[$exam]['attempts'];

// Nota para docentes: el estudiante no la ve.
$probe = student('probe');
$mi = get_fast_modinfo($course, $probe->id);
foreach (['cv3:shell:certificate_teacher', 'cv3:shell:exams_teacher'] as $idn) {
    if (isset($byid[$idn])) check("$idn: el estudiante no lo ve", $mi->get_cm($byid[$idn]->id)->uservisible === false);
}
foreach ($quizzes as $idn => $Q) {
    if ($Q['page']) {
        $s = state($probe, $idn);
        check("{$Q['pageidn']}: bloqueada antes de presentar", $locked($s), $s);
    }
}

// ── A / U: reprueba el examen ──
if ($N > 0) {
    $A = student('A');
    for ($k = 1; $k <= $N; $k++) {
        $r = attempt($exam, $A, false);
        assert_marks_only("A $exam intento $k reprobado", $r);
        $s = state($A, $exam);
        $steps['A'][] = ['step' => "intento $k reprobado", 'grade' => $r['grade']] + $s;
        if ($k < $N) check("A $exam intento $k/$N reprobado: INCOMPLETE y página BLOQUEADA", $s['completion'] === 'INCOMPLETE' && $locked($s), $s);
        else check("A $exam intentos agotados ($N) sin aprobar: COMPLETE_FAIL y página DISPONIBLE", $s['completion'] === 'COMPLETE_FAIL' && $open($s), $s);
    }
    pass_non_quiz($A);
    foreach (array_keys($quizzes) as $idn) if ($idn !== $exam) attempt($idn, $A, true);
    $s = state($A, $exam);
    $steps['A'][] = ['step' => 'todo lo demás aprobado'] + $s;
    check("A: con $exam agotado sin aprobar, el curso NO se completa" . ($badge ? ' ni recibe la insignia' : ''), $s['courseComplete'] === false && empty($s['badge']), $s);
} else {
    $U = student('U');
    foreach ([1, 2] as $k) {
        $r = attempt($exam, $U, false);
        assert_marks_only("U $exam intento $k reprobado (ilimitados)", $r);
        $s = state($U, $exam);
        $steps['U'][] = ['step' => "intento $k reprobado", 'grade' => $r['grade']] + $s;
        check("U $exam (intentos ilimitados) intento $k reprobado: página BLOQUEADA", $locked($s) && $s['completion'] !== 'COMPLETE_PASS', $s);
    }
    $r = attempt($exam, $U, true);
    $s = state($U, $exam);
    $steps['U'][] = ['step' => 'intento 3 aprobado', 'grade' => $r['grade']] + $s;
    check("U $exam (intentos ilimitados) aprobado: COMPLETE_PASS y página DISPONIBLE", $s['completion'] === 'COMPLETE_PASS' && $open($s), $s);
    pass_non_quiz($U);
    foreach (array_keys($quizzes) as $idn) if ($idn !== $exam) attempt($idn, $U, true);
    $s = state($U, $exam);
    $steps['U'][] = ['step' => 'todo lo demás aprobado'] + $s;
    check('U: todo aprobado → curso completo', $s['courseComplete'] === true, $s);
}

// ── B: aprueba al primer intento ──
$B = student('B');
$r = attempt($exam, $B, true);
assert_marks_only("B $exam intento 1 aprobado", $r);
// Control del detector de fugas (V542 I4): tras el cierre (timeclose en el pasado, AFTER_CLOSE) la MISMA
// página sí revela respuesta correcta y feedback → el detector debe encontrarlos; luego se reabre el quiz.
$DB->set_field('quiz', 'timeclose', time() - 60, ['id' => $quizzes[$exam]['cm']->instance]);
\core\session\manager::set_user($B);
$closed = render_review(quiz_attempt::create($r['id']), $quizzes[$exam]['cm']);
\core\session\manager::set_user(get_admin());
$DB->set_field('quiz', 'timeclose', 0, ['id' => $quizzes[$exam]['cm']->instance]);
check("control: tras el cierre el detector SÍ ve respuesta/feedback ({$closed['questions']} preguntas, " . count($closed['leaks']) . ' con revelación)',
    $closed['questions'] > 0 && count($closed['leaks']) === $closed['questions']
    // V542 fix round 1 (I1): el detector de la nota obtenida por pregunta también la ve tras el cierre.
    && count(array_filter($closed['leaks'], fn($l) => str_contains($l, 'nota obtenida por pregunta'))) === $closed['questions'], $closed);
$s = state($B, $exam);
$steps['B'][] = ['step' => 'intento 1 aprobado', 'grade' => $r['grade']] + $s;
check("B $exam aprobado al primer intento: COMPLETE_PASS y página DISPONIBLE", $s['completion'] === 'COMPLETE_PASS' && $open($s) && $r['grade'] >= 99.99, $s);
check('B: con evaluaciones pendientes el curso no se completa', $s['courseComplete'] === false || count($quizzes) === 1, $s);
pass_non_quiz($B);
foreach (array_keys($quizzes) as $idn) if ($idn !== $exam) attempt($idn, $B, true);
$s = state($B, $exam);
$steps['B'][] = ['step' => 'todo lo demás aprobado'] + $s;
check('B: todo aprobado con intentos reales → curso completo' . ($badge ? ' e insignia emitida' : ''), $s['courseComplete'] === true && (!$badge || $s['badge'] === true), $s);

// ── C: agota el final sin aprobar ──
if ($final && $final !== $exam && $config[$final]['attempts'] > 0) {
    $C = student('C');
    pass_non_quiz($C);
    foreach (array_keys($quizzes) as $idn) if ($idn !== $final) attempt($idn, $C, true);
    $F = $config[$final]['attempts'];
    for ($k = 1; $k <= $F; $k++) {
        $r = attempt($final, $C, false);
        if ($k === 1) assert_marks_only("C $final intento 1 reprobado", $r);
        $s = state($C, $final);
        $steps['C'][] = ['step' => "final intento $k reprobado"] + $s;
        if ($k < $F) check("C final intento $k/$F reprobado: INCOMPLETE y su página BLOQUEADA", $s['completion'] === 'INCOMPLETE' && $locked($s), $s);
    }
    check("C final agotado sin aprobar: COMPLETE_FAIL, su página DISPONIBLE, curso NO completo" . ($badge ? ', sin insignia' : ''),
        $s['completion'] === 'COMPLETE_FAIL' && $open($s) && $s['courseComplete'] === false && empty($s['badge']), $s);
}

$failed = array_values(array_filter($assertions, fn($a) => !$a['ok']));
$out = ['courseid' => $courseid, 'pass' => !$failed, 'assertions' => count($assertions), 'failed' => $failed,
    'quizzes' => $config, 'scenarioExam' => $exam, 'badgeStatusBefore' => $badgeStatusBefore, 'steps' => $steps, 'all' => $assertions];
file_put_contents($outfile, json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
echo ($failed ? 'FAIL' : 'OK') . ' ' . (count($assertions) - count($failed)) . '/' . count($assertions) . "\n";
exit($failed ? 1 : 0);
}

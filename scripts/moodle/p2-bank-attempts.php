<?php
// Cursia EV6 P2-B3: prueba REAL de los exámenes con banco en el Moodle 4.5 LOCAL desechable, sobre un
// curso YA restaurado (restore-and-inspect.sh) de un paquete con `dynamic_exam_bank_json`.
// Adaptado de scratchpad/r18/p2-ref/simulate.php (P2-design §1.2/§2):
//   1. lee lo restaurado de cada quiz: política de revisión (P2-B1), completion, gradepass, slots
//      aleatorios (question_set_references) → categoría hoja, árbol de categorías y preguntas por hoja;
//   2. un estudiante toma 3 intentos REALES (quiz_attempt API) en un examen de módulo: reprobado (0 %),
//      reprobado (0 %), aprobado (100 %). Por intento: slots = los del plan, cada pregunta sorteada es
//      de la hoja de SU slot (filtercondition restaurado), cobertura capítulo × tipo, nota y completion;
//   3. el mismo estudiante aprueba el examen final (100 %);
//   4. un profesor fija `timeclose` en el pasado → opciones de revisión AFTER_CLOSE (feedback 1,
//      generalfeedback 1) y el HTML de la pregunta revisada contiene la explicación y el `why`;
//   5. (fix 1) emparejamiento: la DEFINICIÓN es la subpregunta y el TÉRMINO la opción del desplegable,
//      y cada término se ve LITERAL en las <option> renderizadas (format_string no le come texto).
//      Con <banks.json> (sidecar de check-p2-bank-xml.js --out) compara contra los pares del banco.
// Crea usuarios/intentos solo en ESE curso de prueba; no cambia configuración del sitio.
//
// Uso: php -c php.ini p2-bank-attempts.php <moodleRoot> <courseid> <output.json> [banks.json]
namespace PHPUnit\Framework { if (!class_exists('PHPUnit\Framework\TestCase', false)) { abstract class TestCase { public function __construct($name = null) {} } } }
namespace PHPUnit\Framework\Constraint { if (!class_exists('PHPUnit\Framework\Constraint\Constraint', false)) { abstract class Constraint {} } }
namespace {
define('CLI_SCRIPT', true);
require($argv[1] . '/config.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/mod/quiz/locallib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/gradelib.php');

use mod_quiz\quiz_attempt;
use mod_quiz\quiz_settings;

global $DB, $CFG, $PAGE;
$CFG->noemailever = true;
$courseid = (int)$argv[2];
$admin = get_admin();
\core\session\manager::set_user($admin);
$gen = new testing_data_generator();
$course = get_course($courseid);
$modinfo = get_fast_modinfo($course);
$quizzes = [];
foreach ($modinfo->get_cms() as $cm) {
    if ($cm->modname === 'quiz') $quizzes[$cm->idnumber] = $cm;
}
$bankpairs = [];
if (!empty($argv[4])) {
    $banks = json_decode(file_get_contents($argv[4]), true);
    foreach (array_merge(array_values($banks['modules']), [$banks['final']]) as $b) {
        foreach ($b['questions'] as $bq) { if ($bq['type'] === 'match') $bankpairs[$bq['id']] = $bq['pairs']; }
    }
}
$names = [0 => 'INCOMPLETE', 1 => 'COMPLETE', 2 => 'COMPLETE_PASS', 3 => 'COMPLETE_FAIL'];

/** Slot → categoría del filtercondition restaurado. */
function slot_filters($cm) {
    global $DB;
    $ctx = context_module::instance($cm->id);
    $out = [];
    foreach ($DB->get_records('quiz_slots', ['quizid' => $cm->instance], 'slot') as $s) {
        $ref = $DB->get_record('question_set_references', ['usingcontextid' => $ctx->id, 'component' => 'mod_quiz', 'questionarea' => 'slot', 'itemid' => $s->id]);
        $out[(int)$s->slot] = $ref ? json_decode($ref->filtercondition, true) : null;
    }
    return $out;
}
function cat_of_question($qid) {
    global $DB;
    return $DB->get_record_sql('SELECT qc.id, qc.name, qc.parent FROM {question_categories} qc JOIN {question_bank_entries} qbe ON qbe.questioncategoryid = qc.id
        JOIN {question_versions} qv ON qv.questionbankentryid = qbe.id WHERE qv.questionid = ?', [$qid]);
}
function cat_tree($cm) {
    global $DB;
    $ctx = context_module::instance($cm->id);
    $cats = $DB->get_records('question_categories', ['contextid' => $ctx->id], 'id');
    $byid = [];
    foreach ($cats as $c) $byid[$c->id] = $c;
    $out = [];
    foreach ($cats as $c) {
        $n = $DB->count_records('question_bank_entries', ['questioncategoryid' => $c->id]);
        $out[] = ['id' => (int)$c->id, 'name' => $c->name, 'parent' => $c->parent ? ($byid[$c->parent]->name ?? $c->parent) : 0,
            'sortorder' => (int)$c->sortorder, 'questions' => $n];
    }
    return $out;
}
/** Respuestas correctas o todas incorrectas para multichoice / truefalse / match. */
function answer_post($qa, $correct) {
    $q = $qa->get_question();
    $right = $q->get_correct_response();
    $post = [$qa->get_control_field_name('sequencecheck') => (string)$qa->get_sequence_check_count()];
    switch ($q->get_type_name()) {
        case 'multichoice':
            $resp = ['answer' => $correct ? $right['answer'] : (($right['answer'] + 1) % count($q->get_order($qa)))];
            break;
        case 'truefalse':
            $resp = ['answer' => $correct ? $right['answer'] : 1 - $right['answer']];
            break;
        case 'match':
            // incorrecto: rota las elecciones correctas (todas distintas) → ninguna subpregunta acierta
            $keys = array_keys($right);
            $vals = array_values($right);
            $resp = $correct ? $right : array_combine($keys, array_merge(array_slice($vals, 1), array_slice($vals, 0, 1)));
            break;
        default:
            throw new coding_exception('qtype inesperado ' . $q->get_type_name());
    }
    foreach ($resp as $k => $v) $post[$qa->get_qt_field_name($k)] = (string)$v;
    return $post;
}
function do_attempt($cm, $user, $correct) {
    global $gen;
    \core\session\manager::set_user($user);
    $attempt = $gen->get_plugin_generator('mod_quiz')->create_attempt($cm->instance, $user->id);
    $ao = quiz_attempt::create($attempt->id);
    $filters = slot_filters($cm);
    $post = [];
    $drawn = [];
    $mismatch = [];
    $perleaf = [];
    foreach ($ao->get_slots() as $slot) {
        $qa = $ao->get_question_attempt($slot);
        $q = $qa->get_question();
        $post += answer_post($qa, $correct);
        $cat = cat_of_question($q->id);
        $want = $filters[$slot]['filter']['category']['values'][0] ?? null;
        if ((int)$want !== (int)$cat->id) $mismatch[] = $slot;
        $drawn[$slot] = $q->name;
        $perleaf[$cat->name] = ($perleaf[$cat->name] ?? 0) + 1;
    }
    $ao->process_submitted_actions(time(), false, $post);
    $ao->process_finish(time(), false);
    \core\session\manager::set_user(get_admin());
    $ao = quiz_attempt::create($attempt->id);
    return ['id' => (int)$attempt->id, 'slots' => count($drawn), 'drawn' => $drawn, 'slotsOutsideTheirLeaf' => $mismatch,
        'slotsPerLeaf' => $perleaf, 'sumgrades' => (float)$ao->get_sum_marks(), 'grade(0-100)' => (float)quiz_rescale_grade($ao->get_sum_marks(), $ao->get_quiz(), false)];
}
function completion_of($cm, $userid) {
    global $course, $names;
    get_fast_modinfo($course->id, 0, true);
    $mi = get_fast_modinfo($course, $userid);
    $ci = new completion_info($course);
    return $names[$ci->get_data($mi->get_cm($cm->id), false, $userid)->completionstate];
}
function review_opts($attemptid, $user) {
    \core\session\manager::set_user($user);
    $o = quiz_attempt::create($attemptid)->get_display_options(true);
    \core\session\manager::set_user(get_admin());
    return ['attempt' => (bool)$o->attempt, 'correctness' => (int)$o->correctness, 'marks' => (int)$o->marks,
        'rightanswer' => (int)$o->rightanswer, 'feedback' => (int)$o->feedback, 'generalfeedback' => (int)$o->generalfeedback];
}

$out = ['courseid' => $courseid, 'quizzes' => []];
foreach ($quizzes as $idn => $cm) {
    $quiz = $DB->get_record('quiz', ['id' => $cm->instance], 'attempts,grade,sumgrades,reviewattempt,reviewcorrectness,reviewmarks,reviewmaxmarks,reviewrightanswer,reviewgeneralfeedback,reviewspecificfeedback,reviewoverallfeedback,completionattemptsexhausted');
    $filters = slot_filters($cm);
    $slotcats = [];
    foreach ($filters as $slot => $f) $slotcats[$slot] = $f === null ? null : ['values' => $f['filter']['category']['values'], 'includesubcategories' => $f['filter']['category']['filteroptions']['includesubcategories'] ?? null, 'cat' => $f['cat'] ?? null];
    $out['quizzes'][$idn] = [
        'name' => $cm->name,
        'quiz' => $quiz,
        'cm' => $DB->get_record('course_modules', ['id' => $cm->id], 'completion,completiongradeitemnumber,completionpassgrade'),
        'gradepass' => (float)grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'quiz', 'iteminstance' => $cm->instance, 'courseid' => $courseid])->gradepass,
        'slots' => count($filters),
        'randomSlots' => count(array_filter($filters)),
        'fixedReferences' => $DB->count_records('question_references', ['usingcontextid' => context_module::instance($cm->id)->id]),
        'maxmarkSum' => (float)$DB->get_field_sql('SELECT SUM(maxmark) FROM {quiz_slots} WHERE quizid = ?', [$cm->instance]),
        'slotFilters' => $slotcats,
        'categories' => cat_tree($cm),
    ];
}

$studentrole = $DB->get_field('role', 'id', ['shortname' => 'student']);
$S = $gen->create_user(['username' => 'p2b3_' . $courseid . '_' . substr(sha1(uniqid('', true)), 0, 6), 'firstname' => 'Estudiante', 'lastname' => 'Banco']);
$gen->enrol_user($S->id, $courseid, $studentrole);
$examcm = null;
foreach ($quizzes as $idn => $cm) { if (str_starts_with($idn, 'cv3:exam:')) { $examcm = $cm; break; } }
$finalcm = $quizzes['cv3:final_exam'] ?? null;

$run = [];
foreach ([false, false, true] as $i => $correct) {
    $a = do_attempt($examcm, $S, $correct);
    (new \core\task\completion_regular_task())->execute();
    $a['label'] = 'intento ' . ($i + 1) . ($correct ? ' (todo correcto)' : ' (todo incorrecto)');
    $a['completion'] = completion_of($examcm, $S->id);
    $a['reviewBeforeClose'] = review_opts($a['id'], $S);
    $run[] = $a;
}
$sets = array_map(fn($a) => implode(',', $a['drawn']), $run);
$out['moduleExam'] = ['idnumber' => $examcm->idnumber, 'attempts' => $run,
    'distinctDraws' => count(array_unique($sets)),
    'bestGrade' => (float)quiz_get_best_grade($DB->get_record('quiz', ['id' => $examcm->instance]), $S->id),
    'gradebook' => (float)grade_get_grades($courseid, 'mod', 'quiz', $examcm->instance, $S->id)->items[0]->grades[$S->id]->grade];
if ($finalcm) {
    $f = do_attempt($finalcm, $S, true);
    $f['completion'] = completion_of($finalcm, $S->id);
    $out['finalExam'] = $f;
}

// AFTER_CLOSE: un profesor fija el cierre en el pasado → se revela todo (feedback por opción + general).
$DB->set_field('quiz', 'timeclose', time() - 60, ['id' => $examcm->instance]);
$a1 = $run[0]['id'];
$out['afterClose'] = ['attempt1' => review_opts($a1, $S)];
\core\session\manager::set_user($S);
$PAGE->set_url('/mod/quiz/review.php', ['attempt' => $a1]);
$PAGE->set_context(context_module::instance($examcm->id));
$ao = quiz_attempt::create($a1);
$checked = [];
foreach (array_slice($ao->get_slots(), 0, 40) as $slot) {
    $q = $ao->get_question_attempt($slot)->get_question();
    $html = $ao->render_question($slot, true, $PAGE->get_renderer('mod_quiz'), $ao->review_url($slot));
    $gf = trim(html_entity_decode(strip_tags($q->generalfeedback), ENT_QUOTES));
    $row = ['slot' => $slot, 'question' => $q->name, 'qtype' => $q->get_type_name(),
        'generalfeedbackShown' => str_contains(html_entity_decode(strip_tags($html), ENT_QUOTES), $gf)];
    if ($q->get_type_name() === 'multichoice' || $q->get_type_name() === 'truefalse') {
        // la respuesta (incorrecta) elegida muestra SU retroalimentación
        $resp = $ao->get_question_attempt($slot)->get_last_qt_data();
        if ($q->get_type_name() === 'multichoice') {
            $order = $q->get_order($ao->get_question_attempt($slot));
            $fbraw = $q->answers[$order[(int)$resp['answer']]]->feedback ?? '';
        } else {
            $fbraw = (int)$resp['answer'] ? $q->truefeedback : $q->falsefeedback;
        }
        $fb = trim(html_entity_decode(strip_tags($fbraw), ENT_QUOTES));
        $row['chosenOptionFeedbackShown'] = $fb !== '' && str_contains(html_entity_decode(strip_tags($html), ENT_QUOTES), $fb);
    }
    if ($q->get_type_name() === 'match') {
        // Opciones del desplegable tal como las ve el estudiante (format_string + escape del <select>).
        preg_match_all('#<option[^>]*>(.*?)</option>#s', $html, $m);
        $shown = array_map(fn($o) => html_entity_decode($o, ENT_QUOTES | ENT_HTML5), $m[1]);
        $choices = array_values(array_unique(array_values($q->choices)));
        $stems = array_values($q->stems);
        $row['matchChoicesRenderedVerbatim'] = count($choices) > 0 && !array_diff($choices, $shown);
        $text = html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5);
        $row['matchStemsRenderedVerbatim'] = !array_filter($stems, fn($st) => !str_contains($text, $st));
        if (isset($bankpairs[$q->name])) {
            $defs = array_column($bankpairs[$q->name], 'definition');
            $terms = array_column($bankpairs[$q->name], 'term');
            sort($defs); sort($terms); $s2 = $stems; sort($s2); $c2 = $choices; sort($c2);
            $row['matchOrientation'] = ($s2 === $defs && $c2 === $terms) ? 'definición→subpregunta, término→opción' : 'DISTINTA';
        }
        $row['sampleChoice'] = $choices[0] ?? null;
    }
    $checked[] = $row;
}
\core\session\manager::set_user($admin);
$out['afterClose']['questions'] = count($checked);
$out['afterClose']['generalfeedbackShownAll'] = count(array_filter($checked, fn($r) => $r['generalfeedbackShown'])) === count($checked);
$withfb = array_filter($checked, fn($r) => array_key_exists('chosenOptionFeedbackShown', $r));
$out['afterClose']['chosenOptionFeedbackShownAll'] = count(array_filter($withfb, fn($r) => $r['chosenOptionFeedbackShown'])) === count($withfb);
$matchrows = array_values(array_filter($checked, fn($r) => $r['qtype'] === 'match'));
$out['afterClose']['match'] = ['questions' => count($matchrows),
    'choicesRenderedVerbatimAll' => count($matchrows) > 0 && !array_filter($matchrows, fn($r) => !$r['matchChoicesRenderedVerbatim']),
    'stemsRenderedVerbatimAll' => count($matchrows) > 0 && !array_filter($matchrows, fn($r) => !$r['matchStemsRenderedVerbatim']),
    'orientationAll' => array_values(array_unique(array_map(fn($r) => $r['matchOrientation'] ?? 'sin banco', $matchrows))),
    'sample' => $matchrows[0] ?? null];
$out['afterClose']['sample'] = array_slice($checked, 0, 6);
$DB->set_field('quiz', 'timeclose', 0, ['id' => $examcm->instance]);

file_put_contents($argv[3], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
echo "ok\n";
}

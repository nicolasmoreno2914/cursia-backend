<?php
// T7 (r57) — aceptación de un curso de la SIMULACIÓN COMERCIAL ya restaurado en un Moodle LOCAL desechable (4.1–4.5).
// Solo LEE el curso (y crea UN estudiante ficticio que borra al terminar). No cambia la configuración del sitio.
//
// Verifica contra <expect.json> (escrito por scripts/check-commercial-simulation-moodle.js desde el .mbz y sus facts):
//   R0 restauración sin avisos (backup_logs ≤ WARNING del controller de restore de este curso)
//   R1 actividades por modname = paquete
//   R2 H5P evaluativo: tracking, ítem de nota y completion por nota; «Repaso» (Dialog Cards): sin nota, sin tracking,
//      sin ítem de nota, completion por vista
//   R3 evaluaciones: slots = plan; slots aleatorios (question_set_references) RESOLUBLES (categoría existente con
//      preguntas listas, formato legado o 4.3+); intentos y completionminattempts; «Respuestas explicadas» con
//      restricción de acceso por la completion de SU evaluación
//   R4 finalización del curso: UN criterio tipo 6 (nota del curso) con gradepass = ítem del curso; agregación ALL
//   R5 insignia: una, con criterio «finalización del curso» (BADGE_CRITERIA_TYPE_COURSE) de ESTE curso
//   R6 libro de calificaciones: media ponderada; categorías y pesos del perfil; las Tareas calificadas en su categoría
//   R7 archivos de práctica: recurso visible, UN archivo (nombre, mimetype, sha256) descargable por el estudiante
//   R8 guía del docente y solucionarios: ocultos; el estudiante no los ve (la guía además con mod/page:view PROHIBIT)
//
// Uso: php -c php.ini check-commercial-acceptance.php --moodle=<raíz> --courseid=<id> --expect=<json> --out=<json>
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'courseid:', 'expect:', 'out:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/badgeslib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
global $DB, $CFG;

$exp = json_decode(file_get_contents($opts['expect']), true);
$courseid = (int)$opts['courseid'];
$R = ['moodle' => $CFG->release, 'courseid' => $courseid, 'asserts' => [], 'counts' => []];
$ok = function ($c, string $m) use (&$R) { $R['asserts'][] = ['ok' => (bool)$c, 'msg' => $m]; return (bool)$c; };
$admin = get_admin();
\core\session\manager::set_user($admin);
$course = get_course($courseid);
$mi = get_fast_modinfo($courseid);
$byidn = [];
$counts = [];
foreach ($mi->get_cms() as $cm) {
    $counts[$cm->modname] = ($counts[$cm->modname] ?? 0) + 1;
    if ((string)$cm->idnumber !== '') $byidn[(string)$cm->idnumber] = $cm;
}
ksort($counts);
$R['counts'] = $counts;

// ── R0 ──
$rc = $DB->get_record_sql("SELECT backupid, status FROM {backup_controllers} WHERE operation = 'restore' AND type = 'course' AND itemid = ? ORDER BY id ASC", [$courseid], IGNORE_MULTIPLE);
$warn = $rc ? array_values($DB->get_fieldset_select('backup_logs', 'message', 'backupid = ? AND loglevel <= ?', [$rc->backupid, backup::LOG_WARNING])) : null;
$R['restoreWarnings'] = $warn;
$ok($rc && (int)$rc->status === backup::STATUS_FINISHED_OK, 'R0 restauración terminada OK (status ' . ($rc ? $rc->status : 'sin controller') . ')');
$ok(is_array($warn) && count($warn) === 0, 'R0 restauración con 0 avisos (' . json_encode($warn ? array_slice($warn, 0, 3) : $warn, JSON_UNESCAPED_UNICODE) . ')');

// ── R1 ──
$want = $exp['byModname'];
ksort($want);
$ok($counts == $want, 'R1 actividades por modname = paquete (' . json_encode($counts) . ' vs ' . json_encode($want) . ')');

// ── R2 ──
foreach ($exp['h5p'] as $h) {
    $cm = $byidn[$h['idnumber']] ?? null;
    if (!$ok((bool)$cm, "R2 {$h['idnumber']} restaurado")) continue;
    $a = $DB->get_record('h5pactivity', ['id' => $cm->instance]);
    $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'h5pactivity', 'iteminstance' => $cm->instance]);
    if ($h['evaluative']) {
        $ok((int)$a->enabletracking === 1 && $gi && (int)$cm->completion === 2 && $cm->completiongradeitemnumber !== null && (int)$cm->completionview === 0,
            "R2 {$h['idnumber']}: H5P evaluativo con tracking, ítem de nota y completion por nota");
    } else {
        $ok((int)$a->grade === 0 && (int)$a->enabletracking === 0 && !$gi && (int)$cm->completion === 2 && (int)$cm->completionview === 1,
            "R2 {$h['idnumber']}: «Repaso» sin nota ni tracking ni ítem, completion por vista");
    }
}

// ── R3 ──
$readyQuestions = function (int $catid) use ($DB): int {
    return (int)$DB->count_records_sql("SELECT COUNT(1) FROM {question_bank_entries} qbe JOIN {question_versions} qv ON qv.questionbankentryid = qbe.id
        WHERE qbe.questioncategoryid = ? AND qv.status = 'ready'", [$catid]);
};
foreach ($exp['quizzes'] as $q) {
    $cm = $byidn[$q['idnumber']] ?? null;
    if (!$ok((bool)$cm, "R3 {$q['idnumber']} restaurado")) continue;
    $quiz = $DB->get_record('quiz', ['id' => $cm->instance]);
    $slots = $DB->count_records('quiz_slots', ['quizid' => $quiz->id]);
    $ctx = context_module::instance($cm->id);
    $refs = array_values($DB->get_records('question_set_references', ['usingcontextid' => $ctx->id, 'component' => 'mod_quiz', 'questionarea' => 'slot']));
    $ok($slots === (int)$q['slots'], "R3 {$q['idnumber']}: slots $slots = plan {$q['slots']}");
    if ($q['random']) {
        $bad = [];
        foreach ($refs as $r) {
            $f = json_decode($r->filtercondition, true);
            $catid = isset($f['questioncategoryid']) ? (int)$f['questioncategoryid'] : (int)($f['filter']['category']['values'][0] ?? 0);
            $cat = $catid ? $DB->get_record('question_categories', ['id' => $catid]) : null;
            if (!$cat || $readyQuestions($catid) < 1) $bad[] = $r->id;
        }
        $ok(count($refs) === $slots && !$bad, "R3 {$q['idnumber']}: " . count($refs) . " slots aleatorios, todos resolubles (sin resolver: " . json_encode($bad) . ')');
    } else {
        $ok(count($refs) === 0, "R3 {$q['idnumber']}: preguntas fijas (sin slots aleatorios)");
    }
    $ok((int)$quiz->attempts === (int)$q['attempts'] && (int)$quiz->completionminattempts === (int)$quiz->attempts && (int)$cm->completion === 2,
        "R3 {$q['idnumber']}: intentos {$quiz->attempts} = {$q['attempts']}, completionminattempts = intentos, completion por nota");
    if (!empty($q['explanations'])) {
        $pcm = $byidn[$q['explanations']] ?? null;
        $av = $pcm && $pcm->availability ? json_decode($pcm->availability, true) : null;
        $refsQuiz = $av && strpos(json_encode($av), '"cm":' . $cm->id) !== false;
        $ok($pcm && $refsQuiz, "R3 {$q['explanations']}: «Respuestas explicadas» con acceso restringido por la completion de su evaluación");
    }
}

// ── R4 ──
$ci = grade_item::fetch_course_item($courseid);
$crit = array_values($DB->get_records('course_completion_criteria', ['course' => $courseid]));
$aggr = array_values($DB->get_records('course_completion_aggr_methd', ['course' => $courseid]));
$ok((int)$course->enablecompletion === 1, 'R4 finalización habilitada');
if (!empty($exp['withoutGrades'])) {
    // r58 (I6) · r55 R3: curso sin ítems calificables → un criterio de actividad (vista del Libro Guía), sin nota.
    $libro = null;
    foreach (get_fast_modinfo($courseid)->get_cms() as $cm) if ($cm->idnumber === 'cv3:shell:libro') $libro = $cm;
    $ok($libro && count($crit) === 1 && (int)$crit[0]->criteriatype === COMPLETION_CRITERIA_TYPE_ACTIVITY && (int)$crit[0]->moduleinstance === (int)$libro->id
        && (float)$ci->gradepass == 0.0, "R4 sin nota: UN criterio de actividad (vista del Libro Guía), gradepass del curso {$ci->gradepass} = 0");
} else
$ok(count($crit) === 1 && (int)$crit[0]->criteriatype === COMPLETION_CRITERIA_TYPE_GRADE && abs((float)$crit[0]->gradepass - (float)$ci->gradepass) < 1e-6
    && abs((float)$ci->gradepass - (float)$exp['courseGradepass']) < 1e-6, "R4 UN criterio tipo 6 (nota del curso) con gradepass {$ci->gradepass} = esperado {$exp['courseGradepass']}");
$ok(count($aggr) === 1 && $aggr[0]->criteriatype === null && (int)$aggr[0]->method === COMPLETION_AGGREGATION_ALL, 'R4 agregación ALL');

// ── R5 ──
$badges = array_values($DB->get_records('badge', ['courseid' => $courseid]));
if ($exp['badge']) {
    $bc = $badges ? array_values($DB->get_records('badge_criteria', ['badgeid' => $badges[0]->id])) : [];
    $courseCrit = array_values(array_filter($bc, fn($c) => (int)$c->criteriatype === BADGE_CRITERIA_TYPE_COURSE));
    $param = $courseCrit ? $DB->get_records('badge_criteria_param', ['critid' => $courseCrit[0]->id]) : [];
    $paramCourse = array_values(array_filter($param, fn($p) => strpos($p->name, 'course_') === 0 && (int)$p->value === $courseid));
    $ok(count($badges) === 1 && count($courseCrit) === 1 && count($paramCourse) === 1, 'R5 una insignia con criterio «finalización del curso» de este curso (' . count($badges) . ' insignias, ' . count($courseCrit) . ' criterios de curso)');
} else {
    $ok(count($badges) === 0, 'R5 sin insignia');
}

// ── R6 ──
$cc = grade_category::fetch_course_category($courseid);
$ok((int)$cc->aggregation === GRADE_AGGREGATE_WEIGHTED_MEAN, 'R6 categoría del curso: media ponderada');
$cats = [];
foreach (grade_category::fetch_all(['courseid' => $courseid]) as $gc) {
    if ($gc->is_course_category()) continue;
    $item = $gc->load_grade_item();
    $cats[$gc->fullname] = round((float)$item->aggregationcoef, 4);
}
ksort($cats);
$wantCats = [];
foreach ($exp['categories'] as $c) $wantCats[$c['fullname']] = round((float)$c['weight'], 4);
ksort($wantCats);
$R['categories'] = $cats;
$ok($cats == $wantCats, 'R6 categorías y pesos = perfil (' . json_encode($cats, JSON_UNESCAPED_UNICODE) . ')');
foreach ($exp['assigns'] as $a) {
    $cm = $byidn[$a['idnumber']] ?? null;
    if (!$ok((bool)$cm, "R6 {$a['idnumber']} restaurada")) continue;
    $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'assign', 'iteminstance' => $cm->instance]);
    if ($a['graded']) {
        $cat = $gi ? grade_category::fetch(['id' => $gi->categoryid]) : null;
        $ok($gi && $cat && $cat->fullname === $a['categoryName'] && abs((float)$gi->grademax - (float)$a['maxGrade']) < 1e-6,
            "R6 {$a['idnumber']}: Tarea calificada en «{$a['categoryName']}» (" . ($cat ? $cat->fullname : 'sin ítem') . ')');
    } else {
        $ok(!$gi, "R6 {$a['idnumber']}: Tarea formativa sin ítem de nota");
    }
}

// ── R7 / R8 (estudiante ficticio) ──
$stamp = substr(sha1(uniqid('', true)), 0, 8);
$uname = "cursia_t7_est_{$courseid}_{$stamp}";
$sid = user_create_user(['username' => $uname, 'password' => 'Cursia-T7-' . random_string(12) . '!1', 'firstname' => 'Estudiante', 'lastname' => 'Ficticio',
    'email' => "$uname@example.invalid", 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id], false, false);
$manual = enrol_get_plugin('manual');
$inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
if (!$inst) { $manual->add_instance($course); $inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual'], '*', MUST_EXIST); }
$studentrole = (int)$DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
$manual->enrol_user($inst, $sid, $studentrole);
try {
    get_fast_modinfo($courseid, 0, true);
    $smi = get_fast_modinfo($courseid, $sid);
    $fs = get_file_storage();
    foreach ($exp['practiceFiles'] as $p) {
        $cm = $byidn[$p['idnumber']] ?? null;
        if (!$ok((bool)$cm, "R7 {$p['idnumber']} restaurado")) continue;
        $ctx = context_module::instance($cm->id);
        $files = array_values(array_filter($fs->get_area_files($ctx->id, 'mod_resource', 'content', 0, 'id', false), fn($f) => !$f->is_directory()));
        $f = $files[0] ?? null;
        $content = $f ? $f->get_content() : null;
        $ok(count($files) === 1 && $f->get_filename() === $p['filename'] && $f->get_mimetype() === $p['mimetype'] && hash('sha256', $content) === $p['sha256'],
            "R7 {$p['filename']}: un archivo con nombre, mimetype y sha256 esperados");
        $scm = $smi->get_cm($cm->id);
        $ok((int)$cm->visible === 1 && $scm->uservisible && has_capability('mod/resource:view', $ctx, $sid), "R7 {$p['filename']}: visible y descargable para el estudiante");
    }
    foreach ($exp['hidden'] as $idn) {
        $cm = $byidn[$idn] ?? null;
        if (!$ok((bool)$cm, "R8 $idn restaurado")) continue;
        $ctx = context_module::instance($cm->id);
        $scm = $smi->get_cm($cm->id);
        $ok((int)$cm->visible === 0 && !$scm->uservisible, "R8 $idn: oculto, el estudiante no lo ve");
        if ($idn === 'cv3:shell:teacher_guide') {
            $ov = $DB->get_field('role_capabilities', 'permission', ['contextid' => $ctx->id, 'roleid' => $studentrole, 'capability' => 'mod/page:view']);
            $ok((int)$ov === CAP_PROHIBIT && !has_capability('mod/page:view', $ctx, $sid), 'R8 guía del docente: mod/page:view PROHIBIDO al estudiante');
        }
    }
} finally {
    $u = $DB->get_record('user', ['id' => $sid]);
    if ($u) delete_user($u);
    $R['studentDeleted'] = !$DB->record_exists('user', ['username' => $uname, 'deleted' => 0]);
}
$R['ok'] = !array_filter($R['asserts'], fn($a) => !$a['ok']);
$json = json_encode($R, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if (!empty($opts['out'])) file_put_contents($opts['out'], $json);
echo $json, "\n";
exit($R['ok'] ? 0 : 1);

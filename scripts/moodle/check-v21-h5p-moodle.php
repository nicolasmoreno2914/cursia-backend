<?php
// Cursia V2.1 / R7-core — verificación en un Moodle LOCAL desechable (sin red,
// sin gasto). Mismo estilo que los scripts de R0 (scratchpad/v21audit/r0/s2_*.php).
//
// Qué hace (no borra nada; deja el curso y usuarios creados):
//  1. crea un curso de prueba nuevo y usuarios v21r7teacher / v21r7student / v21r7student2;
//  2. agrega actividades h5pactivity desde paquetes SOLO CONTENIDO construidos por
//     los builders de Cursia (autor = docente, como tras un restore de docente);
//  3. los despliega con la API H5P de Moodle y filtra sus parámetros contra
//     semantics (lo mismo que ocurre en la primera vista);
//  4. publica xAPI como lo haría el reproductor (sentencia padre "completed" +
//     sentencias hijas con `?subContentId=<uuid>`) y comprueba: 1 intento, nota
//     0–100 correcta (3/4 → 75, 2/4 → 50) y COMPLETE_PASS / COMPLETE_FAIL con gradepass 70;
//  5. valida los paquetes del Cursia H5P Library Pack con el validador H5P de
//     Moodle (sin guardarlos) e imprime las librerías instaladas para el preflight.
//
// Uso:
//   php -c <php.ini> scripts/moodle/check-v21-h5p-moodle.php <moodleDir> <plan.json>
// El plan lo escribe scripts/check-v21-h5p-moodle.js.
// Salida: líneas "✅ …" / "❌ …" y al final una línea "RESULT_JSON {…}". Exit 1 si algo falla.
define('CLI_SCRIPT', 1);
if (empty($argv[1]) || empty($argv[2]) || !is_file(rtrim($argv[1], '/') . '/config.php') || !is_file($argv[2])) {
    fwrite(STDERR, "usage: php check-v21-h5p-moodle.php <moodleDirWithConfigPhp> <plan.json>\n");
    exit(2);
}
require(rtrim($argv[1], '/') . '/config.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');

$plan = json_decode(file_get_contents($argv[2]), true);
if (!$plan || empty($plan['packages'])) {
    fwrite(STDERR, "plan.json inválido\n");
    exit(2);
}
$GRADEPASS = (int)($plan['gradepass'] ?? 70);
$failures = 0;
$result = ['packages' => []];

function v21_check(string $name, bool $ok, $detail = null): void {
    global $failures;
    if ($ok) {
        echo "✅ $name\n";
    } else {
        $failures++;
        echo "❌ $name\n";
        if ($detail !== null) {
            echo '   ' . (is_string($detail) ? $detail : json_encode($detail, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)) . "\n";
        }
    }
}

function v21_user(string $u): stdClass {
    global $DB, $CFG;
    if ($x = $DB->get_record('user', ['username' => $u])) {
        return $x;
    }
    $id = user_create_user(['username' => $u, 'firstname' => $u, 'lastname' => 'V21R7', 'email' => "$u@example.invalid",
        'auth' => 'nologin', 'confirmed' => 1, 'mnethostid' => (int)($CFG->mnet_localhost_id ?? 1)], false, false);
    return $DB->get_record('user', ['id' => $id]);
}

function v21_add_h5p(stdClass $course, string $path, string $name, int $gradepass, stdClass $author): stdClass {
    global $DB;
    v21_fresh_page();
    \core\session\manager::set_user($author);
    $uctx = context_user::instance($author->id);
    $draft = file_get_unused_draft_itemid();
    get_file_storage()->create_file_from_pathname(['contextid' => $uctx->id, 'component' => 'user', 'filearea' => 'draft',
        'itemid' => $draft, 'filepath' => '/', 'filename' => basename($path)], $path);
    $m = (object)['module' => $DB->get_field('modules', 'id', ['name' => 'h5pactivity']), 'modulename' => 'h5pactivity',
        'course' => $course->id, 'section' => 1, 'visible' => 1, 'name' => $name, 'intro' => '', 'introformat' => FORMAT_HTML,
        'showdescription' => 0, 'packagefile' => $draft, 'grade' => 100, 'grademethod' => 1, 'enabletracking' => 1,
        'reviewmode' => 1, 'displayopt' => [], 'completion' => COMPLETION_TRACKING_AUTOMATIC, 'completionusegrade' => 1,
        'completionpassgrade' => 1, 'gradepass' => $gradepass, 'cmidnumber' => ''];
    $m = add_moduleinfo($m, $course);
    \core\session\manager::set_user(get_admin());
    return $m;
}

// Cada operación que en la web sería una petición distinta usa un $PAGE nuevo
// (si no, Moodle lanza "The theme has already been set up for this page").
function v21_fresh_page(): void {
    global $PAGE;
    $PAGE = new moodle_page();
    $PAGE->set_context(context_system::instance());
}

function v21_deploy(int $cmid, stdClass $viewer): array {
    v21_fresh_page();
    \core\session\manager::set_user($viewer);
    $ctx = context_module::instance($cmid);
    $files = get_file_storage()->get_area_files($ctx->id, 'mod_h5pactivity', 'package', 0, 'id', false);
    $file = reset($files);
    $url = moodle_url::make_pluginfile_url($file->get_contextid(), $file->get_component(), $file->get_filearea(),
        $file->get_itemid(), $file->get_filepath(), $file->get_filename());
    $messages = new stdClass();
    $h5pid = false;
    $err = null;
    $factory = new \core_h5p\factory();
    try {
        [$f, $h5pid] = \core_h5p\api::create_content_from_pluginfile_url($url->out(false), new stdClass(), $factory, $messages);
    } catch (Throwable $e) {
        $err = get_class($e) . ': ' . $e->getMessage();
    }
    $msgs = [];
    foreach (['error', 'info'] as $k) {
        if (!empty($messages->$k)) {
            foreach ($messages->$k as $m) {
                $msgs[] = $k . ':' . ($m->code ?? '') . ':' . ($m->message ?? '');
            }
        }
    }
    \core\session\manager::set_user(get_admin());
    return ['h5pid' => $h5pid, 'exception' => $err, 'messages' => $msgs];
}

// Recorre el contenido original y reporta rutas eliminadas o modificadas por el filtro H5P.
function v21_diff($orig, $filtered, string $path, array &$removed, array &$changed): void {
    if (is_array($orig) || is_object($orig)) {
        $orig = (array)$orig;
        $filtered = is_object($filtered) ? (array)$filtered : $filtered;
        foreach ($orig as $k => $v) {
            $p = $path === '' ? (string)$k : "$path.$k";
            if (!is_array($filtered) || !array_key_exists($k, $filtered)) {
                $removed[] = $p;
                continue;
            }
            v21_diff($v, $filtered[$k], $p, $removed, $changed);
        }
        return;
    }
    if ($orig !== $filtered) {
        $changed[] = $path . ' : ' . json_encode($orig, JSON_UNESCAPED_UNICODE) . ' → ' . json_encode($filtered, JSON_UNESCAPED_UNICODE);
    }
}

function v21_filter(int $h5pid): array {
    v21_fresh_page();
    $factory = new \core_h5p\factory();
    $core = $factory->get_core();
    $content = $core->loadContent($h5pid);
    $filtered = $core->filterParameters($content);
    $errors = $factory->get_framework()->getMessages('error');
    $errs = [];
    foreach ((array)$errors as $e) {
        $errs[] = is_object($e) ? (($e->code ?? '') . ':' . ($e->message ?? '')) : (string)$e;
    }
    return ['params' => $content['params'], 'filtered' => $filtered, 'errors' => $errs,
        'library' => $content['library']['name'] . ' ' . $content['library']['majorVersion'] . '.' . $content['library']['minorVersion']];
}

function v21_xapi(int $cmid, stdClass $student, int $raw, int $max, array $children): array {
    global $CFG;
    v21_fresh_page();
    \core\session\manager::set_user($student);
    $ctx = context_module::instance($cmid);
    $actor = ['objectType' => 'Agent', 'account' => ['homePage' => $CFG->wwwroot, 'name' => (string)$student->id]];
    $objectid = \core_xapi\iri::generate($ctx->id, 'activity');
    // Sentencia padre (sin subContentId): H5P la emite al terminar; abre el intento.
    $statements = [[
        'actor' => $actor,
        'verb' => ['id' => 'http://adlnet.gov/expapi/verbs/completed'],
        'object' => ['objectType' => 'Activity', 'id' => $objectid,
            'definition' => ['interactionType' => 'compound', 'name' => ['es' => 'Cursia V2.1 R7']]],
        'result' => ['completion' => true, 'success' => ($raw / $max) >= 0.7, 'duration' => 'PT45S',
            'score' => ['min' => 0, 'max' => $max, 'raw' => $raw, 'scaled' => $raw / $max]],
    ]];
    // Sentencias hijas: una por sub-contenido, con ?subContentId=<uuid> (como el reproductor real).
    foreach ($children as $c) {
        $statements[] = [
            'actor' => $actor,
            'verb' => ['id' => 'http://adlnet.gov/expapi/verbs/answered'],
            'object' => ['objectType' => 'Activity', 'id' => $objectid . '?subContentId=' . $c['subContentId'],
                'definition' => ['interactionType' => $c['interactionType'], 'name' => ['es' => $c['title']],
                    'description' => ['es' => $c['title']]]],
            'context' => ['contextActivities' => ['parent' => [['id' => $objectid, 'objectType' => 'Activity']]]],
            'result' => ['completion' => true, 'success' => $c['correct'], 'duration' => 'PT10S', 'response' => $c['correct'] ? 'true' : 'false',
                'score' => ['min' => 0, 'max' => 1, 'raw' => $c['correct'] ? 1 : 0, 'scaled' => $c['correct'] ? 1 : 0]],
        ];
    }
    $err = null;
    $res = null;
    try {
        $res = \core_xapi\external\post_statement::execute('mod_h5pactivity', json_encode($statements));
    } catch (Throwable $e) {
        $err = get_class($e) . ': ' . $e->getMessage();
    }
    \core\session\manager::set_user(get_admin());
    return ['posted' => $res, 'exception' => $err, 'statements' => count($statements)];
}

function v21_state(stdClass $course, int $cmid, int $instance, stdClass $student): array {
    global $DB;
    $g = grade_get_grades($course->id, 'mod', 'h5pactivity', $instance, $student->id);
    $item = $g->items[0] ?? null;
    $grade = $item ? ($item->grades[$student->id]->grade ?? null) : null;
    $cinfo = new completion_info($course);
    $cm = get_fast_modinfo($course, $student->id)->get_cm($cmid);
    $state = $cinfo->get_data($cm, false, $student->id)->completionstate;
    $names = [COMPLETION_INCOMPLETE => 'INCOMPLETE', COMPLETION_COMPLETE => 'COMPLETE',
        COMPLETION_COMPLETE_PASS => 'COMPLETE_PASS', COMPLETION_COMPLETE_FAIL => 'COMPLETE_FAIL'];
    $atts = $DB->get_records('h5pactivity_attempts', ['h5pactivityid' => $instance, 'userid' => $student->id], 'attempt',
        'id,attempt,rawscore,maxscore,scaled,completion,success');
    $results = [];
    foreach ($atts as $a) {
        $results[$a->attempt] = array_values(array_map(fn($r) => (array)$r,
            $DB->get_records('h5pactivity_attempts_results', ['attemptid' => $a->id], 'id', 'id,subcontent,rawscore,maxscore,success')));
    }
    return ['grade' => $grade === null ? null : (float)$grade, 'grademax' => $item ? (float)$item->grademax : null,
        'gradepass' => $item ? (float)$item->gradepass : null, 'completion' => $names[$state] ?? $state,
        'attempts' => array_values(array_map(fn($a) => (array)$a, $atts)), 'results' => $results];
}

// ── 0. Entorno ────────────────────────────────────────────────────────────────
\core\session\manager::set_user(get_admin());
$result['moodleRelease'] = $CFG->release;
$result['librariesAtStart'] = $DB->count_records('h5p_libraries');

// ── 1. Curso y usuarios ──────────────────────────────────────────────────────
$teacher = v21_user('v21r7teacher');
$student = v21_user('v21r7student');
$student2 = v21_user('v21r7student2');
$course = create_course((object)['fullname' => 'Cursia V2.1 R7 H5P check ' . date('Y-m-d H:i:s'),
    'shortname' => 'v21r7-' . time() . '-' . random_int(100, 999), 'category' => 1, 'enablecompletion' => 1,
    'numsections' => 1, 'format' => 'topics']);
$roles = $DB->get_records_menu('role', null, '', 'shortname,id');
enrol_try_internal_enrol($course->id, $teacher->id, $roles['editingteacher']);
enrol_try_internal_enrol($course->id, $student->id, $roles['student']);
enrol_try_internal_enrol($course->id, $student2->id, $roles['student']);
$result['courseid'] = (int)$course->id;
v21_check("curso de prueba creado (id {$course->id})", $course->id > 0);

// ── 2–4. Actividades desde paquetes solo contenido ───────────────────────────
foreach ($plan['packages'] as $pkg) {
    $key = $pkg['key'];
    $r = ['key' => $key, 'mainLibrary' => $pkg['mainLibrary']];
    $mod = v21_add_h5p($course, $pkg['file'], $pkg['name'], $GRADEPASS, $teacher);
    $r['cmid'] = (int)$mod->coursemodule;
    $dep = v21_deploy($mod->coursemodule, $student);
    $r['deploy'] = $dep;
    v21_check("$key: paquete solo contenido (autor docente) despliega", !empty($dep['h5pid']) && $dep['exception'] === null && !array_filter($dep['messages'], fn($m) => str_starts_with($m, 'error')), $dep);
    if (empty($dep['h5pid'])) {
        $result['packages'][] = $r;
        continue;
    }
    $h5p = $DB->get_record('h5p', ['id' => $dep['h5pid']]);
    $mainlib = $DB->get_record('h5p_libraries', ['id' => $h5p->mainlibraryid]);
    $libstr = "{$mainlib->machinename} {$mainlib->majorversion}.{$mainlib->minorversion}";
    v21_check("$key: librería principal = {$pkg['mainLibraryString']}", $libstr === $pkg['mainLibraryString'], $libstr);

    $flt = v21_filter((int)$dep['h5pid']);
    $removed = [];
    $changed = [];
    // Moodle agrega `title` y `metadata` (de h5p.json) a la raíz de jsoncontent al guardar; no son del content.json.
    $stored = json_decode($flt['params']);
    unset($stored->title, $stored->metadata);
    v21_diff($stored, json_decode((string)$flt['filtered']), '', $removed, $changed);
    $r['filter'] = ['errors' => $flt['errors'], 'removed' => $removed, 'changed' => $changed];
    v21_check("$key: el validador de contenido H5P acepta los parámetros (sin errores ni campos eliminados)",
        $flt['filtered'] !== null && !$flt['errors'] && !$removed, ['errors' => $flt['errors'], 'removed' => $removed]);
    $filteredStr = (string)$flt['filtered'];
    $missingIds = array_values(array_filter($pkg['subContentIds'], fn($id) => !str_contains($filteredStr, $id)));
    v21_check("$key: los " . count($pkg['subContentIds']) . " subContentId UUID sobreviven al filtro", !$missingIds, $missingIds);
    $english = array_values(array_filter(['Submit Answers', 'Untitled', 'Check', 'Show solution', 'Retry'], fn($w) => str_contains($filteredStr, '"' . $w . '"') || str_contains($filteredStr, $w . ' ')));
    v21_check("$key: sin textos de interfaz en inglés tras el filtro", !$english, $english);

    // xAPI: student 3/max·¾ → 75 (PASS); student2 2/4 → 50 (FAIL).
    foreach ([[$student, $pkg['passScenario']], [$student2, $pkg['failScenario']]] as [$u, $sc]) {
        $children = [];
        foreach ($pkg['subContentIds'] as $i => $id) {
            $children[] = ['subContentId' => $id, 'interactionType' => $pkg['interactionTypes'][$i],
                'title' => 'Pregunta ' . ($i + 1), 'correct' => (bool)$sc['childCorrect'][$i]];
        }
        $post = v21_xapi($mod->coursemodule, $u, $sc['raw'], $pkg['maxScore'], $children);
        $st = v21_state($course, $mod->coursemodule, $mod->instance, $u);
        $r['xapi'][$u->username] = ['post' => $post, 'state' => $st];
        $tag = "$key/{$u->username} {$sc['raw']}/{$pkg['maxScore']}";
        v21_check("$tag: xAPI aceptado ({$post['statements']} sentencias)", $post['exception'] === null && is_array($post['posted']) && !in_array(false, $post['posted'], true), $post);
        v21_check("$tag: exactamente 1 intento", count($st['attempts']) === 1, $st['attempts']);
        $att = $st['attempts'][0] ?? null;
        $res = $att ? ($st['results'][$att['attempt']] ?? []) : [];
        $subs = array_values(array_filter(array_map(fn($x) => $x['subcontent'], $res)));
        sort($subs);
        $exp = $pkg['subContentIds'];
        sort($exp);
        v21_check("$tag: resultados = 1 padre + " . count($exp) . " hijos con subcontent = UUID del paquete",
            count($res) === 1 + count($exp) && $subs === $exp, ['results' => $res]);
        v21_check("$tag: nota {$sc['expectedGrade']} / 100 en el libro de calificaciones",
            $st['grade'] !== null && abs($st['grade'] - $sc['expectedGrade']) < 0.001 && $st['grademax'] == 100.0 && $st['gradepass'] == (float)$GRADEPASS,
            ['grade' => $st['grade'], 'grademax' => $st['grademax'], 'gradepass' => $st['gradepass']]);
        v21_check("$tag: completion {$sc['expectedCompletion']}", $st['completion'] === $sc['expectedCompletion'], $st['completion']);
    }
    $result['packages'][] = $r;
}

// ── 5a. Library Pack: el validador H5P de Moodle acepta cada paquete (sin guardarlo) ──
if (!empty($plan['libraryPack'])) {
    $admin = get_admin();
    $uctx = context_user::instance($admin->id);
    foreach ($plan['libraryPack'] as $packfile) {
        $draft = file_get_unused_draft_itemid();
        $file = get_file_storage()->create_file_from_pathname(['contextid' => $uctx->id, 'component' => 'user',
            'filearea' => 'draft', 'itemid' => $draft, 'filepath' => '/', 'filename' => basename($packfile)], $packfile);
        $factory = new \core_h5p\factory();
        $ok = false;
        $err = null;
        try {
            $ok = \core_h5p\api::is_valid_package($file, false, false, $factory);
        } catch (Throwable $e) {
            $err = get_class($e) . ': ' . $e->getMessage();
        }
        $msgs = [];
        foreach ((array)$factory->get_framework()->getMessages('error') as $e) {
            $msgs[] = is_object($e) ? (($e->code ?? '') . ':' . ($e->message ?? '')) : (string)$e;
        }
        $result['libraryPack'][basename($packfile)] = ['valid' => $ok, 'exception' => $err, 'errors' => $msgs];
        v21_check('library pack: ' . basename($packfile) . ' es un paquete H5P válido para Moodle', $ok && $err === null, ['exception' => $err, 'errors' => $msgs]);
    }
}

// ── 5b. Librerías instaladas (el driver Node aplica el preflight del perfil) ──
$libs = [];
foreach ($DB->get_records('h5p_libraries', null, 'machinename, majorversion, minorversion, patchversion') as $l) {
    $libs[] = ['machineName' => $l->machinename, 'majorVersion' => (int)$l->majorversion,
        'minorVersion' => (int)$l->minorversion, 'patchVersion' => (int)$l->patchversion];
}
$result['installedLibraries'] = $libs;
$result['librariesAtEnd'] = count($libs);
v21_check('no se instalaron ni borraron librerías durante la prueba (paquetes solo contenido)', $result['librariesAtStart'] === count($libs),
    [$result['librariesAtStart'], count($libs)]);
$result['failures'] = $failures;
echo 'RESULT_JSON ' . json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
exit($failures > 0 ? 1 : 0);

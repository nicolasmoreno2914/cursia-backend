<?php
// T4/T5 (r57) — en un curso Cursia YA restaurado en un Moodle LOCAL desechable (4.1–4.5), verifica con usuarios ficticios:
//   - cada Actividad de Aplicación entregada como Tarea (mod_assign): nota máxima / formativa, completionsubmit, fecha
//     límite relativa al inicio del curso, tipos de entrega + límites + formatos, comentarios de retroalimentación, ítem de
//     nota en su categoría (calificada) o ninguno (formativa), rúbrica activa y usable (gradingform_rubric);
//   - un ESTUDIANTE envía (texto en línea + archivo): entrega «enviada» y la actividad queda completada (completion submit);
//   - un DOCENTE califica con la rúbrica (niveles elegidos) + comentario: nota = puntos / máximo × nota máxima en el libro;
//   - nota final del curso = media ponderada de las categorías con la Tarea calificada en la suya (peso del perfil);
//   - solucionario docente oculto y prohibido al estudiante (también si un docente lo muestra por error);
//   - archivos de trabajo: mod_resource visible para el estudiante, UN archivo con nombre/mimetype/sha256 esperados y la
//     Tarea (o la página) enlaza su recurso (/mod/resource/view.php?id=…).
// No cambia la configuración del sitio. Con --cleanup borra el curso y los usuarios que creó (y --teacherid).
//
// Uso: php -c php.ini check-application-deliverables.php --moodle=<raíz> --courseid=<id> --expect=<json> --out=<json>
//      [--cleanup] [--teacherid=<id del docente creado al restaurar>]
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'courseid:', 'expect:', 'out:', 'cleanup', 'teacherid:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/mod/assign/locallib.php');
require_once($CFG->dirroot . '/grade/grading/lib.php');
require_once($CFG->dirroot . '/grade/lib.php');
global $DB, $CFG, $USER;

$exp = json_decode(file_get_contents($opts['expect']), true);
$courseid = (int)$opts['courseid'];
$out = ['moodle' => $CFG->release, 'courseid' => $courseid, 'asserts' => [], 'assigns' => [], 'resources' => [], 'grades' => []];
$ok = function ($cond, $msg) use (&$out) { $out['asserts'][] = ['ok' => (bool)$cond, 'msg' => $msg]; return (bool)$cond; };
$admin = get_admin();
\core\session\manager::set_user($admin);
$course = get_course($courseid);
$fs = get_file_storage();
$cmByIdn = [];
foreach (get_fast_modinfo($course)->get_cms() as $cm) if ((string)$cm->idnumber !== '') $cmByIdn[(string)$cm->idnumber] = $cm;

// Usuarios ficticios (en ESTE curso).
$stamp = substr(sha1(uniqid('', true) . random_string(6)), 0, 8);
$mk = function ($prefix, $first) use ($stamp, $CFG) {
    $u = strtolower("cursia_t4_{$prefix}_{$stamp}");
    return user_create_user(['username' => $u, 'password' => 'Cursia-T4-' . random_string(12) . '!1', 'firstname' => $first, 'lastname' => 'Ficticio',
        'email' => "$u@example.invalid", 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id], false, false);
};
$manual = enrol_get_plugin('manual');
$inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
if (!$inst) { $manual->add_instance($course); $inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual'], '*', MUST_EXIST); }
$sid = $mk('est', 'Estudiante');
$tid = $mk('doc', 'Docente');
$manual->enrol_user($inst, $sid, $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST));
$manual->enrol_user($inst, $tid, $DB->get_field('role', 'id', ['shortname' => 'editingteacher'], MUST_EXIST));
$student = $DB->get_record('user', ['id' => $sid], '*', MUST_EXIST);
$teacher = $DB->get_record('user', ['id' => $tid], '*', MUST_EXIST);

try {
    // ── Tareas ──
    $gradedAssignGrades = [];
    foreach ($exp['assigns'] as $e) {
        $idn = $e['idnumber'];
        $cm = $cmByIdn[$idn] ?? null;
        if (!$ok($cm && $cm->modname === 'assign', "$idn: es una Tarea (mod_assign)")) continue;
        $ctx = context_module::instance($cm->id);
        $a = $DB->get_record('assign', ['id' => $cm->instance], '*', MUST_EXIST);
        $row = ['idnumber' => $idn, 'cmid' => (int)$cm->id];
        $ok((int)$a->grade === ($e['graded'] ? (int)$e['maxGrade'] : 0), "$idn: grade {$a->grade}");
        $ok((int)$a->completionsubmit === 1 && (int)$cm->completion === 2, "$idn: completion al enviar ({$cm->completion}/{$a->completionsubmit})");
        $ok((int)$a->alwaysshowdescription === 1 && (int)$a->teamsubmission === 0 && (int)$a->submissiondrafts === 0, "$idn: descripción siempre visible, entrega individual sin borrador");
        $dueRel = (int)$a->duedate === 0 ? null : (int)round(((int)$a->duedate - (int)$course->startdate) / 86400);
        $ok($dueRel === $e['dueOffsetDays'], "$idn: fecha límite = inicio + " . json_encode($e['dueOffsetDays']) . " días (es " . json_encode($dueRel) . ")");
        $cfg = [];
        foreach ($DB->get_records('assign_plugin_config', ['assignment' => $a->id]) as $c) $cfg["{$c->subtype}/{$c->plugin}/{$c->name}"] = (string)$c->value;
        $want = [
            'assignsubmission/onlinetext/enabled' => $e['onlineText'] ? '1' : '0',
            'assignsubmission/file/enabled' => $e['file'] ? '1' : '0',
            'assignsubmission/file/maxfilesubmissions' => (string)$e['maxFiles'],
            'assignsubmission/file/maxsubmissionsizebytes' => (string)$e['maxBytes'],
            'assignsubmission/file/filetypeslist' => implode(',', $e['fileTypes']),
            'assignfeedback/comments/enabled' => '1',
        ];
        foreach ($want as $k => $v) $ok(($cfg[$k] ?? null) === $v, "$idn: $k = " . json_encode($cfg[$k] ?? null) . " (esperado $v)");
        $gi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'assign', 'iteminstance' => $a->id]);
        if ($e['graded']) {
            if ($ok((bool)$gi, "$idn: ítem de nota")) {
                $cat = grade_category::fetch(['id' => $gi->categoryid]);
                $ok((float)$gi->grademax == (float)$e['maxGrade'] && (float)$gi->gradepass == (float)$e['gradepass'], "$idn: grademax/gradepass {$gi->grademax}/{$gi->gradepass}");
                $ok($cat && $cat->fullname === $e['categoryName'], "$idn: categoría «" . ($cat ? $cat->fullname : '?') . "» (esperada «{$e['categoryName']}»)");
            }
        } else {
            $ok(!$gi, "$idn: formativa sin ítem de nota");
        }
        $gm = get_grading_manager($ctx, 'mod_assign', 'submissions');
        $method = $gm->get_active_method();
        if ($e['rubric']) {
            $ok($method === 'rubric', "$idn: método de calificación avanzada = rubric (es " . json_encode($method) . ")");
            $ctrl = $gm->get_controller('rubric');
            $ok($ctrl->is_form_available(), "$idn: rúbrica LISTA y usable");
            $def = $ctrl->get_definition();
            $ok(count($def->rubric_criteria) === (int)$e['rubricCriteria'], "$idn: " . count($def->rubric_criteria) . " criterios (esperados {$e['rubricCriteria']})");
            $row['rubric'] = array_values(array_map(function ($c) { return ['description' => $c['description'], 'scores' => array_values(array_map(function ($l) { return (float)$l['score']; }, $c['levels']))]; }, $def->rubric_criteria));
        } else {
            $ok($method === null || $method === '' || $method === 'simple' || !$gm->get_controller($method)->is_form_available(), "$idn: sin rúbrica (método " . json_encode($method) . ")");
        }
        $ok(strpos($a->intro, 'Cómo entregar') !== false, "$idn: la descripción explica cómo entregar");
        $pdfs = array_filter($fs->get_area_files($ctx->id, 'mod_assign', 'intro', 0, 'filename', false), function ($f) { return substr($f->get_filename(), -4) === '.pdf'; });
        $ok(count($pdfs) === 1, "$idn: PDF del estudiante en la descripción (" . count($pdfs) . ")");
        foreach ($e['linksResources'] ?? [] as $ridn) {
            $rcm = $cmByIdn[$ridn] ?? null;
            $ok($rcm && strpos($a->intro, "/mod/resource/view.php?id={$rcm->id}") !== false, "$idn: enlaza su archivo de trabajo $ridn");
        }

        // ── Estudiante: entrega (texto + archivo) ──
        \core\session\manager::set_user($student);
        $as = new assign($ctx, $cm, $course);
        $draft = file_get_unused_draft_itemid();
        $ucx = context_user::instance($student->id);
        $fs->create_file_from_string(['contextid' => $ucx->id, 'component' => 'user', 'filearea' => 'draft', 'itemid' => $draft, 'filepath' => '/', 'filename' => 'entrega.pdf'], "%PDF-1.4\n% entrega ficticia\n%%EOF\n");
        $data = new stdClass();
        if ($e['onlineText']) $data->onlinetext_editor = ['text' => '<p>Mi entrega de la actividad.</p>', 'format' => FORMAT_HTML, 'itemid' => file_get_unused_draft_itemid()];
        if ($e['file']) $data->files_filemanager = $draft;
        $notices = [];
        $saved = $as->save_submission($data, $notices);
        $ok($saved, "$idn: el estudiante envía su entrega " . json_encode($notices));
        $sub = $as->get_user_submission($student->id, false);
        $ok($sub && $sub->status === ASSIGN_SUBMISSION_STATUS_SUBMITTED, "$idn: entrega enviada (" . ($sub ? $sub->status : 'sin entrega') . ")");
        if ($e['file']) {
            $subfiles = $fs->get_area_files($ctx->id, 'assignsubmission_file', ASSIGNSUBMISSION_FILE_FILEAREA, $sub->id, 'id', false);
            $ok(count($subfiles) === 1, "$idn: archivo entregado (" . count($subfiles) . ")");
        }
        \core\session\manager::set_user($admin);
        $cinfo = new completion_info($course);
        $cmi = get_fast_modinfo($course, $student->id)->get_cm($cm->id);
        $cd = $cinfo->get_data($cmi, false, $student->id);
        $ok((int)$cd->completionstate === COMPLETION_COMPLETE, "$idn: completada al enviar (estado {$cd->completionstate})");

        // ── Docente: calificación con rúbrica + comentario de retroalimentación ──
        \core\session\manager::set_user($teacher);
        $at = new assign($ctx, $cm, $course);
        $gdata = (object)['attemptnumber' => -1, 'assignfeedbackcomments_editor' => ['text' => '<p>Buen trabajo; revisa el criterio 2.</p>', 'format' => FORMAT_HTML]];
        $expectGrade = null;
        if ($e['graded'] && $e['rubric']) {
            $def = get_grading_manager($ctx, 'mod_assign', 'submissions')->get_controller('rubric')->get_definition();
            $crit = [];
            $sum = 0; $max = 0; $i = 0;
            foreach ($def->rubric_criteria as $cid => $c) {
                $levels = array_values($c['levels']);
                usort($levels, function ($x, $y) { return $x['score'] <=> $y['score']; });
                $pick = $levels[min(count($levels) - 1, (int)($e['rubricPick'][$i] ?? (count($levels) - 1)))];
                $crit[$cid] = ['levelid' => $pick['id'], 'remark' => 'Observación del criterio ' . ($i + 1)];
                $sum += $pick['score'];
                $max += $levels[count($levels) - 1]['score'];
                $i++;
            }
            $gdata->advancedgrading = ['criteria' => $crit];
            $expectGrade = $max > 0 ? round($sum / $max * (float)$e['maxGrade'], 5) : 0;
        } else if ($e['graded']) {
            $gdata->grade = (float)$e['directGrade'];
            $expectGrade = (float)$e['directGrade'];
        }
        $at->save_grade($student->id, $gdata);
        \core\session\manager::set_user($admin);
        $fb = $DB->get_records_sql('SELECT c.* FROM {assignfeedback_comments} c JOIN {assign_grades} g ON g.id = c.grade WHERE c.assignment = ? AND g.userid = ?', [$a->id, $student->id]);
        $ok(count($fb) === 1, "$idn: comentario de retroalimentación guardado");
        if ($e['graded']) {
            $gg = grade_get_grades($courseid, 'mod', 'assign', $a->id, $student->id);
            $got = isset($gg->items[0]->grades[$student->id]) ? (float)$gg->items[0]->grades[$student->id]->grade : null;
            $ok($got !== null && abs($got - $expectGrade) < 0.001, "$idn: nota en el libro $got (esperada $expectGrade" . ($e['rubric'] ? ', de la rúbrica' : '') . ")");
            $row['grade'] = $got;
            $gradedAssignGrades[$idn] = $got;
        } else {
            $ag = $DB->get_record('assign_grades', ['assignment' => $a->id, 'userid' => $student->id]);
            $ok(!$ag || $ag->grade === null || (float)$ag->grade < 0, "$idn: formativa sin nota (" . json_encode($ag ? $ag->grade : null) . ")");
        }
        $out['assigns'][] = $row;
    }

    // ── Archivos de trabajo ──
    foreach ($exp['resources'] as $r) {
        $rcm = $cmByIdn[$r['idnumber']] ?? null;
        if (!$ok($rcm && $rcm->modname === 'resource', "{$r['idnumber']}: recurso (mod_resource)")) continue;
        $rctx = context_module::instance($rcm->id);
        $files = $fs->get_area_files($rctx->id, 'mod_resource', 'content', 0, 'sortorder DESC, id ASC', false);
        $ok(count($files) === 1, "{$r['idnumber']}: un archivo (" . count($files) . ")");
        $f = reset($files);
        if ($f) {
            $ok($f->get_filename() === $r['filename'] && $f->get_mimetype() === $r['mimetype'], "{$r['idnumber']}: {$f->get_filename()} {$f->get_mimetype()}");
            $ok(hash('sha256', $f->get_content()) === $r['sha256'] && (int)$f->get_filesize() === (int)$r['bytes'], "{$r['idnumber']}: contenido = sha256 registrado");
            $url = moodle_url::make_pluginfile_url($rctx->id, 'mod_resource', 'content', 0, $f->get_filepath(), $f->get_filename(), true)->out(false);
            $out['resources'][] = ['idnumber' => $r['idnumber'], 'url' => $url, 'sha256' => hash('sha256', $f->get_content())];
        }
        $scm = get_fast_modinfo($course, $student->id)->get_cm($rcm->id);
        $ok($scm->uservisible && has_capability('mod/resource:view', $rctx, $student), "{$r['idnumber']}: el estudiante lo ve y lo descarga");
        if (!empty($r['linkedFrom'])) {
            $t = $cmByIdn[$r['linkedFrom']] ?? null;
            $txt = '';
            if ($t && $t->modname === 'assign') $txt = $DB->get_field('assign', 'intro', ['id' => $t->instance]);
            if ($t && $t->modname === 'page') $txt = $DB->get_field('page', 'content', ['id' => $t->instance]);
            $ok($t && strpos($txt, "/mod/resource/view.php?id={$rcm->id}") !== false, "{$r['idnumber']}: enlazado desde {$r['linkedFrom']}");
        }
    }

    // ── Solucionarios ──
    $studentRole = $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
    foreach ($exp['solutions'] as $idn) {
        $cm = $cmByIdn[$idn] ?? null;
        if (!$ok($cm && $cm->modname === 'page', "$idn: solucionario (mod_page)")) continue;
        $ctx = context_module::instance($cm->id);
        $s = get_fast_modinfo($course, $student->id)->get_cm($cm->id);
        $t = get_fast_modinfo($course, $teacher->id)->get_cm($cm->id);
        $ok((int)$cm->visible === 0 && !$s->uservisible && $t->uservisible, "$idn: oculto al estudiante, visible al docente");
        set_coursemodule_visible($cm->id, 1);
        $s2 = get_fast_modinfo($course, $student->id)->get_cm($cm->id);
        $ok(!($s2->uservisible && has_capability('mod/page:view', $ctx, $student)), "$idn: mostrado por error, el estudiante sigue sin poder abrirlo");
        set_coursemodule_visible($cm->id, 0);
    }

    // ── Nota final del curso: media ponderada con la Tarea calificada en su categoría ──
    if (!empty($exp['finalExamIdnumber']) && isset($cmByIdn[$exp['finalExamIdnumber']])) {
        $q = $cmByIdn[$exp['finalExamIdnumber']];
        $qi = grade_item::fetch(['courseid' => $courseid, 'itemtype' => 'mod', 'itemmodule' => 'quiz', 'iteminstance' => $q->instance]);
        $ok($qi && $qi->update_final_grade($student->id, (float)$exp['finalExamGrade'], 'cursia-t4-test'), 'nota ficticia del examen final');
    }
    grade_regrade_final_grades($courseid);
    $ci = grade_item::fetch_course_item($courseid);
    $cg = grade_grade::fetch(['itemid' => $ci->id, 'userid' => $student->id]);
    $total = $cg ? (float)$cg->finalgrade : null;
    // Esperado (independiente de la agregación de Moodle): Σ peso × media de la categoría (ítems vacíos = 0, aggregateonlygraded 0).
    $expected = 0.0; $wsum = 0.0; $detail = [];
    foreach ($exp['weights'] as $catname => $w) {
        $cat = grade_category::fetch(['courseid' => $courseid, 'fullname' => $catname]);
        if (!$ok((bool)$cat, "categoría «{$catname}» en el libro de calificaciones")) continue;
        $citem = $cat->load_grade_item();
        $ok(abs((float)$citem->aggregationcoef - (float)$w) < 0.001, "peso de «{$catname}» {$citem->aggregationcoef} (esperado $w)");
        $items = grade_item::fetch_all(['courseid' => $courseid, 'categoryid' => $cat->id, 'itemtype' => 'mod']) ?: [];
        $vals = [];
        foreach ($items as $it) {
            $g = grade_grade::fetch(['itemid' => $it->id, 'userid' => $student->id]);
            $vals[] = ($g && $g->finalgrade !== null) ? ((float)$g->finalgrade - (float)$it->grademin) / ((float)$it->grademax - (float)$it->grademin) * 100 : 0.0;
        }
        $mean = count($vals) ? array_sum($vals) / count($vals) : 0.0;
        $detail[$catname] = ['weight' => $w, 'items' => count($vals), 'mean' => round($mean, 4)];
        $expected += $w * $mean;
        $wsum += $w;
    }
    $expected = $wsum > 0 ? $expected / $wsum : 0;
    $out['grades'] = ['courseTotal' => $total, 'expected' => round($expected, 4), 'categories' => $detail, 'assigns' => $gradedAssignGrades];
    $ok($total !== null && abs($total - $expected) < 0.01, "nota final del curso $total = Σ peso × categoría (" . round($expected, 4) . ')');
    if (!empty($exp['expectAssignContributes'])) {
        $ok(($detail[$exp['assignCategoryName']]['mean'] ?? 0) > 0, 'la Tarea calificada suma en su categoría (y en la nota final)');
    }
} catch (Throwable $e) {
    $out['asserts'][] = ['ok' => false, 'msg' => 'excepción: ' . get_class($e) . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine()];
}

// ── Limpieza ──
\core\session\manager::set_user($admin);
if (isset($opts['cleanup'])) {
    delete_course($courseid, false);
    foreach (array_filter([$sid, $tid, isset($opts['teacherid']) ? (int)$opts['teacherid'] : 0]) as $uid) {
        $u = $DB->get_record('user', ['id' => $uid]);
        if ($u) delete_user($u);
    }
    $out['cleanup'] = ['course_deleted' => !$DB->record_exists('course', ['id' => $courseid]), 'users_deleted' => !$DB->record_exists_select('user', 'id IN (?, ?) AND deleted = 0', [$sid, $tid])];
}
$out['ok'] = count(array_filter($out['asserts'], function ($x) { return !$x['ok']; })) === 0;
file_put_contents($opts['out'], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
exit($out['ok'] ? 0 : 1);

<?php
// r107 B4 — inspección de un curso YA restaurado (restore-and-inspect.sh) a partir de un .mbz parcheado por el motor de
// parches del Taller, en el Moodle 4.5 local desechable. Solo LEE: no borra nada ni cambia configuración del sitio.
//
// Uso: php -c php.ini r107-patch-inspect.php <input.json> <output.json>
//   input: { moodleRoot, courseid, mbz }
// Salida: advertencias del restore (log del controller, backup_logs, precheck del mismo .mbz) + contenido restaurado:
//   por actividad (nombre, idnumber, intro / contenido / capítulos / archivos) y por examen (sumgrades, grade, ranuras
//   con su pregunta — texto y opciones con fracción — o, si es aleatoria, la categoría y su banco).
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');

global $DB, $CFG;
$admin = get_admin();
\core\session\manager::set_user($admin);
$courseid = (int)$in['courseid'];
$course = get_course($courseid);
$out = ['courseid' => $courseid, 'fullname' => $course->fullname];

// ── 1. Advertencias del restore ──
$rc = $DB->get_record_sql("SELECT backupid, status FROM {backup_controllers}
    WHERE operation = 'restore' AND type = 'course' AND itemid = ? ORDER BY id ASC", [$courseid], IGNORE_MULTIPLE);
$out['restoreStatus'] = $rc ? (int)$rc->status : null;
$logfile = $rc ? make_backup_temp_directory('', false) . '/' . $rc->backupid . '.log' : null;
$out['restoreLogFound'] = $logfile && file_exists($logfile);
$out['restoreLogLines'] = $out['restoreLogFound'] ? array_values(array_filter(array_map('trim', file($logfile)), 'strlen')) : null;
$out['restoreDbLogWarnings'] = $rc ? array_values($DB->get_fieldset_select('backup_logs', 'message',
    'backupid = ? AND loglevel <= ?', [$rc->backupid, backup::LOG_WARNING])) : null;

$tmp = restore_controller::get_tempdir_name(SITEID, $admin->id);
$path = make_backup_temp_directory($tmp);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($in['mbz'], $path);
$prc = new restore_controller($tmp, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_EXISTING_ADDING);
$prc->execute_precheck(true);
$pre = $prc->get_precheck_results();
$prc->destroy();
fulldelete($path);
$out['precheck'] = ['warnings' => array_values($pre['warnings'] ?? []), 'errors' => array_values($pre['errors'] ?? [])];

// ── 2. Contenido restaurado ──
$fs = get_file_storage();
$modinfo = get_fast_modinfo($course);
$sections = [];
foreach ($modinfo->get_section_info_all() as $si) {
    $sec = ['section' => (int)$si->section, 'name' => (string)$si->name, 'summary' => (string)$si->summary, 'cms' => []];
    foreach ($modinfo->sections[$si->section] ?? [] as $cmid) {
        $cm = $modinfo->get_cm($cmid);
        $row = $DB->get_record('course_modules', ['id' => $cm->id]);
        $ctx = context_module::instance($cm->id);
        $inst = $DB->get_record($cm->modname, ['id' => $cm->instance]);
        $c = ['cmid' => (int)$cm->id, 'modname' => $cm->modname, 'name' => $cm->name, 'idnumber' => (string)$row->idnumber,
            'intro' => isset($inst->intro) ? (string)$inst->intro : null, 'files' => []];
        foreach ($fs->get_area_files($ctx->id, 'mod_' . $cm->modname, ['intro', 'content', 'package'], false, 'filearea, filename', false) as $f) {
            $c['files'][] = ['area' => $f->get_filearea(), 'name' => $f->get_filename(), 'hash' => $f->get_contenthash(), 'size' => (int)$f->get_filesize()];
        }
        if ($cm->modname === 'page') $c['content'] = (string)$inst->content;
        if ($cm->modname === 'book') {
            $c['chapters'] = array_values(array_map(fn($x) => ['title' => $x->title, 'content' => $x->content],
                $DB->get_records('book_chapters', ['bookid' => $cm->instance], 'pagenum')));
        }
        if ($cm->modname === 'quiz') {
            $c['sumgrades'] = (float)$inst->sumgrades;
            $c['grade'] = (float)$inst->grade;
            $slots = [];
            foreach ($DB->get_records('quiz_slots', ['quizid' => $cm->instance], 'slot') as $s) {
                $ref = $DB->get_record('question_references', ['itemid' => $s->id, 'component' => 'mod_quiz', 'questionarea' => 'slot', 'usingcontextid' => $ctx->id]);
                $slot = ['slot' => (int)$s->slot, 'page' => (int)$s->page, 'maxmark' => (float)$s->maxmark];
                if ($ref) {
                    $q = $DB->get_record_sql('SELECT q.* FROM {question_versions} qv JOIN {question} q ON q.id = qv.questionid
                        WHERE qv.questionbankentryid = ? ' . ($ref->version ? 'AND qv.version = ' . (int)$ref->version : '') . ' ORDER BY qv.version DESC',
                        [$ref->questionbankentryid], IGNORE_MULTIPLE);
                    $slot['kind'] = 'fixed';
                    $slot['question'] = $q ? ['qtype' => $q->qtype, 'text' => $q->questiontext,
                        'answers' => array_values(array_map(fn($a) => ['text' => $a->answer, 'fraction' => (float)$a->fraction],
                            $DB->get_records('question_answers', ['question' => $q->id], 'id')))] : null;
                } else {
                    $set = $DB->get_record('question_set_references', ['itemid' => $s->id, 'component' => 'mod_quiz', 'questionarea' => 'slot', 'usingcontextid' => $ctx->id]);
                    $slot['kind'] = $set ? 'random' : 'none';
                    if ($set) {
                        $fc = json_decode($set->filtercondition, true);
                        $catid = $fc['filter']['category']['values'][0] ?? ($fc['questioncategoryid'] ?? null);
                        $slot['categoryid'] = $catid ? (int)$catid : null;
                        $slot['bank'] = $catid ? array_values(array_map(fn($x) => $x->questiontext, $DB->get_records_sql(
                            'SELECT q.id, q.questiontext FROM {question_bank_entries} e JOIN {question_versions} qv ON qv.questionbankentryid = e.id
                             JOIN {question} q ON q.id = qv.questionid WHERE e.questioncategoryid = ? ORDER BY q.id', [$catid]))) : [];
                    }
                }
                $slots[] = $slot;
            }
            $c['slots'] = $slots;
        }
        $sec['cms'][] = $c;
    }
    $sections[] = $sec;
}
$out['sections'] = $sections;
file_put_contents($argv[2], json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));

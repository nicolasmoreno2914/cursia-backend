<?php
// Cursia V2.1 — R12: inspección de un curso YA restaurado (restore-and-inspect.sh)
// a partir de un .mbz v3, en el Moodle 4.5 local desechable. Solo LEE (y, para
// probar que cada H5P despliega, crea la entrada h5p del contenido: es lo mismo
// que hace Moodle la primera vez que alguien lo abre). No borra nada ni cambia
// configuración del sitio.
//
// Uso: php -c php.ini v21-packaging-v3-inspect.php <input.json> <output.json>
//   input: { moodleRoot, courseid, mbz }
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');

global $DB, $CFG, $PAGE;
$admin = get_admin();
\core\session\manager::set_user($admin);
$courseid = (int)$in['courseid'];
$course = get_course($courseid);
$out = ['courseid' => $courseid, 'enablecompletion' => (int)$course->enablecompletion];

// ── 1. Warnings del restore (log del controller + backup_logs) ──
$rc = $DB->get_record_sql("SELECT backupid, status FROM {backup_controllers}
    WHERE operation = 'restore' AND type = 'course' AND itemid = ? ORDER BY id ASC", [$courseid], IGNORE_MULTIPLE); // el primero = el restore real (los prechecks de inspección vienen después)
$out['restoreStatus'] = $rc ? (int)$rc->status : null;
$logfile = $rc ? make_backup_temp_directory('', false) . '/' . $rc->backupid . '.log' : null;
$out['restoreLogFound'] = $logfile && file_exists($logfile);
$out['restoreLogLines'] = $out['restoreLogFound'] ? array_values(array_filter(array_map('trim', file($logfile)), 'strlen')) : null;
$out['restoreDbLogWarnings'] = $rc ? array_values($DB->get_fieldset_select('backup_logs', 'message',
    'backupid = ? AND loglevel <= ?', [$rc->backupid, backup::LOG_WARNING])) : null;

// ── 2. Precheck del mismo .mbz (sin ejecutar el plan) ──
$tmp = restore_controller::get_tempdir_name(SITEID, $admin->id);
$path = make_backup_temp_directory($tmp);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($in['mbz'], $path);
$prc = new restore_controller($tmp, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_EXISTING_ADDING);
$prc->execute_precheck(true);
$pre = $prc->get_precheck_results();
$prc->destroy();
fulldelete($path);
$out['precheck'] = ['warnings' => array_values($pre['warnings'] ?? []), 'errors' => array_values($pre['errors'] ?? [])];

// ── 3. Estructura por sección (con idnumber = cv3:…) ──
$fs = get_file_storage();
$modinfo = get_fast_modinfo($course);
$sections = [];
foreach ($modinfo->get_section_info_all() as $si) {
    $cms = [];
    foreach ($modinfo->sections[$si->section] ?? [] as $cmid) {
        $cm = $modinfo->get_cm($cmid);
        $row = $DB->get_record('course_modules', ['id' => $cm->id]);
        $ctx = context_module::instance($cm->id);
        $files = [];
        foreach ($fs->get_area_files($ctx->id, 'mod_' . $cm->modname, ['intro', 'package', 'content'], false, 'filearea, filename', false) as $f) {
            $files[] = ['area' => $f->get_filearea(), 'name' => $f->get_filename(), 'hash' => $f->get_contenthash(),
                'size' => (int)$f->get_filesize(), 'mime' => $f->get_mimetype()];
        }
        $cms[] = ['cmid' => (int)$cm->id, 'modname' => $cm->modname, 'name' => $cm->name, 'idnumber' => $row->idnumber,
            'completion' => (int)$row->completion, 'completiongradeitemnumber' => $row->completiongradeitemnumber,
            'completionpassgrade' => (int)$row->completionpassgrade, 'completionview' => (int)$row->completionview,
            'showdescription' => (int)$row->showdescription,
            'files' => $files];
    }
    $sections[] = ['section' => (int)$si->section, 'name' => $si->name, 'cms' => $cms];
}
$out['sections'] = $sections;
$cmByIdnumber = [];
foreach ($sections as $s) { foreach ($s['cms'] as $c) { $cmByIdnumber[$c['cmid']] = $c['idnumber']; } }

// ── 4. Gradebook ──
$cats = [];
foreach (grade_category::fetch_all(['courseid' => $courseid]) as $c) {
    $ci = $c->load_grade_item();
    $cats[] = ['id' => (int)$c->id, 'fullname' => $c->fullname, 'depth' => (int)$c->depth, 'aggregation' => (int)$c->aggregation,
        'aggregateonlygraded' => (int)$c->aggregateonlygraded, 'weight' => (float)$ci->aggregationcoef];
}
usort($cats, fn($a, $b) => $a['id'] <=> $b['id']);
$out['categories'] = $cats;
$catname = [];
foreach ($cats as $c) { $catname[$c['id']] = $c['fullname']; }
$items = [];
foreach (grade_item::fetch_all(['courseid' => $courseid, 'itemtype' => 'mod']) ?: [] as $gi) {
    $cm = get_coursemodule_from_instance($gi->itemmodule, $gi->iteminstance, $courseid);
    $items[] = ['idnumber' => $cm ? ($cmByIdnumber[$cm->id] ?? null) : null, 'itemmodule' => $gi->itemmodule,
        'category' => $catname[$gi->categoryid] ?? null, 'gradepass' => (float)$gi->gradepass,
        'grademax' => (float)$gi->grademax, 'grademin' => (float)$gi->grademin];
}
$out['items'] = $items;
$courseitem = grade_item::fetch_course_item($courseid);
$out['courseItem'] = ['gradepass' => (float)$courseitem->gradepass, 'grademax' => (float)$courseitem->grademax];

// ── 5. Completion del curso ──
$out['criteria'] = [];
foreach ($DB->get_records('course_completion_criteria', ['course' => $courseid], 'id') as $cr) {
    $out['criteria'][] = ['criteriatype' => (int)$cr->criteriatype, 'module' => $cr->module,
        'idnumber' => $cr->moduleinstance ? ($cmByIdnumber[(int)$cr->moduleinstance] ?? 'UNKNOWN_CM') : null,
        'gradepass' => $cr->gradepass === null ? null : (float)$cr->gradepass];
}
$out['aggr'] = array_values(array_map(fn($a) => ['criteriatype' => $a->criteriatype === null ? null : (int)$a->criteriatype,
    'method' => (int)$a->method], $DB->get_records('course_completion_aggr_methd', ['course' => $courseid], 'id')));

// ── 6. Módulos calificables ──
$out['quizzes'] = [];
foreach ($DB->get_records('quiz', ['course' => $courseid]) as $q) {
    $cm = get_coursemodule_from_instance('quiz', $q->id, $courseid);
    $out['quizzes'][$cmByIdnumber[$cm->id]] = ['attempts' => (int)$q->attempts, 'grademethod' => (int)$q->grademethod,
        'sumgrades' => (float)$q->sumgrades, 'grade' => (float)$q->grade, 'preferredbehaviour' => $q->preferredbehaviour,
        'slots' => $DB->count_records('quiz_slots', ['quizid' => $q->id]),
        'maxmarkSum' => (float)$DB->get_field_sql('SELECT SUM(maxmark) FROM {quiz_slots} WHERE quizid = ?', [$q->id])];
}
$out['scorms'] = [];
foreach ($DB->get_records('scorm', ['course' => $courseid]) as $s) {
    $cm = get_coursemodule_from_instance('scorm', $s->id, $courseid);
    $out['scorms'][$cmByIdnumber[$cm->id]] = ['maxgrade' => (float)$s->maxgrade, 'grademethod' => (int)$s->grademethod,
        'whatgrade' => (int)$s->whatgrade, 'maxattempt' => (int)$s->maxattempt, 'masteryoverride' => (int)$s->masteryoverride,
        'completionstatusrequired' => $s->completionstatusrequired, 'completionscorerequired' => $s->completionscorerequired,
        'scoes' => $DB->count_records('scorm_scoes', ['scorm' => $s->id])];
}

// ── 7. H5P: despliegue del paquete (librerías del sitio) ──
function v21p_fresh_page(): void {
    global $PAGE;
    $PAGE = new moodle_page();
    $PAGE->set_context(context_system::instance());
}
$out['h5ps'] = [];
foreach ($DB->get_records('h5pactivity', ['course' => $courseid]) as $h) {
    $cm = get_coursemodule_from_instance('h5pactivity', $h->id, $courseid);
    $ctx = context_module::instance($cm->id);
    $pkg = $fs->get_area_files($ctx->id, 'mod_h5pactivity', 'package', 0, 'id', false);
    $file = reset($pkg);
    $dep = ['h5pid' => false, 'exception' => null, 'messages' => [], 'library' => null];
    if ($file) {
        v21p_fresh_page();
        $url = moodle_url::make_pluginfile_url($file->get_contextid(), $file->get_component(), $file->get_filearea(),
            $file->get_itemid(), $file->get_filepath(), $file->get_filename());
        $messages = new stdClass();
        $factory = new \core_h5p\factory();
        try {
            [$f, $h5pid] = \core_h5p\api::create_content_from_pluginfile_url($url->out(false), new stdClass(), $factory, $messages);
            $dep['h5pid'] = $h5pid;
            if ($h5pid) {
                $content = $factory->get_core()->loadContent($h5pid);
                $dep['library'] = $content['library']['name'] . ' ' . $content['library']['majorVersion'] . '.' . $content['library']['minorVersion'];
            }
        } catch (Throwable $e) {
            $dep['exception'] = get_class($e) . ': ' . $e->getMessage();
        }
        foreach (['error', 'info'] as $k) {
            if (!empty($messages->$k)) {
                foreach ($messages->$k as $m) { $dep['messages'][] = $k . ':' . ($m->code ?? '') . ':' . ($m->message ?? ''); }
            }
        }
    }
    $out['h5ps'][$cmByIdnumber[$cm->id]] = ['grade' => (int)$h->grade, 'grademethod' => (int)$h->grademethod,
        'enabletracking' => (int)$h->enabletracking, 'reviewmode' => (int)$h->reviewmode, 'displayoptions' => (int)$h->displayoptions,
        'deploy' => $dep];
}
file_put_contents($argv[2], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

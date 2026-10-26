<?php
// r74 — restauración y verificación de la ENTREGA de cursos grandes en un Moodle local desechable (CLI, como admin).
//
//   --action=restore-new   --file=<x.mbz> --categoryid=<id>   restaura como curso NUEVO          → «Course ID: N»
//   --action=restore-merge --file=<x.mbz> --courseid=<id>     combina la copia con ESE curso (TARGET_EXISTING_ADDING,
//                                                              lo mismo que «Combinar la copia de seguridad con este curso»)
//   --action=backup        --courseid=<id> --out=<x.mbz>       copia de seguridad NATIVA de Moodle (con archivos, sin usuarios)
//   --action=inspect       --courseid=<id>                     JSON: secciones y actividades en orden, conteos, archivos
//                                                              (bytes, sha1 recalculado del archivo en disco), MP3 y
//                                                              reproductores <audio src> de los labels tras format_text
//   --action=delete        --courseid=<id> --title=<prefijo>   borra el curso de prueba (solo si el nombre empieza así)
// Uso: php -c php.ini r74-delivery.php --moodle=<raíz de Moodle> --action=… [opciones]
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'action:', 'file:', 'categoryid:', 'courseid:', 'out:', 'title:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->dirroot . '/backup/util/includes/backup_includes.php');
require_once($CFG->dirroot . '/course/lib.php');
global $DB, $USER, $CFG;
$admin = get_admin();
\core\session\manager::set_user($admin);
$action = $opts['action'] ?? '';

function r74_extract($file) {
    global $USER;
    if (!file_exists($file)) throw new \moodle_exception('filenotfound');
    $backupdir = restore_controller::get_tempdir_name(SITEID, $USER->id);
    $path = make_backup_temp_directory($backupdir);
    get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($file, $path);
    return $backupdir;
}

if ($action === 'restore-new') {
    $category = $DB->get_record('course_categories', ['id' => (int)$opts['categoryid']], 'id', MUST_EXIST);
    $dir = r74_extract($opts['file']);
    list($fullname, $shortname) = restore_dbops::calculate_course_names(0, get_string('restoringcourse', 'backup'), get_string('restoringcourseshortname', 'backup'));
    $courseid = restore_dbops::create_new_course($fullname, $shortname, $category->id);
    $rc = new restore_controller($dir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_NEW_COURSE);
    $rc->execute_precheck();
    $rc->execute_plan();
    $rc->destroy();
    echo "Course ID: {$courseid}\n";
    exit(0);
}

if ($action === 'restore-merge') {
    $course = $DB->get_record('course', ['id' => (int)$opts['courseid']], 'id', MUST_EXIST);
    $dir = r74_extract($opts['file']);
    $rc = new restore_controller($dir, $course->id, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_EXISTING_ADDING);
    $rc->execute_precheck();
    $rc->execute_plan();
    $rc->destroy();
    echo "Merged into course ID: {$course->id}\n";
    exit(0);
}

if ($action === 'backup') {
    $bc = new backup_controller(backup::TYPE_1COURSE, (int)$opts['courseid'], backup::FORMAT_MOODLE, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id);
    foreach (['users' => 0, 'anonymize' => 0, 'role_assignments' => 0, 'logs' => 0, 'grade_histories' => 0, 'files' => 1, 'activities' => 1] as $k => $v) {
        $plan = $bc->get_plan();
        if ($plan->setting_exists($k)) {
            $s = $plan->get_setting($k);
            if ($s->get_status() === base_setting::NOT_LOCKED) $s->set_value($v);
        }
    }
    $bc->execute_plan();
    $res = $bc->get_results();
    $file = $res['backup_destination'];
    $file->copy_content_to($opts['out']);
    $bc->destroy();
    echo json_encode(['out' => $opts['out'], 'bytes' => filesize($opts['out'])]), "\n";
    exit(0);
}

if ($action === 'inspect') {
    $courseid = (int)$opts['courseid'];
    $course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);
    $modinfo = get_fast_modinfo($course);
    $fs = get_file_storage();
    $out = ['courseid' => $courseid, 'fullname' => $course->fullname, 'sections' => [], 'countsByModname' => [], 'activities' => 0,
        'files' => ['count' => 0, 'bytes' => 0, 'byArea' => [], 'sha1Mismatch' => 0], 'mp3' => [], 'audioPlayers' => []];
    foreach ($modinfo->get_section_info_all() as $si) {
        $sec = ['num' => (int)$si->section, 'name' => (string)$si->name, 'cms' => []];
        foreach ($modinfo->sections[$si->section] ?? [] as $cmid) {
            $cm = $modinfo->cms[$cmid];
            $sec['cms'][] = ['modname' => $cm->modname, 'idnumber' => (string)$cm->idnumber, 'name' => $cm->name];
            $out['countsByModname'][$cm->modname] = ($out['countsByModname'][$cm->modname] ?? 0) + 1;
            $out['activities']++;
        }
        $out['sections'][] = $sec;
    }
    ksort($out['countsByModname']);
    $ctxids = [context_course::instance($courseid)->id];
    foreach ($modinfo->cms as $cm) $ctxids[] = context_module::instance($cm->id)->id;
    $cmByCtx = [];
    foreach ($modinfo->cms as $cm) $cmByCtx[context_module::instance($cm->id)->id] = $cm;
    list($in, $params) = $DB->get_in_or_equal($ctxids);
    $rows = $DB->get_records_select('files', "contextid $in AND filename <> '.'", $params, 'id');
    foreach ($rows as $r) {
        $f = $fs->get_file_instance($r);
        $area = "{$r->component}/{$r->filearea}";
        $out['files']['count']++;
        $out['files']['bytes'] += (int)$r->filesize;
        $out['files']['byArea'][$area] = ($out['files']['byArea'][$area] ?? 0) + 1;
        if (preg_match('/\.mp3$/i', $r->filename)) {
            $h = $f->get_content_file_handle();
            $ctx = hash_init('sha1');
            $n = 0;
            while (!feof($h)) { $chunk = fread($h, 1 << 20); $n += strlen($chunk); hash_update($ctx, $chunk); }
            fclose($h);
            $sha1 = hash_final($ctx);
            if ($sha1 !== $r->contenthash || $n !== (int)$r->filesize) $out['files']['sha1Mismatch']++;
            $cm = $cmByCtx[$r->contextid] ?? null;
            $out['mp3'][] = ['filename' => $r->filename, 'bytes' => (int)$r->filesize, 'sha1' => $sha1, 'mimetype' => $r->mimetype,
                'idnumber' => $cm ? (string)$cm->idnumber : null, 'section' => $cm ? (int)$cm->sectionnum : null];
        }
    }
    ksort($out['files']['byArea']);
    // Reproductores de audio tal como los ve el estudiante (format_text con los filtros del contexto del label).
    foreach ($modinfo->get_instances_of('label') as $cm) {
        $intro = $DB->get_field('label', 'intro', ['id' => $cm->instance]);
        if (stripos($intro, '<audio') === false) continue;
        $ctx = context_module::instance($cm->id);
        $html = file_rewrite_pluginfile_urls($intro, 'pluginfile.php', $ctx->id, 'mod_label', 'intro', null);
        $rendered = format_text($html, FORMAT_HTML, ['context' => $ctx, 'noclean' => false]);
        preg_match_all('/<audio\b[^>]*\bsrc="([^"]+)"|<source\b[^>]*\bsrc="([^"]+)"|<a\b[^>]*href="([^"]+\.mp3)"/i', $rendered, $m, PREG_SET_ORDER);
        $srcs = [];
        foreach ($m as $x) { $u = html_entity_decode($x[1] ?: ($x[2] ?? '') ?: ($x[3] ?? '')); if ($u !== '') $srcs[] = $u; }
        $out['audioPlayers'][] = ['idnumber' => (string)$cm->idnumber, 'section' => (int)$cm->sectionnum, 'srcs' => array_values(array_unique($srcs)),
            'hasAudioTag' => (bool)preg_match('/<audio\b/i', $rendered) || (bool)preg_match('/mediaplugin|video-js|data-setup/i', $rendered)];
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}

if ($action === 'delete') {
    $c = $DB->get_record('course', ['id' => (int)$opts['courseid']]);
    $title = $opts['title'] ?? '';
    if ($c && strlen($title) >= 10 && strpos($c->fullname, $title) === 0) { ob_start(); delete_course($c->id, false); ob_end_clean(); }
    echo json_encode(['courseid' => (int)$opts['courseid'], 'deleted' => !$DB->record_exists('course', ['id' => (int)$opts['courseid']])]), "\n";
    exit(0);
}
fwrite(STDERR, "acción desconocida\n");
exit(2);

<?php
// r60 (D1/D2) — inspección de compatibilidad de un curso Cursia RESTAURADO (Moodle 4.1–4.5, solo lectura salvo el
// despliegue H5P que Moodle hace al ver la actividad). Por curso:
//   - versión de Moodle y API H5P del núcleo (H5PCore::$coreApi), librerías H5P instaladas;
//   - cada h5pactivity: despliegue como administrador (save_h5p, lo mismo que view.php), librería principal,
//     errores («Missing required library …»), interacciones del video, preguntas del conjunto, player sin error;
//   - cada label/intro: tokens $@…@$ sin resolver y destino de cada enlace a sección (section.php?id= o
//     view.php?id=<curso>&section=n): la sección existe y es del curso;
//   - nota mínima del curso y criterio de finalización.
// Uso: php -c php.ini r60-compat-inspect.php --moodle=<raíz> --courseid=<id> --out=<json>
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'courseid:', 'out:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/gradelib.php');
global $DB, $CFG;
\core\session\manager::set_user(get_admin());
$courseid = (int)$opts['courseid'];
$out = ['moodle' => $CFG->release, 'courseid' => $courseid, 'fullname' => get_course($courseid)->fullname];
$coreClass = get_class((new \core_h5p\factory())->get_core());
$api = $coreClass::$coreApi;
$out['h5pCoreApi'] = $api['majorVersion'] . '.' . $api['minorVersion'];
$out['h5pLibrariesInstalled'] = $DB->count_records('h5p_libraries');
$modinfo = get_fast_modinfo($courseid);
$sections = [];
foreach ($modinfo->get_section_info_all() as $s) $sections[$s->id] = ['num' => (int)$s->section, 'name' => get_section_name($courseid, $s)];
$out['sections'] = array_values($sections);
$numToId = [];
foreach ($sections as $id => $s) $numToId[$s['num']] = $id;
$fs = get_file_storage();
$out['h5p'] = [];
$out['links'] = [];
$out['unresolvedTokens'] = [];
foreach ($modinfo->get_cms() as $cm) {
    $rec = $DB->get_record($cm->modname, ['id' => $cm->instance]);
    $html = (string)($rec->intro ?? '') . (string)($rec->content ?? '');
    if (preg_match_all('/\$@[A-Z0-9_]+(\*\d+)?@\$/', $html, $m)) foreach (array_unique($m[0]) as $t) $out['unresolvedTokens'][] = ['idnumber' => $cm->idnumber, 'token' => $t];
    if (preg_match_all('#href="([^"]*/course/(?:section|view)\.php\?[^"]+)"#', $html, $m)) {
        foreach ($m[1] as $u) {
            $u = html_entity_decode($u);
            $l = ['idnumber' => $cm->idnumber, 'url' => $u, 'ok' => false];
            if (preg_match('#/course/section\.php\?id=(\d+)#', $u, $mm)) {
                $l['form'] = 'section.php';
                $l['sectionNum'] = isset($sections[(int)$mm[1]]) ? $sections[(int)$mm[1]]['num'] : null;
                $l['ok'] = $l['sectionNum'] !== null;
            } elseif (preg_match('#/course/view\.php\?id=(\d+)(?:&section=(\d+))?#', $u, $mm)) {
                $l['form'] = isset($mm[2]) ? 'view.php&section' : 'view.php';
                $l['sectionNum'] = isset($mm[2]) ? (int)$mm[2] : null;
                $l['ok'] = (int)$mm[1] === $courseid && (!isset($mm[2]) || isset($numToId[(int)$mm[2]]));
            }
            $out['links'][] = $l;
        }
    }
    if ($cm->modname !== 'h5pactivity') continue;
    $ctx = context_module::instance($cm->id);
    $pkg = $fs->get_area_files($ctx->id, 'mod_h5pactivity', 'package', 0, 'id', false);
    $file = reset($pkg);
    $a = ['idnumber' => $cm->idnumber, 'cmid' => $cm->id, 'grade' => (float)$rec->grade, 'enabletracking' => (int)$rec->enabletracking, 'completion' => (int)$cm->completion];
    $url = moodle_url::make_pluginfile_url($ctx->id, 'mod_h5pactivity', 'package', 0, '/', $file->get_filename());
    $factory = new \core_h5p\factory();
    $fw = $factory->get_framework();
    try {
        list($fileobj, $h5p) = \core_h5p\api::get_original_content_from_pluginfile_url($url->out(), true, true);
        if (!$h5p) {
            $h5pid = \core_h5p\helper::save_h5p($factory, $file, new stdClass(), false, false);
            $a['deployed'] = $h5pid !== false;
            $a['errors'] = array_values(array_unique(array_map(fn($e) => is_object($e) ? ($e->message ?? json_encode($e)) : (string)$e, $fw->getMessages('error') ?: [])));
        } else {
            $a['deployed'] = true;
            $a['errors'] = [];
        }
        $h = $DB->get_record('h5p', ['pathnamehash' => $file->get_pathnamehash()]);
        if ($h) {
            $lib = $DB->get_record('h5p_libraries', ['id' => $h->mainlibraryid]);
            $a['mainLibrary'] = $lib->machinename . ' ' . $lib->majorversion . '.' . $lib->minorversion . '.' . $lib->patchversion;
            $a['dependencies'] = $DB->count_records('h5p_contents_libraries', ['h5pid' => $h->id]);
            $params = json_decode($h->jsoncontent, true);
            if (isset($params['interactiveVideo'])) {
                $iv = $params['interactiveVideo'];
                $a['interactiveVideo'] = ['interactions' => count($iv['assets']['interactions'] ?? []), 'video' => !empty($iv['video']['files'])];
            }
            if (isset($params['questions'])) $a['questionSet'] = ['questions' => count($params['questions']), 'passPercentage' => $params['passPercentage'] ?? null];
            try {
                $player = new \core_h5p\player($url->out(), new stdClass(), true, 'mod_h5pactivity');
                $a['player'] = ['ok' => true];
            } catch (\Throwable $e) {
                $a['player'] = ['ok' => false, 'error' => $e->getMessage()];
            }
        }
    } catch (\Throwable $e) {
        $a['deployed'] = false;
        $a['errors'] = [$e->getMessage()];
    }
    $out['h5p'][] = $a;
}
$ci = grade_item::fetch_course_item($courseid);
$out['courseGradepass'] = $ci ? (float)$ci->gradepass : null;
$out['completionCriteria'] = array_values(array_map(fn($r) => ['type' => (int)$r->criteriatype, 'gradepass' => $r->gradepass === null ? null : (float)$r->gradepass],
    $DB->get_records('course_completion_criteria', ['course' => $courseid], 'id', 'id, criteriatype, gradepass')));
file_put_contents($opts['out'], json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT));
echo "ok\n";

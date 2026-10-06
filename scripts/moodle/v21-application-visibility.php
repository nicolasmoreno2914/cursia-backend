<?php
// Cursia Fase 2 (Actividades de Aplicación): en un curso YA restaurado en el Moodle 4.5 LOCAL desechable, prueba
// con usuarios reales (estudiante y docente con edición, matrícula manual) que:
//   - la página del estudiante (cv3:ch:<id>:application) es visible y accesible para el estudiante;
//   - el solucionario docente (cv3:ch:<id>:application_solution) NO es visible ni accesible para el estudiante
//     (visible=0 → moodle/course:viewhiddenactivities), y SÍ lo ve el docente con edición;
//   - cada página conserva su PDF en mod_page/content (mismo nombre que enlaza el contenido).
// Crea dos usuarios en ESE curso de prueba; no cambia la configuración del sitio.
//
// Uso: php -c php.ini v21-application-visibility.php <input.json> <output.json>   (input: { moodleRoot, courseid })
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/user/lib.php');
global $DB, $CFG;
\core\session\manager::set_user(get_admin());
$courseid = (int)$in['courseid'];
$course = get_course($courseid);

$mkuser = function ($prefix, $first) use ($courseid, $CFG) {
    $u = $prefix . $courseid . '_' . substr(sha1(uniqid('', true)), 0, 8);
    return user_create_user(['username' => $u, 'password' => 'Cursia-F2-' . random_string(12), 'firstname' => $first,
        'lastname' => 'Aplicación', 'email' => $u . '@example.invalid', 'auth' => 'manual', 'confirmed' => 1,
        'mnethostid' => $CFG->mnet_localhost_id], false, false);
};
$manual = enrol_get_plugin('manual');
$instance = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
if (!$instance) {
    $manual->add_instance($course);
    $instance = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual'], '*', MUST_EXIST);
}
$student = $mkuser('cursia_f2_est_', 'Estudiante');
$teacher = $mkuser('cursia_f2_doc_', 'Docente');
$manual->enrol_user($instance, $student, $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST));
$manual->enrol_user($instance, $teacher, $DB->get_field('role', 'id', ['shortname' => 'editingteacher'], MUST_EXIST));

$fs = get_file_storage();
$out = ['courseid' => $courseid, 'pages' => []];
$asStudent = get_fast_modinfo($course, $student);
$asTeacher = get_fast_modinfo($course, $teacher);
foreach ($asStudent->get_cms() as $cm) {
    if ($cm->modname !== 'page' || !preg_match('/^cv3:ch:[^:]+:application(_solution)?$/', (string)$cm->idnumber)) continue;
    $tcm = $asTeacher->get_cm($cm->id);
    $page = $DB->get_record('page', ['id' => $cm->instance], '*', MUST_EXIST);
    $ctx = context_module::instance($cm->id);
    $files = array_values(array_map(function ($f) { return $f->get_filename(); },
        array_filter($fs->get_area_files($ctx->id, 'mod_page', 'content', 0, 'filename', false), function ($f) { return !$f->is_directory(); })));
    $out['pages'][] = [
        'idnumber' => (string)$cm->idnumber,
        'name' => $cm->name,
        'visible' => (int)$cm->visible,
        'studentVisible' => (bool)$cm->uservisible,
        'studentCanView' => (bool)$cm->uservisible && has_capability('mod/page:view', $ctx, $student),
        'teacherVisible' => (bool)$tcm->uservisible,
        'files' => $files,
        'contentLinksFiles' => array_values(array_filter($files, function ($f) use ($page) { return strpos($page->content, '@@PLUGINFILE@@/' . $f) !== false; })),
        'completion' => (int)$cm->completion,
        'completionview' => (int)$cm->completionview,
    ];
}
// LOOP 7 (A4 I1/I2): un docente MUESTRA el solucionario por error (clic en «Mostrar»): el estudiante sigue sin poder
// verlo ni abrir su PDF (override mod/page:view = PROHIBIT del rol estudiante en la actividad); el docente sí.
require_once($CFG->dirroot . '/course/lib.php');
$out['shownByMistake'] = [];
foreach (get_fast_modinfo($course)->get_cms() as $cm) {
    if ($cm->modname !== 'page' || !preg_match('/^cv3:ch:[^:]+:application_solution$/', (string)$cm->idnumber)) continue;
    set_coursemodule_visible($cm->id, 1);
    $ctx = context_module::instance($cm->id);
    $s = get_fast_modinfo($course, $student)->get_cm($cm->id);
    $t = get_fast_modinfo($course, $teacher)->get_cm($cm->id);
    $studentRole = $DB->get_field('role', 'id', ['shortname' => 'student'], MUST_EXIST);
    $out['shownByMistake'][] = [
        'idnumber' => (string)$cm->idnumber,
        'visible' => (int)$DB->get_field('course_modules', 'visible', ['id' => $cm->id]),
        'studentOverride' => (int)$DB->get_field('role_capabilities', 'permission', ['contextid' => $ctx->id, 'roleid' => $studentRole, 'capability' => 'mod/page:view']),
        'studentHasView' => has_capability('mod/page:view', $ctx, $student),
        // pluginfile de mod_page: require_course_login + require_capability('mod/page:view') → lo mismo que esto.
        'studentCanOpen' => (bool)$s->uservisible && has_capability('mod/page:view', $ctx, $student),
        'teacherCanOpen' => (bool)$t->uservisible && has_capability('mod/page:view', $ctx, $teacher),
    ];
    set_coursemodule_visible($cm->id, 0);
}
file_put_contents($argv[2], json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));

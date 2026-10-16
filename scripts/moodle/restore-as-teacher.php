<?php
// Cursia r55 — restaura un .mbz de curso como lo hace un DOCENTE (editingteacher) desde la web: el admin crea un curso
// vacío, inscribe al docente y el docente restaura «en este curso, borrando el contenido» con SU sesión. Los archivos
// restaurados (paquetes .h5p, PDF…) quedan con el docente como dueño (restore_dbops::send_files_to_pool usa al usuario
// que restaura), que es el caso real de un sitio donde los docentes cargan los cursos de Cursia.
//
// Uso: php -c php.ini restore-as-teacher.php --moodle=<raíz> --file=<curso.mbz> --categoryid=<id> [--teacher=<username>]
// Sin --teacher crea un docente ficticio r55t_<marca> (@example.invalid). Salida: «Course ID: N» y «Teacher ID: M».
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'file:', 'categoryid:', 'teacher:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');
require_once($CFG->dirroot . '/course/lib.php');
global $DB, $USER, $CFG;

$admin = get_admin();
\core\session\manager::set_user($admin);
if (!file_exists($opts['file'])) throw new \moodle_exception('filenotfound');
$category = $DB->get_record('course_categories', ['id' => (int)$opts['categoryid']], 'id', MUST_EXIST);
if (!empty($opts['teacher'])) {
    $teacher = $DB->get_record('user', ['username' => $opts['teacher'], 'deleted' => 0], '*', MUST_EXIST);
} else {
    $stamp = time() . '_' . random_string(4);
    $tid = user_create_user((object)['username' => strtolower("r55t_$stamp"), 'password' => 'Fict-' . random_string(14) . '!1', 'firstname' => 'R55',
        'lastname' => 'Docente ficticio', 'email' => strtolower("r55t_$stamp@example.invalid"), 'auth' => 'manual', 'confirmed' => 1,
        'mnethostid' => $CFG->mnet_localhost_id], false, false);
    $teacher = $DB->get_record('user', ['id' => $tid], '*', MUST_EXIST);
}
// Curso destino «normal» (como el que un administrador le crea al docente): valores por defecto del sitio
// (moodlecourse | enablecompletion, etc.), no el registro mínimo de restore_dbops::create_new_course.
$stampc = time() . '_' . random_string(4);
$newcourse = create_course((object)['fullname' => "R55 restaurado por docente $stampc", 'shortname' => "R55T_$stampc", 'category' => $category->id]);
$courseid = (int)$newcourse->id;
$manual = enrol_get_plugin('manual');
$inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual']);
if (!$inst) { $manual->add_default_instance($newcourse); $inst = $DB->get_record('enrol', ['courseid' => $courseid, 'enrol' => 'manual'], '*', MUST_EXIST); }
$manual->enrol_user($inst, $teacher->id, $DB->get_field('role', 'id', ['shortname' => 'editingteacher'], MUST_EXIST));
// Si algo falla, no dejar el curso vacío «restoring» (ni el docente ficticio) en el sitio.
register_shutdown_function(function () use ($courseid, $teacher, $opts) {
    global $DB, $RESTORE_OK;
    if (!empty($RESTORE_OK)) return;
    \core\session\manager::set_user(get_admin());
    if ($c = $DB->get_record('course', ['id' => $courseid])) { ob_start(); delete_course($c, false); ob_end_clean(); }
    if (empty($opts['teacher']) && strpos($teacher->username, 'r55t_') === 0) delete_user($teacher);
    fwrite(STDERR, "restore-as-teacher: falló; se borró el curso $courseid y el docente ficticio\n");
});

\core\session\manager::set_user($teacher);
$ctx = context_course::instance($courseid);
require_capability('moodle/restore:restorecourse', $ctx);
$backupdir = restore_controller::get_tempdir_name(SITEID, $USER->id);
$path = make_backup_temp_directory($backupdir);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($opts['file'], $path);
$rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $teacher->id, backup::TARGET_EXISTING_DELETING);
// En la web el docente elige «Sobrescribir la configuración del curso: Sí» (si no, la completion del curso y el
// formato quedan los del curso destino). Se fija igual que en la interfaz, si el docente puede cambiarlo.
$ow = $rc->get_plan()->get_setting('overwrite_conf');
if ($ow->get_status() === base_setting::NOT_LOCKED) $ow->set_value(true);
$overwrite = (bool)$ow->get_value();
$rc->execute_precheck();
$prec = $rc->get_precheck_results();
restore_dbops::delete_course_content($courseid, ['keep_roles_and_enrolments' => 1, 'keep_groups_and_groupings' => 1]);
$rc->execute_plan();
$badges = $rc->get_plan()->get_setting('badges')->get_value();
$rc->destroy();
$RESTORE_OK = true;
\core\session\manager::set_user($admin);
echo "Course ID: {$courseid}\n";
echo "Teacher ID: {$teacher->id}\n";
echo "Badges setting: " . (int)$badges . "\n";
echo "Overwrite conf: " . (int)$overwrite . "\n";
echo "enablecompletion: " . (int)$DB->get_field('course', 'enablecompletion', ['id' => $courseid]) . "\n";
echo "Precheck: " . json_encode($prec) . "\n";

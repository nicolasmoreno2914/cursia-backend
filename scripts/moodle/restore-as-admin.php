<?php
// LOOP 7 (A4 I1): restaura un .mbz de curso en una categoría NUEVA como lo hace un ADMINISTRADOR desde la web
// (sesión con $USER = admin). admin/cli/restore_backup.php crea el controller con el id del admin pero sin
// sesión: Moodle decide qué overrides de permisos puede aplicar según $USER, y en CLI los descarta
// («Insufficient capability to assign capability»). Este script reproduce el restore real del docente / admin.
//
// Uso: php -c php.ini restore-as-admin.php --moodle=<raíz de Moodle> --file=<curso.mbz> --categoryid=<id>
// Salida (stdout): «Course ID: N».
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'file:', 'categoryid:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
global $DB, $USER;

$admin = get_admin();
if (!$admin) throw new \moodle_exception('noadmins');
\core\session\manager::set_user($admin);
if (!file_exists($opts['file'])) throw new \moodle_exception('filenotfound');
$category = $DB->get_record('course_categories', ['id' => (int)$opts['categoryid']], 'id', MUST_EXIST);

$backupdir = restore_controller::get_tempdir_name(SITEID, $USER->id);
$path = make_backup_temp_directory($backupdir);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($opts['file'], $path);

list($fullname, $shortname) = restore_dbops::calculate_course_names(0, get_string('restoringcourse', 'backup'),
    get_string('restoringcourseshortname', 'backup'));
$courseid = restore_dbops::create_new_course($fullname, $shortname, $category->id);
$rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_NEW_COURSE);
$rc->execute_precheck();
$rc->execute_plan();
$rc->destroy();
echo "Course ID: {$courseid}\n";

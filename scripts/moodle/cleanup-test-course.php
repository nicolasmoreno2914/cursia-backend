<?php
// T7 (r57) — limpieza defensiva de UN curso de prueba restaurado por la simulación comercial (si un paso falló antes
// de su propia limpieza). Borra el curso SOLO si su nombre completo empieza con --title (el título del curso
// sintético) y los usuarios cuyo username empieza con alguno de los --prefixes (separados por coma; cada prefijo debe
// empezar con «cursia_t» o «r55gs_», los de los scripts de prueba). No toca nada más ni la configuración del sitio.
// Solo usuarios con id > --minuserid (creados DESPUÉS de que empezó la prueba de este curso).
// Uso: php -c php.ini cleanup-test-course.php --moodle=<raíz> --courseid=<id> --title=<prefijo del nombre> --minuserid=<n> [--prefixes=a_,b_]
//      php -c php.ini cleanup-test-course.php --moodle=<raíz> --maxuserid   (imprime el mayor id de usuario y sale)
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'courseid:', 'title:', 'prefixes:', 'minuserid:', 'maxuserid']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/user/lib.php');
global $DB;
if (isset($opts['maxuserid'])) { echo (int)$DB->get_field_sql('SELECT MAX(id) FROM {user}'), "\n"; exit(0); }
if (!isset($opts['minuserid']) || (int)$opts['minuserid'] <= 0) { fwrite(STDERR, "--minuserid requerido\n"); exit(2); }
\core\session\manager::set_user(get_admin());
$out = ['courseid' => (int)$opts['courseid'], 'course_deleted' => null, 'users_deleted' => 0];
$c = $DB->get_record('course', ['id' => (int)$opts['courseid']]);
if ($c && strlen($opts['title'] ?? '') >= 10 && strpos($c->fullname, $opts['title']) === 0) { ob_start(); delete_course($c->id, false); ob_end_clean(); }
$out['course_deleted'] = !$DB->record_exists('course', ['id' => (int)$opts['courseid']]);
foreach (array_filter(explode(',', $opts['prefixes'] ?? '')) as $p) {
    if (!preg_match('/^(cursia_t|r55gs_)[a-z0-9_]+$/', $p)) continue;
    foreach ($DB->get_records_select('user', 'username LIKE ? AND deleted = 0 AND id > ?', [$DB->sql_like_escape($p) . '%', (int)$opts['minuserid']]) as $u) { delete_user($u); $out['users_deleted']++; }
}
$out['test_users_left'] = 0;
foreach (array_filter(explode(',', $opts['prefixes'] ?? '')) as $p) $out['test_users_left'] += $DB->count_records_select('user', 'username LIKE ? AND deleted = 0 AND id > ?', [$DB->sql_like_escape($p) . '%', (int)$opts['minuserid']]);
echo json_encode($out), "\n";

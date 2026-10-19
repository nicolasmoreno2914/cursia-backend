<?php
// r60 — estudiante de prueba desechable para el render HTTP (Moodle local de prueba, nunca un sitio real).
//   --action=create --courseids=1,2 --creds=<archivo>  crea r60stu_<aleatorio> con contraseña aleatoria (al archivo,
//                                                      0600; nunca a stdout) y lo matricula como estudiante;
//   --action=delete --creds=<archivo>                  borra ese usuario y el archivo.
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'action:', 'courseids::', 'creds:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');
global $DB, $CFG;
\core\session\manager::set_user(get_admin());
if ($opts['action'] === 'create') {
    $username = 'r60stu_' . bin2hex(random_bytes(4));
    $password = 'R60!' . bin2hex(random_bytes(10));
    $uid = user_create_user((object)['username' => $username, 'password' => $password, 'firstname' => 'Estudiante', 'lastname' => 'Prueba r60',
        'email' => $username . '@example.invalid', 'auth' => 'manual', 'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id], true, false);
    $plugin = enrol_get_plugin('manual');
    $roleid = $DB->get_field('role', 'id', ['shortname' => 'student']);
    foreach (array_filter(array_map('intval', explode(',', $opts['courseids'] ?? ''))) as $cid) {
        $inst = $DB->get_record('enrol', ['courseid' => $cid, 'enrol' => 'manual'], '*', IGNORE_MULTIPLE);
        if (!$inst) { $plugin->add_instance(get_course($cid)); $inst = $DB->get_record('enrol', ['courseid' => $cid, 'enrol' => 'manual'], '*', IGNORE_MULTIPLE); }
        $plugin->enrol_user($inst, $uid, $roleid);
    }
    file_put_contents($opts['creds'], "username=$username\npassword=$password\n");
    chmod($opts['creds'], 0600);
    echo "created userid=$uid siteadmin=" . (is_siteadmin($uid) ? 1 : 0) . "\n";
} else {
    $c = [];
    foreach (file($opts['creds'], FILE_IGNORE_NEW_LINES) as $l) if (preg_match('/^(\w+)=(.*)$/', $l, $m)) $c[$m[1]] = $m[2];
    $u = $DB->get_record('user', ['username' => $c['username'] ?? '', 'deleted' => 0]);
    if ($u && strpos($u->username, 'r60stu_') === 0) delete_user($u);
    @unlink($opts['creds']);
    echo "deleted\n";
}

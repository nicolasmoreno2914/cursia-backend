<?php
// Cursia r55 (R7) — «Repaso» (H5P.Dialogcards) SOLO CONTENIDO: despliegue real en el Moodle 4.5 LOCAL desechable.
//
// Reproduce el diagnóstico de audit-1353/reports/dialogcards-diagnosis.md con el paquete NUEVO:
//   - crea un curso de prueba (shortname R55DC_…), un docente (editingteacher) y un estudiante ficticios, y dos
//     mod_h5pactivity con el MISMO .h5p: uno con el archivo del ADMIN y otro con el archivo del DOCENTE (lo que deja
//     una restauración hecha por un docente: el dueño de los archivos es quien restaura);
//   - para cada estado de librerías del sitio (installed / absent = sin H5P.Dialogcards / olderpatch / newerpatch),
//     simulado DENTRO de una transacción que siempre se revierte, despliega cada instancia con la ruta real del
//     reproductor (\core_h5p\api::create_content_from_pluginfile_url) en un PROCESO PHP NUEVO por caso (= una
//     petición web) con alarma (SIGALRM) de --timeout segundos;
//   - un caso «cebado» en el MISMO proceso: primero el archivo del admin y después el del docente (el estado que
//     colgaba H5PValidator::isValidPackage con la carpeta H5P.Dialogcards-1.9 de los paquetes ≤ 3.13.0);
//   - asserts: nunca supera el timeout; con DC instalado despliega (h5pid > 0, sin errores); sin DC falla LIMPIO
//     (missing-main-library) y rápido; el .h5p no trae carpetas de librería.
// Limpia lo que crea (curso R55DC_ y usuarios r55dc_); nunca toca otros cursos ni la configuración del sitio.
//
// Uso: php -c php.ini check-review-cards-deploy.php --moodle=<raíz> --h5p=<repaso.h5p> [--out=<json>] [--timeout=20]
// Salida: JSON con los resultados; exit 0 = todo OK, 1 = algún assert falló.
// (Modo interno: --deploy=<state> --cmids=<a,b> despliega en ESTE proceso y escribe una línea JSON por cmid.)
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'h5p:', 'out:', 'timeout:', 'deploy:', 'cmids:', 'setup:', 'php:', 'phpini:']);
$moodle = rtrim($opts['moodle'] ?? getenv('E2E_MOODLE_ROOT') ?: '', '/');
if (!$moodle || !is_file("$moodle/config.php")) { fwrite(STDERR, "falta --moodle=<raíz de Moodle>\n"); exit(2); }
require("$moodle/config.php");
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/modlib.php');
require_once($CFG->dirroot . '/user/lib.php');
require_once($CFG->libdir . '/enrollib.php');
global $DB, $CFG;

const PROTECTED_COURSES = [5372, 5374, 5375, 5377, 5378];
$DEPS = "machinename IN ('H5P.Dialogcards','FontAwesome','H5P.Audio','H5P.Components','H5P.FontIcons','H5P.JoubelUI','H5P.Transition','jQuery.ui','H5PEditor.ShowWhen','H5PEditor.VerticalTabs')";

function purge_h5p_caches(): void {
    \cache::make('core', 'h5p_libraries')->purge();
    \cache::make('core', 'h5p_library_files')->purge();
}

// ── modo interno: desplegar en ESTE proceso ───────────────────────────────────
if (isset($opts['deploy'])) {
    $state = $opts['deploy'];
    $cmids = array_filter(array_map('intval', explode(',', $opts['cmids'] ?? '')));
    purge_h5p_caches();
    $tx = $DB->start_delegated_transaction();
    $dc = "machinename = 'H5P.Dialogcards'";
    switch ($state) {
        case 'installed': break;
        case 'absent': $DB->execute("DELETE FROM {h5p_libraries} WHERE $dc"); break;
        case 'olderpatch': $DB->execute("UPDATE {h5p_libraries} SET patchversion = 30 WHERE $dc"); break;
        case 'newerpatch': $DB->execute("UPDATE {h5p_libraries} SET patchversion = 50 WHERE $dc"); break;
        default: fwrite(STDERR, "estado desconocido $state\n"); exit(2);
    }
    foreach ($cmids as $cmid) {
        $ctx = context_module::instance($cmid);
        $files = get_file_storage()->get_area_files($ctx->id, 'mod_h5pactivity', 'package', 0, 'id', false);
        $file = reset($files);
        $owner = $DB->get_record('user', ['id' => $file->get_userid()], '*', MUST_EXIST);
        \core\session\manager::set_user($owner);
        $url = moodle_url::make_pluginfile_url($file->get_contextid(), $file->get_component(), $file->get_filearea(), $file->get_itemid(), $file->get_filepath(), $file->get_filename(), false);
        $factory = new \core_h5p\factory();
        $messages = new stdClass();
        $t0 = microtime(true);
        $canupdate = (int)\core_h5p\helper::can_update_library($file);
        [$f, $h5pid] = \core_h5p\api::create_content_from_pluginfile_url($url->out(false), new stdClass(), $factory, $messages, true, true);
        $m = \core_h5p\helper::get_messages($messages, $factory);
        $errs = array_map(fn($e) => is_object($e) ? (($e->code ?? '') . ': ' . $e->message) : (string)$e, ($m->error ?? null) ?: []);
        echo json_encode(['state' => $state, 'cmid' => $cmid, 'owner' => $owner->username === 'admin' ? 'admin' : 'teacher',
            'can_update_library' => $canupdate, 'h5pid' => $h5pid ? (int)$h5pid : null, 'secs' => round(microtime(true) - $t0, 3),
            'errors' => array_values($errs)], JSON_UNESCAPED_UNICODE), "\n";
    }
    try { $tx->rollback(new Exception('rollback')); } catch (Exception $e) {}
    purge_h5p_caches();
    exit(0);
}

// ── orquestador ───────────────────────────────────────────────────────────────
$h5p = $opts['h5p'] ?? '';
if (!is_file($h5p)) { fwrite(STDERR, "falta --h5p=<paquete .h5p del «Repaso»>\n"); exit(2); }
$timeout = (int)($opts['timeout'] ?? 20);
$php = $opts['php'] ?? PHP_BINARY;
$phpini = $opts['phpini'] ?? (php_ini_loaded_file() ?: '');
$results = ['package' => basename($h5p), 'bytes' => filesize($h5p), 'cases' => [], 'asserts' => []];
$fail = function (string $m) use (&$results) { $results['asserts'][] = ['ok' => false, 'msg' => $m]; };
$pass = function (string $m) use (&$results) { $results['asserts'][] = ['ok' => true, 'msg' => $m]; };

// 0. El paquete es content-only.
$zip = new ZipArchive();
if ($zip->open($h5p) !== true) { fwrite(STDERR, "no se pudo abrir $h5p\n"); exit(2); }
$entries = [];
for ($i = 0; $i < $zip->numFiles; $i++) $entries[] = $zip->getNameIndex($i);
$hj = json_decode($zip->getFromName('h5p.json'), true);
$zip->close();
$libdirs = array_values(array_filter($entries, fn($n) => $n !== 'h5p.json' && strpos($n, 'content/') !== 0));
($libdirs === [] ? $pass : $fail)('el .h5p es solo contenido (' . count($entries) . ' entradas' . ($libdirs ? ', carpetas: ' . implode(',', array_slice($libdirs, 0, 3)) : '') . ')');
(($hj['mainLibrary'] ?? '') === 'H5P.Dialogcards' ? $pass : $fail)('principal H5P.Dialogcards');

$installed = $DB->get_records_select('h5p_libraries', "machinename = 'H5P.Dialogcards'", null, '', 'id, majorversion, minorversion, patchversion');
$results['site_dialogcards'] = array_values(array_map(fn($r) => "{$r->majorversion}.{$r->minorversion}.{$r->patchversion}", $installed));

// 1. Curso, usuarios y las dos instancias (admin / docente) con el mismo .h5p.
\core\session\manager::set_user(get_admin());
$stamp = time() . '_' . random_string(4);
$course = create_course((object)['fullname' => "R55 Repaso deploy $stamp", 'shortname' => "R55DC_$stamp", 'category' => 1, 'enablecompletion' => 1]);
$mk = fn($role) => user_create_user((object)['username' => strtolower("r55dc_{$role}_$stamp"), 'password' => 'Fict-' . random_string(14) . '!1',
    'firstname' => 'R55', 'lastname' => "Ficticio $role", 'email' => strtolower("r55dc_{$role}_$stamp@example.invalid"), 'auth' => 'manual',
    'confirmed' => 1, 'mnethostid' => $CFG->mnet_localhost_id], false, false);
$teacherid = $mk('teacher');
$studentid = $mk('student');
enrol_try_internal_enrol($course->id, $teacherid, $DB->get_field('role', 'id', ['shortname' => 'editingteacher']));
enrol_try_internal_enrol($course->id, $studentid, $DB->get_field('role', 'id', ['shortname' => 'student']));
$teacher = $DB->get_record('user', ['id' => $teacherid]);
$fs = get_file_storage();
$cms = [];
try {
    foreach (['admin' => get_admin(), 'teacher' => $teacher] as $ownername => $owner) {
        \core\session\manager::set_user($owner);
        $draftid = file_get_unused_draft_itemid();
        $fs->create_file_from_pathname(['contextid' => context_user::instance($owner->id)->id, 'component' => 'user', 'filearea' => 'draft',
            'itemid' => $draftid, 'filepath' => '/', 'filename' => basename($h5p), 'userid' => $owner->id], $h5p);
        $mi = create_module((object)['modulename' => 'h5pactivity', 'course' => $course->id, 'section' => 1, 'visible' => 1,
            'name' => "Repaso ($ownername)", 'introeditor' => ['text' => '', 'format' => 1, 'itemid' => 0], 'packagefile' => $draftid,
            'enabletracking' => 0, 'grade' => 0, 'displayoptions' => 15, 'grademethod' => 1, 'reviewmode' => 1, 'completion' => 2, 'completionview' => 1]);
        $cms[$ownername] = (int)$mi->coursemodule;
    }
    \core\session\manager::set_user(get_admin());
    $results['course'] = (int)$course->id;
    $results['cms'] = $cms;

    $run = function (string $state, array $cmids) use ($php, $phpini, $moodle, $timeout) {
        $cmd = ['/usr/bin/perl', '-e', '$t=shift; alarm $t; exec @ARGV or die "exec: $!"', (string)$timeout, $php];
        if ($phpini) { $cmd[] = '-c'; $cmd[] = $phpini; }
        array_push($cmd, __FILE__, "--moodle=$moodle", "--deploy=$state", '--cmids=' . implode(',', $cmids));
        $t0 = microtime(true);
        $p = proc_open($cmd, [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes);
        $out = stream_get_contents($pipes[1]);
        $err = stream_get_contents($pipes[2]);
        fclose($pipes[1]); fclose($pipes[2]);
        $rc = proc_close($p);
        $lines = array_values(array_filter(array_map(fn($l) => json_decode($l, true), explode("\n", trim($out)))));
        return ['rc' => $rc, 'secs' => round(microtime(true) - $t0, 2), 'timedout' => $rc === 142 || ($rc !== 0 && count($lines) < count($cmids)),
            'deploys' => $lines, 'stderr' => substr($err, -600)];
    };

    // 2. Proceso NUEVO por caso (= petición web), cada estado × dueño.
    foreach (['installed', 'absent', 'olderpatch', 'newerpatch'] as $state) {
        foreach ($cms as $owner => $cmid) {
            $r = $run($state, [$cmid]);
            $results['cases'][] = ['kind' => 'fresh', 'state' => $state, 'owner' => $owner] + $r;
            $d = $r['deploys'][0] ?? null;
            if ($r['timedout'] || !$d) { $fail("[$state/$owner] proceso nuevo: sin respuesta antes de {$timeout}s (rc {$r['rc']}) {$r['stderr']}"); continue; }
            if ($state === 'absent') {
                $clean = !$d['h5pid'] && $d['errors'] && preg_match('/missing-main-library|Missing main library/i', implode(' ', $d['errors']));
                ($clean && $d['secs'] < 5 ? $pass : $fail)("[$state/$owner] sin H5P.Dialogcards falla limpio y rápido ({$d['secs']} s): " . implode(' | ', $d['errors']));
            } else {
                ($d['h5pid'] && !$d['errors'] && $d['secs'] < 5 ? $pass : $fail)("[$state/$owner] despliega (h5pid {$d['h5pid']}, {$d['secs']} s)" . ($d['errors'] ? ': ' . implode(' | ', $d['errors']) : ''));
            }
        }
    }
    // 3. MISMO proceso, cebado: archivo del admin primero, después el del docente (el caso que colgaba con la delta).
    foreach (['installed', 'olderpatch', 'newerpatch'] as $state) {
        $r = $run($state, [$cms['admin'], $cms['teacher']]);
        $results['cases'][] = ['kind' => 'primed_same_process', 'state' => $state] + $r;
        $ok = !$r['timedout'] && count($r['deploys']) === 2 && array_reduce($r['deploys'], fn($c, $d) => $c && $d['h5pid'] && !$d['errors'], true);
        ($ok ? $pass : $fail)("[$state] mismo proceso admin → docente: sin cuelgue y ambos despliegan ({$r['secs']} s)" . ($r['timedout'] ? ' — TIMEOUT' : ''));
    }
} finally {
    // 4. Limpieza: solo lo creado aquí.
    \core\session\manager::set_user(get_admin());
    $c = $DB->get_record('course', ['id' => $course->id]);
    if ($c && strpos($c->shortname, 'R55DC_') === 0 && !in_array((int)$c->id, PROTECTED_COURSES, true)) { ob_start(); delete_course($c, false); ob_end_clean(); }
    foreach ([$teacherid, $studentid] as $uid) {
        $u = $DB->get_record('user', ['id' => $uid]);
        if ($u && strpos($u->username, 'r55dc_') === 0) delete_user($u);
    }
    purge_h5p_caches();
    $results['cleanup'] = ['course_deleted' => !$DB->record_exists('course', ['id' => $course->id]),
        'users_deleted' => !$DB->record_exists_select('user', 'id IN (?, ?) AND deleted = 0', [$teacherid, $studentid]),
        'site_dialogcards_after' => array_values(array_map(fn($r) => "{$r->majorversion}.{$r->minorversion}.{$r->patchversion}",
            $DB->get_records_select('h5p_libraries', "machinename = 'H5P.Dialogcards'", null, '', 'id, majorversion, minorversion, patchversion')))];
}
(($results['cleanup']['site_dialogcards_after'] === $results['site_dialogcards']) ? $pass : $fail)('las librerías del sitio quedan como estaban (transacciones revertidas)');
$results['ok'] = !array_filter($results['asserts'], fn($a) => !$a['ok']);
$json = json_encode($results, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
if (!empty($opts['out'])) file_put_contents($opts['out'], $json);
echo $json, "\n";
exit($results['ok'] ? 0 : 1);

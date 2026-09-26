<?php
// Cursia V2.1 / R7-core — imprime en stdout (JSON) las librerías H5P instaladas
// en un Moodle (tabla mdl_h5p_libraries). Solo lectura: no modifica nada.
//
// Uso (CLI de Moodle):
//   php -c <php.ini> scripts/moodle/h5p-installed-libraries.php <moodleDir>
// <moodleDir> es la carpeta que contiene config.php.
//
// Salida: {"moodleRelease": "...", "libraries": [{machineName, majorVersion,
// minorVersion, patchVersion, runnable}]} ordenado por nombre y versión.
define('CLI_SCRIPT', 1);
if (empty($argv[1]) || !is_file(rtrim($argv[1], '/') . '/config.php')) {
    fwrite(STDERR, "usage: php h5p-installed-libraries.php <moodleDirWithConfigPhp>\n");
    exit(2);
}
require(rtrim($argv[1], '/') . '/config.php');
global $DB, $CFG;
$rows = $DB->get_records('h5p_libraries', null, 'machinename ASC, majorversion ASC, minorversion ASC, patchversion ASC',
    'id, machinename, majorversion, minorversion, patchversion, runnable');
$libs = [];
foreach ($rows as $r) {
    $libs[] = [
        'machineName' => $r->machinename,
        'majorVersion' => (int)$r->majorversion,
        'minorVersion' => (int)$r->minorversion,
        'patchVersion' => (int)$r->patchversion,
        'runnable' => (int)$r->runnable,
    ];
}
echo json_encode(['moodleRelease' => $CFG->release, 'libraries' => $libs], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";

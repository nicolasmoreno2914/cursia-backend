<?php
// V2.1 R13 — lee (solo lectura) el intro de cada label / módulo de un curso
// restaurado, indexado por course_modules.idnumber (cv3:…). Imprime una línea JSON.
// Uso: php -c php.ini moodle-v3-labels.php <moodleRoot> <courseid>
define('CLI_SCRIPT', 1);
require($argv[1] . '/config.php');
global $DB;
$courseid = (int)$argv[2];
$out = ['courseid' => $courseid, 'labels' => [], 'names' => []];
$rows = $DB->get_records_sql("SELECT cm.id, cm.idnumber, cm.instance, m.name AS modname FROM {course_modules} cm
    JOIN {modules} m ON m.id = cm.module WHERE cm.course = ?", [$courseid]);
foreach ($rows as $r) {
    if ($r->idnumber === '' || $r->idnumber === null) continue;
    $inst = $DB->get_record($r->modname, ['id' => $r->instance]);
    $out['labels'][$r->idnumber] = isset($inst->intro) ? (string)$inst->intro : '';
    $out['names'][$r->idnumber] = isset($inst->name) ? (string)$inst->name : '';
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n";

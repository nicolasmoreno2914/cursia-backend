<?php
// Cursia EV6 — T5 B1: lectura de un curso YA restaurado (restore-and-inspect.sh): actividades
// (idnumber, modname, nombre) y el intro de cada label, para verificar que un paquete con videos
// pendientes no trae actividad de video ni promete un video en el recorrido. Solo LEE.
//
// Uso: php -c php.ini ev6-pending-labels.php <input.json> <output.json>   input: { moodleRoot, courseid }
define('CLI_SCRIPT', 1);
$in = json_decode(file_get_contents($argv[1]), true);
require($in['moodleRoot'] . '/config.php');
global $DB;
$courseid = (int)$in['courseid'];
$course = get_course($courseid);
$modinfo = get_fast_modinfo($course);
$cms = [];
$labels = [];
foreach ($modinfo->get_cms() as $cm) {
    $idnumber = $DB->get_field('course_modules', 'idnumber', ['id' => $cm->id]);
    $cms[] = ['modname' => $cm->modname, 'name' => $cm->name, 'idnumber' => $idnumber];
    if ($cm->modname === 'label') {
        $labels[] = ['idnumber' => $idnumber, 'intro' => (string)$DB->get_field('label', 'intro', ['id' => $cm->instance])];
    }
}
file_put_contents($argv[2], json_encode(['courseid' => $courseid, 'cms' => $cms, 'labels' => $labels], JSON_UNESCAPED_UNICODE));

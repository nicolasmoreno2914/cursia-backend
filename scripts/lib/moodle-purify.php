<?php
// R2 (Cursia V2.1) — puente de SOLO LECTURA hacia purify_html() de un Moodle local.
// Reproduce lo que hace format_text() con forceclean=1 sobre el HTML de un label.
// Entrada (stdin): JSON array de strings HTML. Salida (stdout): JSON array purificado.
// No escribe configuración del sitio ni datos; solo usa la caché de HTMLPurifier del dataroot.
//
// Uso: MOODLE_CONFIG=/ruta/a/config.php php -c php.ini scripts/lib/moodle-purify.php < in.json
define('CLI_SCRIPT', true);
$config = getenv('MOODLE_CONFIG');
if (!$config || !is_readable($config)) {
    fwrite(STDERR, "MOODLE_CONFIG no apunta a un config.php legible\n");
    exit(2);
}
require($config);
$in = json_decode(stream_get_contents(STDIN), true);
if (!is_array($in)) {
    fwrite(STDERR, "entrada no es un JSON array\n");
    exit(3);
}
$out = [];
foreach ($in as $html) {
    $out[] = purify_html((string)$html);
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

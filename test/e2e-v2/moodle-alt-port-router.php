<?php
// EV6 H5P v2 (H4) — router de `php -S` para browser-h5p2.js --alt-port.
// El Moodle local tiene wwwroot http://127.0.0.1:8099; para correr el QA SIN abrir ni contactar ese
// puerto, PHP escucha en otro (p. ej. 8198) y Chrome llega a través del proxy de browser-h5p2.js
// (--proxy-server): el Host sigue siendo 127.0.0.1:8099 y aquí se finge SERVER_PORT=8099.
$_SERVER['SERVER_PORT'] = '8099';
$root = $_SERVER['DOCUMENT_ROOT'];
$uri = urldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
if (preg_match('#^(.*?\.php)(/.*)?$#', $uri, $m) && is_file($root . $m[1])) {
    $script = $m[1];
    $pathinfo = $m[2] ?? '';
} else if (is_dir($root . $uri) && is_file(rtrim($root . $uri, '/') . '/index.php')) {
    $script = rtrim($uri, '/') . '/index.php';
    $pathinfo = '';
} else {
    return false; // archivo estático
}
$_SERVER['SCRIPT_NAME'] = $script;
$_SERVER['PHP_SELF'] = $script . $pathinfo;
$_SERVER['SCRIPT_FILENAME'] = $root . $script;
if ($pathinfo !== '') {
    $_SERVER['PATH_INFO'] = $pathinfo;
} else {
    unset($_SERVER['PATH_INFO']);
}
chdir(dirname($root . $script));
require $root . $script;

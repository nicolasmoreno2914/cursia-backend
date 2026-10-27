<?php
// r78 «Libro Guía en el celular» — apoyo CLI (como admin) para revisar el libro en línea (mod_book) de un curso
// restaurado en un Moodle local DESECHABLE.
//
//   --action=book --courseid=<id>
//        JSON: el libro (cmid, URL), sus capítulos (id, pagenum, subchapter, título), la secuencia de la sección 1
//        (modname + idnumber) y la descripción del recurso del Libro Guía tal como la pinta la página del curso
//        (format_module_intro) para revisar a dónde apunta «Leer en el celular».
//   --action=app --courseid=<id> --username=<u>
//        JSON: lo que recibe la app oficial de Moodle: el módulo del libro en core_course_get_contents (archivos de
//        contenido) y, por capítulo, el index.html que sirve book_pluginfile a la app (format_text noclean +
//        overflowdiv, con los títulos de Moodle), con la configuración actual del sitio (forceclean).
//
// Uso: php -c php.ini r78-libro-movil.php --moodle=<raíz de Moodle> --action=… [opciones]
define('CLI_SCRIPT', 1);
$opts = getopt('', ['moodle:', 'action:', 'courseid:', 'username:']);
require(rtrim($opts['moodle'], '/') . '/config.php');
require_once($CFG->libdir . '/clilib.php');
require_once($CFG->dirroot . '/course/lib.php');
require_once($CFG->dirroot . '/course/externallib.php');
require_once($CFG->dirroot . '/mod/book/locallib.php');
global $DB, $USER, $CFG, $PAGE;
\core\session\manager::set_user(get_admin());
$action = $opts['action'] ?? '';
$courseid = (int)($opts['courseid'] ?? 0);
$course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);

function r78_book_cm($course) {
    $modinfo = get_fast_modinfo($course);
    $books = array_values(array_filter($modinfo->cms, fn($cm) => $cm->modname === 'book'));
    if (count($books) !== 1) throw new moodle_exception('r78: se esperaba exactamente 1 libro, hay ' . count($books));
    return $books[0];
}

if ($action === 'book') {
    $cm = r78_book_cm($course);
    $book = $DB->get_record('book', ['id' => $cm->instance], '*', MUST_EXIST);
    $chapters = $DB->get_records('book_chapters', ['bookid' => $book->id], 'pagenum ASC');
    $modinfo = get_fast_modinfo($course);
    $sec1 = [];
    foreach ($modinfo->sections[1] ?? [] as $cmid) {
        $x = $modinfo->cms[$cmid];
        $sec1[] = ['cmid' => (int)$x->id, 'modname' => $x->modname, 'idnumber' => (string)$x->idnumber];
    }
    $libro = null;
    foreach ($modinfo->cms as $x) {
        if ($x->idnumber === 'cv3:shell:libro') {
            $PAGE->set_context(context_module::instance($x->id));
            $libro = ['cmid' => (int)$x->id, 'intro' => format_module_intro('resource', $DB->get_record('resource', ['id' => $x->instance]), $x->id)];
        }
    }
    echo json_encode([
        'fullname' => $course->fullname, 'cmid' => (int)$cm->id, 'url' => $cm->url->out(false), 'name' => $cm->name, 'visible' => (bool)$cm->visible,
        'numbering' => (int)$book->numbering, 'navstyle' => (int)$book->navstyle, 'customtitles' => (int)$book->customtitles,
        'chapters' => array_values(array_map(fn($c) => ['id' => (int)$c->id, 'pagenum' => (int)$c->pagenum, 'subchapter' => (int)$c->subchapter, 'title' => $c->title, 'hidden' => (int)$c->hidden, 'bytes' => strlen($c->content)], $chapters)),
        'section1' => $sec1, 'libro' => $libro,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}

if ($action === 'app') {
    $user = $DB->get_record('user', ['username' => $opts['username'], 'deleted' => 0], '*', MUST_EXIST);
    \core\session\manager::set_user($user);
    $sections = \core_course_external::get_course_contents($courseid, []);
    $sections = \core_external\external_api::clean_returnvalue(\core_course_external::get_course_contents_returns(), $sections);
    $cm = r78_book_cm($course);
    $mod = null;
    $libroDescription = null;
    foreach ($sections as $s) {
        foreach ($s['modules'] as $m) {
            if ((int)$m['id'] === (int)$cm->id) $mod = $m;
            if (($m['modname'] ?? '') === 'resource' && strpos($m['description'] ?? '', 'Abrir Libro Guía') !== false) $libroDescription = $m['description'];
        }
    }
    if (!$mod) throw new moodle_exception('r78: el libro no está en core_course_get_contents');
    $context = context_module::instance($cm->id);
    $book = $DB->get_record('book', ['id' => $cm->instance], '*', MUST_EXIST);
    $chapters = book_preload_chapters($book);
    $out = [];
    foreach ($DB->get_records('book_chapters', ['bookid' => $book->id], 'pagenum ASC') as $chapter) {
        // Lo mismo que book_pluginfile() entrega a la app para «index.html» (mod/book/lib.php).
        $content = file_rewrite_pluginfile_urls($chapter->content, 'webservice/pluginfile.php', $context->id, 'mod_book', 'chapter', $chapter->id);
        $fo = new stdClass;
        $fo->noclean = true;
        $fo->overflowdiv = true;
        $fo->context = $context;
        $content = format_text($content, $chapter->contentformat, $fo);
        $titles = '';
        if (!$book->customtitles) {
            if (!$chapter->subchapter) {
                $titles = '<h3>' . book_get_chapter_title($chapter->id, $chapters, $book, $context) . '</h3>';
            } else {
                $titles = '<h3>' . book_get_chapter_title($chapters[$chapter->id]->parent, $chapters, $book, $context) . '</h3>'
                    . '<h4>' . book_get_chapter_title($chapter->id, $chapters, $book, $context) . '</h4>';
            }
        }
        $out[] = ['id' => (int)$chapter->id, 'subchapter' => (int)$chapter->subchapter, 'title' => $chapter->title, 'titles' => $titles, 'html' => $content];
    }
    echo json_encode([
        'forceclean' => (int)($CFG->forceclean ?? 0),
        'module' => ['id' => (int)$mod['id'], 'modname' => $mod['modname'], 'name' => $mod['name'], 'visible' => (int)($mod['visible'] ?? 1),
            'contents' => array_map(fn($c) => ['type' => $c['type'] ?? null, 'filename' => $c['filename'] ?? null, 'filepath' => $c['filepath'] ?? null, 'fileurl' => isset($c['fileurl']) ? 'present' : null, 'content' => $c['content'] ?? null], $mod['contents'] ?? [])],
        'libroDescription' => $libroDescription,
        'chapters' => $out,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}
fwrite(STDERR, "acción desconocida\n");
exit(2);

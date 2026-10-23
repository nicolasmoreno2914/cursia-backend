<?php
// DN-1 — restaura un .mbz (estrategia youtube) en el Moodle 4.5 local y renderiza
// cada label que contiene un link de YouTube con format_module_intro() (=
// format_text con los filtros del CONTEXTO DEL MÓDULO, igual que la página del
// curso), para probar que el filtro multimedia lo convierte en un reproductor
// embebido. Reporta el estado real de la configuración de Moodle:
//   - filter_mediaplugin: estado global (TEXTFILTER_ON/OFF/DISABLED) y activo en el contexto;
//   - media players habilitados (media_plugins_sortorder) y media_videojs/youtube.
// Con la configuración por defecto de Moodle 4.5 (sortorder "videojs,youtube",
// media_videojs/youtube=1) el reproductor es Video.js con la tecnología YouTube
// (`<video data-setup-lazy='{"techOrder":["youtube"], "sources":[{"type":"video/youtube",…}]}'>`,
// el iframe de YouTube lo crea videojs-youtube en el navegador). Si Video.js no
// maneja YouTube, lo toma media_youtube (iframe youtube.com/embed/<id> en el HTML).
// Modo (argv[3]):
//   default        → configuración tal cual la dejó la instalación de Moodle (no toca nada);
//   off            → filter_mediaplugin apagado globalmente (TEXTFILTER_DISABLED): queda el link;
//   on             → filter_mediaplugin encendido globalmente (TEXTFILTER_ON);
//   youtube_player → media_videojs/youtube=0: YouTube lo renderiza media_youtube (iframe).
// Todo cambio de configuración es temporal: se RESTAURA al final.
// Uso: php -c php.ini moodle-render-youtube-labels.php <file.mbz> <out.json> [default|off|on|youtube_player]
define('CLI_SCRIPT', 1);
$MOODLE = getenv('MOODLE_ROOT');
require($MOODLE . '/config.php');
require_once($CFG->dirroot . '/backup/util/includes/restore_includes.php');
require_once($CFG->libdir . '/filterlib.php');

$file = $argv[1];
$out = $argv[2];
$mode = $argv[3] ?? 'default';
global $DB, $PAGE, $CFG;
$admin = get_admin();
\core\session\manager::set_user($admin);

$globalbefore = $DB->get_field('filter_active', 'active', ['filter' => 'mediaplugin', 'contextid' => context_system::instance()->id]);
if ($mode === 'off') filter_set_global_state('mediaplugin', TEXTFILTER_DISABLED);
if ($mode === 'on') filter_set_global_state('mediaplugin', TEXTFILTER_ON);
$vjsyoutubebefore = get_config('media_videojs', 'youtube');
if ($mode === 'youtube_player') set_config('youtube', 0, 'media_videojs');

$backupdir = restore_controller::get_tempdir_name(SITEID, $admin->id);
$path = make_backup_temp_directory($backupdir);
get_file_packer('application/vnd.moodle.backup')->extract_to_pathname($file, $path);
list($fullname, $shortname) = restore_dbops::calculate_course_names(0, 'DN-1 youtube', 'DN1YT');
$courseid = restore_dbops::create_new_course($fullname, $shortname, 1);
$rc = new restore_controller($backupdir, $courseid, backup::INTERACTIVE_NO, backup::MODE_GENERAL, $admin->id, backup::TARGET_NEW_COURSE);
$precheckok = $rc->execute_precheck();
$pre = $rc->get_precheck_results();
$error = null;
try {
    $rc->execute_plan();
} catch (Throwable $e) {
    $error = get_class($e) . ': ' . $e->getMessage();
}
$rc->destroy();

$coursectx = context_course::instance($courseid);
$PAGE->set_url('/course/view.php', ['id' => $courseid]);
$PAGE->set_context($coursectx);
$PAGE->set_course(get_course($courseid));

$sortorder = (string)get_config('core', 'media_plugins_sortorder');
$activefilters = array_keys(filter_get_active_in_context($coursectx));

$res = [
    'moodle_release' => $CFG->release,
    'courseid' => (int)$courseid,
    'mode' => $mode,
    'precheck_ok' => (bool)$precheckok,
    'precheck_warnings' => array_values($pre['warnings'] ?? []),
    'precheck_errors' => array_values($pre['errors'] ?? []),
    'restore_error' => $error,
    'filter_mediaplugin_global_before' => $globalbefore === false ? null : (int)$globalbefore,
    'filter_mediaplugin_global_now' => (int)$DB->get_field('filter_active', 'active', ['filter' => 'mediaplugin', 'contextid' => context_system::instance()->id]),
    'filters_active_in_course' => $activefilters,
    'media_plugins_sortorder' => $sortorder,
    'media_youtube_enabled' => in_array('youtube', explode(',', $sortorder), true),
    'media_videojs_enabled' => in_array('videojs', explode(',', $sortorder), true),
    'media_videojs_youtube' => (string)get_config('media_videojs', 'youtube'),
    'labels' => [],
    'url_activities' => (int)$DB->count_records_sql(
        "SELECT COUNT(1) FROM {course_modules} cm JOIN {modules} m ON m.id = cm.module WHERE cm.course = ? AND m.name = 'url'", [$courseid]),
];

$modinfo = get_fast_modinfo($courseid);
foreach ($modinfo->get_instances_of('label') as $cm) {
    $label = $DB->get_record('label', ['id' => $cm->instance]);
    if (!preg_match('~https://www\.youtube\.com/watch\?v=([A-Za-z0-9_-]{11})~', $label->intro, $m)) continue;
    $videoid = $m[1];
    $rendered = format_module_intro('label', $label, $cm->id);
    $iframes = [];
    if (preg_match_all('~<iframe[^>]*\bsrc="([^"]+)"~i', $rendered, $im)) $iframes = $im[1];
    $watch = 'https://www.youtube.com/watch?v=' . $videoid;
    // Video.js + tech YouTube (default de Moodle 4.5).
    $vjs = (bool)preg_match('~class="[^"]*mediaplugin_videojs~', $rendered)
        && (bool)preg_match('~<video[^>]*data-setup-lazy="[^"]*&quot;techOrder&quot;: \[&quot;youtube&quot;\][^"]*&quot;type&quot;: &quot;video/youtube&quot;, &quot;src&quot;:&quot;' . preg_quote($watch, '~') . '&quot;~', $rendered);
    // media_youtube (iframe en el HTML).
    $ytiframe = (bool)preg_match('~class="[^"]*mediaplugin_youtube~', $rendered)
        && (bool)array_filter($iframes, function ($s) use ($videoid) {
            return strpos($s, 'youtube.com/embed/' . $videoid) !== false || strpos($s, 'youtube-nocookie.com/embed/' . $videoid) !== false;
        });
    $players = substr_count($rendered, 'class="mediaplugin ');
    $res['labels'][] = [
        'cmid' => (int)$cm->id,
        'section' => (int)$cm->sectionnum,
        'name' => $label->name,
        'video_id' => $videoid,
        'raw_intro' => $label->intro,
        'rendered' => $rendered,
        'player' => $vjs ? 'videojs_youtube' : ($ytiframe ? 'youtube_iframe' : 'none'),
        'embeds_this_video' => $vjs || $ytiframe,
        'media_players_in_label' => $players,
        'iframe_srcs' => $iframes,
        'plain_link_kept' => (bool)preg_match('~<a href="' . preg_quote($watch, '~') . '">~', $rendered),
        'fallback_link_kept' => (bool)preg_match('~<a class="nomediaplugin" href="https://www\.youtube\.com/watch\?v=' . preg_quote($videoid, '~') . '"~', $rendered),
    ];
}

// Restaura la configuración si este script la cambió.
if ($mode === 'youtube_player') set_config('youtube', $vjsyoutubebefore, 'media_videojs');
if ($mode === 'off' || $mode === 'on') {
    if ($globalbefore === false) {
        $DB->delete_records('filter_active', ['filter' => 'mediaplugin', 'contextid' => context_system::instance()->id]);
    } else {
        filter_set_global_state('mediaplugin', (int)$globalbefore);
    }
}
file_put_contents($out, json_encode($res, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
echo "OK course=$courseid mode=$mode labels=" . count($res['labels']) . "\n";

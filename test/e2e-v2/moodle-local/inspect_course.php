<?php
// Ad-hoc local script (not part of Moodle core) for the disposable Cursia
// local Moodle test environment. Prints a JSON description of a course's
// structure: sections, activities per section in order, counts by modname,
// and quiz question counts. Read-only, uses $DB directly.

define('CLI_SCRIPT', 1);

require(__DIR__ . '/../../config.php');
require_once($CFG->libdir . '/clilib.php');

list($options, $unrecognized) = cli_get_params([
    'courseid' => 0,
    'help' => false,
], ['c' => 'courseid', 'h' => 'help']);

if ($options['help'] || !$options['courseid']) {
    echo "Usage: php admin/cli/inspect_course.php --courseid=N\n";
    exit($options['help'] ? 0 : 1);
}

$courseid = (int)$options['courseid'];

global $DB;

$course = $DB->get_record('course', ['id' => $courseid], '*', MUST_EXIST);

$result = [
    'course' => [
        'id' => (int)$course->id,
        'shortname' => $course->shortname,
        'fullname' => $course->fullname,
        'visible' => (bool)$course->visible,
    ],
    'sections' => [],
    'modname_counts' => [],
    'quiz_question_counts' => [],
];

$sections = $DB->get_records('course_sections', ['course' => $courseid], 'section ASC');

foreach ($sections as $section) {
    $sectiondata = [
        'section' => (int)$section->section,
        'name' => $section->name !== null && $section->name !== '' ? $section->name : null,
        'visible' => (bool)$section->visible,
        'activities' => [],
    ];

    $sequence = trim((string)$section->sequence);
    if ($sequence !== '') {
        $cmids = array_filter(array_map('trim', explode(',', $sequence)), 'strlen');
        foreach ($cmids as $cmid) {
            $cm = $DB->get_record('course_modules', ['id' => (int)$cmid]);
            if (!$cm) {
                $sectiondata['activities'][] = [
                    'cmid' => (int)$cmid,
                    'modname' => null,
                    'name' => null,
                    'error' => 'course_modules record not found (orphan sequence entry)',
                ];
                continue;
            }
            $module = $DB->get_record('modules', ['id' => $cm->module]);
            $modname = $module ? $module->name : null;
            $name = null;
            if ($modname) {
                $instancerec = $DB->get_record($modname, ['id' => $cm->instance], 'id, name');
                if ($instancerec) {
                    $name = $instancerec->name;
                }
            }
            $sectiondata['activities'][] = [
                'cmid' => (int)$cm->id,
                'modname' => $modname,
                'name' => $name,
                'visible' => (bool)$cm->visible,
            ];
            if ($modname) {
                $result['modname_counts'][$modname] = ($result['modname_counts'][$modname] ?? 0) + 1;
            }
        }
    }

    $result['sections'][] = $sectiondata;
}

// Quiz question counts (Moodle 4.x uses question_references / adhoc question bank entries).
$quizzes = $DB->get_records('quiz', ['course' => $courseid]);
foreach ($quizzes as $quiz) {
    $count = 0;
    // Preferred (4.x): join quiz_slots to know how many question slots exist per quiz.
    if ($DB->get_manager()->table_exists('quiz_slots')) {
        $count = $DB->count_records('quiz_slots', ['quizid' => $quiz->id]);
    }
    $result['quiz_question_counts'][] = [
        'quizid' => (int)$quiz->id,
        'name' => $quiz->name,
        'slot_count' => (int)$count,
    ];
}

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";

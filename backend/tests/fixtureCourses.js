// Applications point to a real course (migration 028). Test fixtures create hidden courses named
// FIXTURE_COURSE_NAME next to their applications (never offered to students); this removes the ones
// no application uses any more. Call it after deleting a test's applications, before deleting its
// programmes or semesters (courses keep those from being deleted).
const FIXTURE_COURSE_NAME = 'Fixture course (tests)';

const removeFixtureCourses = async (db) => (await db.query(
    `DELETE FROM courses c WHERE c.course_name = $1 AND c.status = 'hidden'
       AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.target_course_id = c.id)`,
    [FIXTURE_COURSE_NAME]
)).rowCount;

module.exports = { FIXTURE_COURSE_NAME, removeFixtureCourses };

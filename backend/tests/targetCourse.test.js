/**
 * Each application points to its target course (DB cleanup 1, migration 028):   npm test
 *
 *   - the migration's fill, run for real on copies of the two tables in a throwaway schema
 *     (always rolled back): by the saved id, by programme + semester + normalised code, and every
 *     case it must stop on instead of guessing
 *   - the database refuses to delete a course an application points to
 *   - PDFs still show the course as it was saved at submission, after it is renamed
 * Temporary rows: a programme ZQT…, a semester in 2091, a student; all deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const { getApplicationTermData } = require('../utils/getTermData');

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'migrations', '028_application_target_course.sql'), 'utf8');
const run = Date.now().toString(36).toUpperCase();
let programmeId;
let semesterId;
let studentId;
let courseId;
let applicationId;

// This test's rows, also an earlier run's that stopped half-way (its semester would overlap this one's)
const cleanUp = async () => {
    const semesters = (await pool.query("SELECT id FROM semesters WHERE name LIKE 'Target course test %'")).rows.map((r) => r.id);
    const programmes = (await pool.query("SELECT id FROM programmes WHERE code LIKE 'ZQT%'")).rows.map((r) => r.id);
    await pool.query('DELETE FROM applications WHERE programme_id = ANY($1) OR semester_id = ANY($2)', [programmes, semesters]);
    await pool.query('DELETE FROM courses WHERE programme_id = ANY($1) OR semester_id = ANY($2)', [programmes, semesters]);
    await pool.query("DELETE FROM users WHERE email LIKE '%@target-course-test.invalid'");
    await pool.query('DELETE FROM semesters WHERE id = ANY($1)', [semesters]);
    await pool.query('DELETE FROM programmes WHERE id = ANY($1)', [programmes]);
};

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    await cleanUp();
    programmeId = (await pool.query("INSERT INTO programmes (code, name_hu, name_en, name_de) VALUES ($1, 'Zqt', 'Zqt', 'Zqt') RETURNING id", [`ZQT${run}`.slice(0, 20)])).rows[0].id;
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2091-08-01T08:00:00Z', '2091-08-28T22:59:00Z', '2091-09-14T22:59:00Z', '2091-12-20') RETURNING id`,
        [`Target course test ${run}`]
    )).rows[0].id;
    studentId = (await pool.query(
        `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id)
         VALUES ('Target Course Test', $1, 'not-a-password-hash', 'student', true, $2, $3) RETURNING id`,
        [`tc-${run.toLowerCase()}@target-course-test.invalid`, `T${run.slice(-5)}`.padEnd(6, 'T').slice(0, 6), programmeId]
    )).rows[0].id;
    courseId = (await pool.query(
        "INSERT INTO courses (programme_id, semester_id, course_code, course_name, credits, status) VALUES ($1, $2, 'ZT101', 'Statics', 5, 'active') RETURNING id",
        [programmeId, semesterId]
    )).rows[0].id;
    applicationId = (await pool.query(
        `INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, target_course_id, status, semester_id)
         VALUES ($1, $2, '[]', $3, 'ZT101', $4, 'pending', $5) RETURNING id`,
        [studentId, programmeId, JSON.stringify([{ course_id: courseId, course_code: 'ZT101', course_name: 'Statics', credits: 5 }]), courseId, semesterId]
    )).rows[0].id;
});

after(async () => {
    await cleanUp();
    await pool.end();
});

/**
 * Runs migration 028 on copies of applications and courses as they were before it (with
 * pte_course_names, without target_course_id), filled by `rows`. Always rolled back.
 * @returns {Promise<{ error?: string, linked?: Array<{ id, target_course_id }>, dropped?: boolean }>}
 */
const migrate = async ({ courses, applications }) => {
    const client = await pool.connect();
    const schema = `m028_${run.toLowerCase()}_${Math.floor(Math.random() * 1e6)}`;
    try {
        await client.query('BEGIN');
        await client.query(`CREATE SCHEMA ${schema}`);
        await client.query(`CREATE TABLE ${schema}.courses (LIKE public.courses INCLUDING ALL)`);
        await client.query(`CREATE TABLE ${schema}.applications (LIKE public.applications INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`);
        await client.query(`ALTER TABLE ${schema}.applications DROP COLUMN target_course_id, ADD COLUMN pte_course_names TEXT`);
        await client.query(`SET LOCAL search_path TO ${schema}, public`);
        for (const c of courses) {
            await client.query('INSERT INTO courses (id, university_id, programme_id, semester_id, course_code, course_name, credits) VALUES ($1, $2, $3, $4, $5, $6, 3)',
                [c.id, c.university_id ?? null, c.programme_id, c.semester_id, c.code, c.code]);
        }
        for (const a of applications) {
            await client.query(
                `INSERT INTO applications (id, student_id, programme_id, institutions, target_courses, target_course_code, status, semester_id, pte_course_names)
                 VALUES ($1, $2, $3, '[]', $4, $5, 'withdrawn', $6, $7)`,
                [a.id, 1000 + a.id, a.programme_id, JSON.stringify(a.target ?? []), a.code ?? 'X', a.semester_id, a.legacy ?? null]
            );
        }
        try {
            await client.query('SAVEPOINT before_migration');
            await client.query(MIGRATION);
        } catch (err) {
            return { error: err.message };
        }
        const linked = (await client.query('SELECT id, target_course_id FROM applications ORDER BY id')).rows;
        const dropped = (await client.query(
            "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applications' AND column_name = 'pte_course_names'", [schema]
        )).rows[0].n === 0;
        const notNull = (await client.query(
            "SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'applications' AND column_name = 'target_course_id'", [schema]
        )).rows[0].is_nullable === 'NO';
        return { linked, dropped, notNull };
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
    }
};

test('the fill: by the saved id, else by programme + semester + normalised code; then NOT NULL, pte_course_names dropped', async () => {
    const result = await migrate({
        courses: [{ id: 1, programme_id: 10, semester_id: 5, code: 'CS101' }, { id: 2, programme_id: 10, semester_id: 5, code: 'CS102' }],
        applications: [
            { id: 1, programme_id: 10, semester_id: 5, target: [{ course_id: 2, course_code: 'CS102' }], code: 'CS102', legacy: 'CS102 (x)' },
            { id: 2, programme_id: 10, semester_id: 5, target: [{ course_code: ' cs 101' }], code: 'CS101' },
        ],
    });
    assert.equal(result.error, undefined, result.error);
    assert.deepEqual(result.linked, [{ id: 1, target_course_id: 2 }, { id: 2, target_course_id: 1 }]);
    assert.deepEqual([result.notNull, result.dropped], [true, true]);
});

test('the fill stops and lists instead of guessing', async () => {
    const noMatch = await migrate({
        courses: [{ id: 1, programme_id: 10, semester_id: 5, code: 'CS101' }],
        applications: [{ id: 7, programme_id: 10, semester_id: 6, target: [{ course_code: 'CS101' }], code: 'CS101' }],
    });
    assert.match(noMatch.error || '', /no single course found.*#7 .*0 matching/, 'another semester: no match');

    const two = await migrate({
        courses: [{ id: 1, programme_id: 10, semester_id: 5, code: 'CS101', university_id: null }, { id: 2, programme_id: 10, semester_id: 5, code: 'cs101' }],
        applications: [{ id: 8, programme_id: 10, semester_id: 5, target: [{ course_code: 'CS101' }], code: 'CS101' }],
    });
    assert.match(two.error || '', /#8 .*2 matching/, 'two courses with the same normalised code: not guessed');

    const elsewhere = await migrate({
        courses: [{ id: 1, programme_id: 11, semester_id: 5, code: 'CS101' }],
        applications: [{ id: 9, programme_id: 10, semester_id: 5, target: [{ course_id: 1, course_code: 'CS101' }], code: 'CS101' }],
    });
    assert.match(elsewhere.error || '', /belongs elsewhere: #9/, "a saved id of another programme's course");

    const legacyOnly = await migrate({
        courses: [{ id: 1, programme_id: 10, semester_id: 5, code: 'CS101' }],
        applications: [{ id: 10, programme_id: 10, semester_id: 5, target: [], code: 'CS101', legacy: 'CS101 (Programming)' }],
    });
    assert.match(legacyOnly.error || '', /only pte_course_names: #10/, 'nothing is lost when pte_course_names goes');
});

test('the database refuses to delete a course an application points to', async () => {
    await assert.rejects(pool.query('DELETE FROM courses WHERE id = $1', [courseId]), (err) => err.constraint === 'applications_target_course_id_fkey');
    await assert.rejects(
        pool.query("INSERT INTO applications (student_id, programme_id, institutions, target_courses, target_course_code, status) VALUES ($1, $2, '[]', '[]', 'ZT999', 'pending')", [studentId, programmeId]),
        (err) => err.code === '23502' && err.column === 'target_course_id', 'an application without its course'
    );
});

test('PDFs show the course as saved at submission, also after it is renamed', async () => {
    await pool.query("UPDATE courses SET course_name = 'Statics, renamed by a later import' WHERE id = $1", [courseId]);
    const [app] = (await getApplicationTermData(applicationId)).applications;
    assert.deepEqual(app.pteCourses, ['ZT101 (Statics)']);
    const [own] = (await getApplicationTermData(applicationId, { studentId })).applications;
    assert.deepEqual(own.pteCourses, ['ZT101 (Statics)'], "the student's copy too");
});

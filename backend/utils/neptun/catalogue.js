const crypto = require('crypto');
const { parseCsv } = require('./parse');
const { mapHeader, readRow } = require('./columns');
const { normalizeCourseCode } = require('../applicationForm');

// The Neptun catalogue import (admin round Group 4): programmes and the PTE courses of one semester.
//   readNeptunFile(buffer)              -> checked rows + row errors (nothing touches the database)
//   buildPreview(db, semesterId, file)  -> what an import would change; saves nothing
//   applyImport(client, ...)            -> saves it, inside the caller's transaction
// One file may hold any number of programmes. A bad row is reported with its row number and
// skipped; it never blocks the valid rows. Submitted applications keep their own copy of the
// course (target_courses), so an import never changes them.

const PROGRAMME_CODE = /^[A-Z0-9_-]{1,20}$/;
const COURSE_CODE = /^[A-Z0-9._/-]{1,30}$/;
const MAX_NAME = 200;
const MIN_CREDITS = 1;
const MAX_CREDITS = 60;
const DECISIONS = ['keep', 'hide', 'delete'];

const fileHash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Parses and checks the file. Row errors: { row, code, field? }.
 * @returns {{ hash, programmes: Map<code, {code,name_hu,name_en,name_de,row}>, courses: Array, errors: Array, fileError?: {code,message} }}
 */
const readNeptunFile = (buffer) => {
    let parsed;
    try {
        parsed = parseCsv(buffer);
    } catch (err) {
        return { fileError: { code: err.code || 'INVALID_FILE', message: err.message } };
    }
    const { index, missing } = mapHeader(parsed.header);
    if (missing.length > 0) {
        return { fileError: { code: 'MISSING_COLUMNS', message: `Missing columns: ${missing.join(', ')}`, columns: missing } };
    }

    const programmes = new Map();
    const courses = [];
    const seenCourses = new Set();
    const errors = [];
    for (const { rowNumber, cells } of parsed.rows) {
        const r = readRow(cells, index);
        const code = r.programme_code.toUpperCase();
        const courseCode = normalizeCourseCode(r.course_code);
        const fail = (errorCode, field) => errors.push({ row: rowNumber, code: errorCode, field });

        if (!code) { fail('MISSING_VALUE', 'programme_code'); continue; }
        if (!PROGRAMME_CODE.test(code)) { fail('INVALID_PROGRAMME_CODE', 'programme_code'); continue; }
        if (!r.programme_name_hu) { fail('MISSING_VALUE', 'programme_name_hu'); continue; }
        if ([r.programme_name_hu, r.programme_name_en, r.programme_name_de].some((n) => n.length > MAX_NAME)) { fail('NAME_TOO_LONG', 'programme_name_hu'); continue; }
        if (!courseCode) { fail('MISSING_VALUE', 'course_code'); continue; }
        if (!COURSE_CODE.test(courseCode)) { fail('INVALID_COURSE_CODE', 'course_code'); continue; }
        if (!r.course_name) { fail('MISSING_VALUE', 'course_name'); continue; }
        if (r.course_name.length > MAX_NAME) { fail('NAME_TOO_LONG', 'course_name'); continue; }
        if (!r.credits) { fail('CREDITS_MISSING', 'credits'); continue; }
        if (!/^\d+$/.test(r.credits)) { fail('CREDITS_NOT_A_NUMBER', 'credits'); continue; }
        const credits = Number(r.credits);
        if (credits < MIN_CREDITS || credits > MAX_CREDITS) { fail('CREDITS_OUT_OF_RANGE', 'credits'); continue; }

        // The same programme_code must always come with the same names
        const names = { name_hu: r.programme_name_hu, name_en: r.programme_name_en, name_de: r.programme_name_de };
        const known = programmes.get(code);
        if (known && (known.name_hu !== names.name_hu || known.name_en !== names.name_en || known.name_de !== names.name_de)) {
            fail('PROGRAMME_NAME_CONFLICT', 'programme_name_hu');
            continue;
        }
        const key = `${code}|${courseCode}`;
        if (seenCourses.has(key)) { fail('DUPLICATE_COURSE', 'course_code'); continue; }

        if (!known) programmes.set(code, { code, ...names, row: rowNumber });
        seenCourses.add(key);
        courses.push({ row: rowNumber, programme_code: code, course_code: courseCode, course_name: r.course_name, credits });
    }
    return { hash: fileHash(buffer), programmes, courses, errors, rowCount: parsed.rows.length, delimiter: parsed.delimiter };
};

// What blocks deleting a programme / a course (empty = it can be deleted)
const programmeBlockers = async (db, programmeId, semesterId) => {
    const { rows } = await db.query(
        `SELECT
            (SELECT count(*)::int FROM users WHERE programme_id = $1) AS people,
            (SELECT count(*)::int FROM applications WHERE programme_id = $1) AS applications,
            (SELECT count(*)::int FROM staff_invites WHERE programme_id = $1) AS invites,
            (SELECT count(*)::int FROM student_programme_changes WHERE old_programme_id = $1 OR new_programme_id = $1) AS changes,
            (SELECT count(*)::int FROM courses WHERE programme_id = $1 AND semester_id IS DISTINCT FROM $2) AS other_semester_courses`,
        [programmeId, semesterId]
    );
    const u = rows[0];
    const reasons = [];
    if (u.people) reasons.push('HAS_PEOPLE');
    if (u.applications) reasons.push('HAS_APPLICATIONS');
    if (u.invites || u.changes) reasons.push('HAS_RECORDS');
    if (u.other_semester_courses) reasons.push('HAS_OTHER_SEMESTERS');
    return reasons;
};

const courseUsageSql = `
    (SELECT count(*)::int FROM applications a WHERE a.target_courses @> jsonb_build_array(jsonb_build_object('course_id', c.id))) AS applications,
    (SELECT count(*)::int FROM application_drafts d WHERE d.data->>'target_course_id' = c.id::text) AS drafts,
    COALESCE(sb.status = 'closed', false) AS semester_closed`;

const courseBlockers = (usage) => {
    const reasons = [];
    if (usage.applications) reasons.push('HAS_APPLICATIONS');
    if (usage.drafts) reasons.push('HAS_DRAFTS');
    if (usage.semester_closed) reasons.push('SEMESTER_CLOSED');
    return reasons;
};

/**
 * What importing this file into the semester would do. Saves nothing.
 */
const buildPreview = async (db, semesterId, file) => {
    const dbProgrammes = (await db.query('SELECT id, code, name_en, name_hu, name_de, status FROM programmes ORDER BY code')).rows;
    const byCode = new Map(dbProgrammes.map((p) => [p.code, p]));
    const dbCourses = (await db.query(
        `SELECT c.id, c.course_code, c.course_name, c.credits, c.status, p.code AS programme_code, ${courseUsageSql}
         FROM courses c JOIN programmes p ON p.id = c.programme_id LEFT JOIN semester_bounds sb ON sb.id = c.semester_id
         WHERE c.semester_id = $1 ORDER BY p.code, c.course_code`,
        [semesterId]
    )).rows;
    const courseKey = (programmeCode, courseCode) => `${programmeCode}|${normalizeCourseCode(courseCode)}`;
    const existingCourses = new Map(dbCourses.map((c) => [courseKey(c.programme_code, c.course_code), c]));

    const newProgrammes = [];
    const changedProgrammes = [];
    for (const p of file.programmes.values()) {
        const existing = byCode.get(p.code);
        const after = { name_hu: p.name_hu, name_en: p.name_en || (existing ? existing.name_en : p.name_hu), name_de: p.name_de || (existing ? existing.name_de : p.name_hu) };
        if (!existing) { newProgrammes.push({ code: p.code, ...after }); continue; }
        const shownAgain = existing.status === 'hidden';
        if (shownAgain || after.name_hu !== existing.name_hu || after.name_en !== existing.name_en || after.name_de !== existing.name_de) {
            changedProgrammes.push({ code: p.code, before: { name_hu: existing.name_hu, name_en: existing.name_en, name_de: existing.name_de, status: existing.status }, after: { ...after, status: 'active' } });
        }
    }

    const newCourses = [];
    const changedCourses = [];
    let unchangedCourses = 0;
    for (const c of file.courses) {
        const existing = existingCourses.get(courseKey(c.programme_code, c.course_code));
        if (!existing) { newCourses.push({ programme_code: c.programme_code, course_code: c.course_code, course_name: c.course_name, credits: c.credits }); continue; }
        if (existing.course_name !== c.course_name || existing.credits !== c.credits || existing.status !== 'active') {
            changedCourses.push({
                id: existing.id, programme_code: c.programme_code, course_code: c.course_code,
                before: { course_name: existing.course_name, credits: existing.credits, status: existing.status },
                after: { course_name: c.course_name, credits: c.credits, status: 'active' },
            });
        } else unchangedCourses += 1;
    }

    // Missing from the file: programmes (default Keep), and this semester's courses of a programme
    // that IS in the file (default Hide). Courses of a programme not in the file follow its decision.
    const fileCourseKeys = new Set(file.courses.map((c) => courseKey(c.programme_code, c.course_code)));
    const missingProgrammes = [];
    for (const p of dbProgrammes) {
        if (file.programmes.has(p.code)) continue;
        const reasons = await programmeBlockers(db, p.id, semesterId);
        const ownCourses = dbCourses.filter((c) => c.programme_code === p.code);
        if (ownCourses.some((c) => courseBlockers(c).length > 0) && !reasons.includes('HAS_APPLICATIONS')) reasons.push('COURSES_IN_USE');
        missingProgrammes.push({
            id: p.id, code: p.code, name_en: p.name_en, name_hu: p.name_hu, name_de: p.name_de, status: p.status,
            courses: ownCourses.length, default: 'keep', canDelete: reasons.length === 0, blockedBy: reasons,
        });
    }
    const missingCourses = dbCourses
        .filter((c) => file.programmes.has(c.programme_code) && !fileCourseKeys.has(courseKey(c.programme_code, c.course_code)))
        .map((c) => {
            const reasons = courseBlockers(c);
            return {
                id: c.id, programme_code: c.programme_code, course_code: c.course_code, course_name: c.course_name, credits: c.credits,
                status: c.status, applications: c.applications, default: 'hide', canDelete: reasons.length === 0, blockedBy: reasons,
            };
        });

    return {
        hash: file.hash, rows: file.rowCount, validRows: file.courses.length,
        newProgrammes, changedProgrammes, newCourses, changedCourses, unchangedCourses,
        errors: file.errors, missingProgrammes, missingCourses,
    };
};

// The admin's choice for a missing item, or its default; an unknown value counts as the default
const decisionFor = (decisions, key, fallback) => (DECISIONS.includes(decisions?.[key]) ? decisions[key] : fallback);

/**
 * Saves the import (call inside a transaction). Recomputes the preview first, so what is saved is
 * what the current database and the file say; deleting is checked again and refused for anything in use.
 * @param {{ programmes?: Record<code, decision>, courses?: Record<id, decision> }} decisions
 * @returns {Promise<{ error?: [status, code, message], summary?: object }>}
 */
const applyImport = async (client, semesterId, file, decisions = {}) => {
    const preview = await buildPreview(client, semesterId, file);

    // Refuse the whole import if a delete was asked for something in use (nothing is saved)
    const refusedDeletes = [
        ...preview.missingProgrammes.filter((p) => decisionFor(decisions.programmes, p.code, p.default) === 'delete' && !p.canDelete).map((p) => p.code),
        ...preview.missingCourses.filter((c) => decisionFor(decisions.courses, String(c.id), c.default) === 'delete' && !c.canDelete).map((c) => `${c.programme_code} ${c.course_code}`),
    ];
    if (refusedDeletes.length > 0) {
        return { error: [409, 'DELETE_IN_USE', `In use, so it cannot be deleted: ${refusedDeletes.join(', ')}`], refused: refusedDeletes };
    }

    // The university of the PTE courses (no name written in the code): the one this catalogue
    // already uses, or, for a first import, the only university there is
    const universityId = (await client.query(
        `SELECT COALESCE(
            (SELECT university_id FROM courses WHERE university_id IS NOT NULL GROUP BY university_id ORDER BY count(*) DESC LIMIT 1),
            (SELECT min(id) FROM universities HAVING count(*) = 1)) AS id`
    )).rows[0]?.id ?? null;

    for (const p of preview.newProgrammes) {
        await client.query("INSERT INTO programmes (code, name_hu, name_en, name_de, status) VALUES ($1, $2, $3, $4, 'active')", [p.code, p.name_hu, p.name_en, p.name_de]);
    }
    for (const p of preview.changedProgrammes) {
        await client.query("UPDATE programmes SET name_hu = $2, name_en = $3, name_de = $4, status = 'active' WHERE code = $1", [p.code, p.after.name_hu, p.after.name_en, p.after.name_de]);
    }
    const programmeIds = new Map((await client.query('SELECT id, code FROM programmes')).rows.map((p) => [p.code, p.id]));
    for (const c of preview.newCourses) {
        await client.query(
            "INSERT INTO courses (university_id, programme_id, semester_id, course_code, course_name, credits, status) VALUES ($1, $2, $3, $4, $5, $6, 'active')",
            [universityId, programmeIds.get(c.programme_code), semesterId, c.course_code, c.course_name, c.credits]
        );
    }
    for (const c of preview.changedCourses) {
        await client.query("UPDATE courses SET course_name = $2, credits = $3, status = 'active' WHERE id = $1", [c.id, c.after.course_name, c.after.credits]);
    }

    const counts = { programmesHidden: 0, programmesDeleted: 0, coursesHidden: 0, coursesDeleted: 0 };
    for (const c of preview.missingCourses) {
        const decision = decisionFor(decisions.courses, String(c.id), c.default);
        if (decision === 'hide') counts.coursesHidden += (await client.query("UPDATE courses SET status = 'hidden' WHERE id = $1 AND status <> 'hidden'", [c.id])).rowCount;
        if (decision === 'delete') counts.coursesDeleted += (await client.query('DELETE FROM courses WHERE id = $1', [c.id])).rowCount;
    }
    for (const p of preview.missingProgrammes) {
        const decision = decisionFor(decisions.programmes, p.code, p.default);
        if (decision === 'hide') counts.programmesHidden += (await client.query("UPDATE programmes SET status = 'hidden' WHERE id = $1 AND status <> 'hidden'", [p.id])).rowCount;
        if (decision === 'delete') {
            await client.query('DELETE FROM courses WHERE programme_id = $1 AND semester_id = $2', [p.id, semesterId]);
            counts.programmesDeleted += (await client.query('DELETE FROM programmes WHERE id = $1', [p.id])).rowCount;
        }
    }

    return {
        summary: {
            programmesAdded: preview.newProgrammes.length, programmesChanged: preview.changedProgrammes.length,
            coursesAdded: preview.newCourses.length, coursesChanged: preview.changedCourses.length,
            rowsSkipped: preview.errors.length, ...counts,
        },
    };
};

module.exports = { readNeptunFile, buildPreview, applyImport, programmeBlockers, courseBlockers, courseUsageSql, DECISIONS };

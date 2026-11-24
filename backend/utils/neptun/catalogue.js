const crypto = require('crypto');
const { parseCsv } = require('./parse');
const { mapHeader, readRow } = require('./columns');
const { normalizeCourseCode } = require('../applicationForm');
const {
    loadProgrammes, findLookalikes, checkNewProgramme, cleanNewProgramme, rowMatches, saveAlias, normalizeCode,
} = require('../programmeMatch');

// The Neptun catalogue import (admin round Group 4): the PTE courses of ONE programme in one semester.
//   readNeptunFile(buffer)                          -> checked rows + row errors (nothing touches the database)
//   resolveProgramme(db, choice)                    -> step 1: the programme the import goes into
//   buildPreview(db, semesterId, file, options)     -> what an import would change; saves nothing
//   applyImport(client, semesterId, file, decisions) -> saves it, inside the caller's transaction
// A bad row is reported with its row number and skipped; it never blocks the valid rows. Submitted
// applications keep their own copy of the course (target_courses), so an import never changes them.
//
// Fixes 1b: one programme per import, so a programme is never created twice under two codes.
//   1. The admin chooses the programme first: an existing one, or a new one (code and names) that is
//      checked against the existing ones (utils/programmeMatch.js). A look-alike stops it until the
//      admin answers Same programme (use the existing one) or Different programme (confirmed_different).
//   2. The CSV is uploaded.
//   3. Every row is checked against the chosen programme: its code (or one of the programme's other
//      codes) or its normalised name. Rows that don't match are grouped by code and stop the import
//      until each group is answered "same" (the rows go into the chosen programme and the code is
//      saved as another code of it, so the next import matches by itself). Cancel is the screen
//      going back to the upload: nothing was saved.
// The programme's own names change only from rows written with its own code; other programmes are
// never touched by the import.

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
            -- students of the programme, and staff ever linked to it (ended links are history too)
            (SELECT count(*)::int FROM users WHERE programme_id = $1)
              + (SELECT count(*)::int FROM staff_programmes WHERE programme_id = $1) AS people,
            (SELECT count(*)::int FROM applications WHERE programme_id = $1) AS applications,
            (SELECT count(*)::int FROM staff_invite_programmes WHERE programme_id = $1) AS invites,
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
    (SELECT count(*)::int FROM applications a WHERE a.target_course_id = c.id) AS applications,
    (SELECT count(*)::int FROM application_drafts d WHERE d.data->>'target_course_id' = c.id::text) AS drafts,
    COALESCE(sb.status = 'closed', false) AS semester_closed`;

/**
 * Deletes a programme whose "in use" check passed (call inside the caller's transaction), and what
 * may go with it, explicitly (DB cleanup 2, migration 029: the database deletes nothing along with
 * a programme any more): its other codes, its email-reminder records (a deletable programme has no
 * applications and never had a staff link, so they belong to nothing else), its unused courses,
 * then the programme. If the database still refuses (a link the check did not see, e.g. one made
 * at the same moment), everything is undone back to the savepoint and DELETE_IN_USE is returned.
 * @returns {Promise<{ error?: [status, code, message], blockedBy?: string[], deleted?: true }>}
 */
// The reason shown for a link the database refused (the same reasons as programmeBlockers)
const REFUSED_BY = {
    staff_programmes_programme_id_fkey: 'HAS_PEOPLE',
    users_programme_id_fkey: 'HAS_PEOPLE',
    applications_programme_id_fkey: 'HAS_APPLICATIONS',
    applications_target_course_id_fkey: 'COURSES_IN_USE',
    staff_invite_programmes_programme_id_fkey: 'HAS_RECORDS',
    student_programme_changes_old_programme_id_fkey: 'HAS_RECORDS',
    student_programme_changes_new_programme_id_fkey: 'HAS_RECORDS',
};

const removeProgramme = async (client, programmeId) => {
    await client.query('SAVEPOINT remove_programme');
    try {
        await client.query('DELETE FROM programme_aliases WHERE programme_id = $1', [programmeId]);
        await client.query('DELETE FROM reviewer_reminders WHERE programme_id = $1', [programmeId]);
        await client.query('DELETE FROM committee_reminders WHERE programme_id = $1', [programmeId]);
        await client.query('DELETE FROM courses WHERE programme_id = $1', [programmeId]);
        await client.query('DELETE FROM programmes WHERE id = $1', [programmeId]);
        await client.query('RELEASE SAVEPOINT remove_programme');
        return { deleted: true };
    } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT remove_programme');
        if (err.code === '23503') {
            return { error: [409, 'DELETE_IN_USE', 'This programme is in use, so it cannot be deleted'], blockedBy: [REFUSED_BY[err.constraint] || 'HAS_RECORDS'] };
        }
        throw err;
    }
};

// The database refused to delete a course an application points to (migration 028, ON DELETE
// RESTRICT): the routes answer it like any other "in use" refusal
const isCourseInUseError = (err) => err && err.code === '23503' && err.constraint === 'applications_target_course_id_fkey';

const courseBlockers = (usage) => {
    const reasons = [];
    if (usage.applications) reasons.push('HAS_APPLICATIONS');
    if (usage.drafts) reasons.push('HAS_DRAFTS');
    if (usage.semester_closed) reasons.push('SEMESTER_CLOSED');
    return reasons;
};

const namesOf = (p) => ({ name_hu: p.name_hu, name_en: p.name_en, name_de: p.name_de });
const refusal = (status, code, message, field, extra = {}) => ({ error: [status, code, message, field], ...extra });

/**
 * Step 1: the programme the import goes into.
 * @param {{ id?: number } | { new: { code, name_hu, name_en?, name_de? }, confirmed_different?: boolean }} choice
 * @returns {Promise<{ programme?: object, error?: [status, code, message, field], lookalikes?: Array }>}
 *   programme: { id (null when new), code, name_hu, name_en, name_de, status, aliases, isNew }
 */
const resolveProgramme = async (db, choice) => {
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return refusal(400, 'INVALID_PROGRAMME', 'Choose the programme to import into', 'programme');
    const programmes = await loadProgrammes(db);
    if (choice.new === undefined) {
        const id = Number(choice.id);
        if (!Number.isInteger(id) || id <= 0) return refusal(400, 'INVALID_PROGRAMME', 'Choose the programme to import into', 'programme');
        const found = programmes.find((p) => p.id === id);
        if (!found) return refusal(404, 'PROGRAMME_NOT_FOUND', 'Programme not found', 'programme');
        return { programme: { ...found, isNew: false } };
    }
    const problem = checkNewProgramme(choice.new);
    if (problem) return refusal(400, problem[0], problem[1], problem[2]);
    const clean = cleanNewProgramme(choice.new);
    const lookalikes = findLookalikes(programmes, clean);
    if (lookalikes.some((l) => l.reasons.includes('same_code'))) {
        return refusal(409, 'PROGRAMME_CODE_TAKEN', `${clean.code} is already the code of a programme`, 'code', { lookalikes });
    }
    if (lookalikes.length > 0 && choice.confirmed_different !== true) {
        return refusal(409, 'PROGRAMME_LOOKALIKE', `This looks like ${lookalikes.map((l) => l.code).join(', ')}: answer Same or Different programme`, 'programme', { lookalikes });
    }
    return { programme: { id: null, ...clean, status: 'active', aliases: [], isNew: true } };
};

// Row numbers as short ranges: [3,4,5,9] -> "3–5, 9"
const rowRanges = (rows) => {
    const sorted = [...rows].sort((a, b) => a - b);
    const parts = [];
    for (let i = 0; i < sorted.length; i += 1) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
        parts.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
        i = j;
    }
    return parts.join(', ');
};

/**
 * Step 3: the file's programmes that are not the chosen one, grouped by code with their rows. A
 * group whose code is ANOTHER programme's code or alias names that programme (owner): it can only
 * be cancelled, never treated as the same.
 */
const mismatchGroups = (chosen, file, programmes) => {
    const groups = [];
    for (const p of file.programmes.values()) {
        if (rowMatches(chosen, p)) continue;
        const rows = file.courses.filter((c) => c.programme_code === p.code).map((c) => c.row);
        const owner = programmes.find((x) => x.id !== chosen.id && (x.code.toUpperCase() === p.code || x.aliases.includes(p.code)));
        groups.push({
            code: p.code, ...namesOf(p), rows: rows.length, rowRanges: rowRanges(rows),
            owner: owner ? { id: owner.id, code: owner.code, ...namesOf(owner) } : null,
        });
    }
    return groups;
};

/**
 * What importing this file into the chosen programme and semester would do. Saves nothing.
 * @param {{ programme: object, mismatches?: Record<code, 'same'> }} options  programme from resolveProgramme
 * @returns {Promise<object>}  { ready: false, mismatches } while a group is unanswered; else the full preview
 */
const buildPreview = async (db, semesterId, file, { programme, mismatches = {} }) => {
    const programmes = await loadProgrammes(db);
    const groups = mismatchGroups(programme, file, programmes)
        .map((g) => ({ ...g, decision: mismatches?.[g.code] === 'same' ? 'same' : null }));
    const taken = groups.find((g) => g.decision === 'same' && g.owner);
    if (taken) {
        return refusal(409, 'ALIAS_TAKEN', `${taken.code} is already the code of ${taken.owner.code}, so it cannot be treated as ${programme.code}`, 'mismatches');
    }
    const chosen = { id: programme.id, code: programme.code, ...namesOf(programme), status: programme.status, isNew: programme.isNew };
    const base = { hash: file.hash, rows: file.rowCount, programme: chosen, mismatches: groups };
    if (groups.some((g) => !g.decision)) return { ...base, ready: false, errors: file.errors };

    // Every valid row goes into the chosen programme; the same course twice: the first row wins
    const seen = new Set();
    const mappedErrors = [];
    const fileCourses = [];
    for (const c of file.courses) {
        if (seen.has(c.course_code)) { mappedErrors.push({ row: c.row, code: 'DUPLICATE_COURSE', field: 'course_code' }); continue; }
        seen.add(c.course_code);
        fileCourses.push({ ...c, programme_code: programme.code });
    }

    // The programme: new, or changed by rows written with its own code (new names, or shown again)
    const newProgrammes = programme.isNew ? [{ code: programme.code, ...namesOf(programme) }] : [];
    const changedProgrammes = [];
    const ownRow = file.programmes.get(normalizeCode(programme.code));
    if (!programme.isNew) {
        const after = ownRow
            ? { name_hu: ownRow.name_hu, name_en: ownRow.name_en || programme.name_en, name_de: ownRow.name_de || programme.name_de }
            : namesOf(programme);
        if (programme.status === 'hidden' || after.name_hu !== programme.name_hu || after.name_en !== programme.name_en || after.name_de !== programme.name_de) {
            changedProgrammes.push({ id: programme.id, code: programme.code, before: { ...namesOf(programme), status: programme.status }, after: { ...after, status: 'active' } });
        }
    }

    const dbCourses = programme.isNew ? [] : (await db.query(
        `SELECT c.id, c.course_code, c.course_name, c.credits, c.status, ${courseUsageSql}
         FROM courses c LEFT JOIN semester_bounds sb ON sb.id = c.semester_id
         WHERE c.semester_id = $1 AND c.programme_id = $2 ORDER BY c.course_code`,
        [semesterId, programme.id]
    )).rows;
    const existingCourses = new Map(dbCourses.map((c) => [normalizeCourseCode(c.course_code), c]));
    const newCourses = [];
    const changedCourses = [];
    let unchangedCourses = 0;
    for (const c of fileCourses) {
        const existing = existingCourses.get(c.course_code);
        if (!existing) { newCourses.push({ programme_code: programme.code, course_code: c.course_code, course_name: c.course_name, credits: c.credits }); continue; }
        if (existing.course_name !== c.course_name || existing.credits !== c.credits || existing.status !== 'active') {
            changedCourses.push({
                id: existing.id, programme_code: programme.code, course_code: c.course_code,
                before: { course_name: existing.course_name, credits: existing.credits, status: existing.status },
                after: { course_name: c.course_name, credits: c.credits, status: 'active' },
            });
        } else unchangedCourses += 1;
    }
    // This semester's courses of the programme that the file no longer has (default Hide)
    const missingCourses = dbCourses.filter((c) => !seen.has(normalizeCourseCode(c.course_code))).map((c) => {
        const reasons = courseBlockers(c);
        return {
            id: c.id, programme_code: programme.code, course_code: c.course_code, course_name: c.course_name, credits: c.credits,
            status: c.status, applications: c.applications, default: 'hide', canDelete: reasons.length === 0, blockedBy: reasons,
        };
    });

    return {
        ...base, ready: true, validRows: fileCourses.length,
        newProgrammes, changedProgrammes, newCourses, changedCourses, unchangedCourses,
        errors: [...file.errors, ...mappedErrors], missingCourses,
        aliasesToSave: groups.map((g) => g.code),
    };
};

// The admin's choice for a missing course, or its default; an unknown value counts as the default
const decisionFor = (decisions, key, fallback) => (DECISIONS.includes(decisions?.[key]) ? decisions[key] : fallback);

/**
 * Saves the import (call inside a transaction; the caller rolls back on an error). Everything is
 * worked out again first, so what is saved is what the current database and the file say.
 * @param {{ programme: object, mismatches?: Record<code, 'same'>, courses?: Record<id, decision> }} decisions
 *   programme: the step 1 choice, as for resolveProgramme
 * @param {{ actorId?: number }} options  who imports (recorded on the aliases it saves)
 * @returns {Promise<{ error?: [status, code, message, field], summary?: object }>}
 */
const applyImport = async (client, semesterId, file, decisions = {}, { actorId = null } = {}) => {
    const mismatches = decisions.mismatches && typeof decisions.mismatches === 'object' && !Array.isArray(decisions.mismatches) ? decisions.mismatches : {};
    const badAnswer = Object.entries(mismatches).find(([, value]) => value !== 'same');
    if (badAnswer) return refusal(400, 'INVALID_DECISIONS', `Unknown answer for ${badAnswer[0]}: only "same" (or cancel the import)`, 'mismatches');
    const resolved = await resolveProgramme(client, decisions.programme);
    if (resolved.error) return resolved;
    const { programme } = resolved;
    const preview = await buildPreview(client, semesterId, file, { programme, mismatches });
    if (preview.error) return preview;
    if (!preview.ready) {
        const undecided = preview.mismatches.filter((g) => !g.decision).map((g) => g.code);
        return refusal(409, 'MISMATCH_DECISION_NEEDED', `Rows with ${undecided.join(', ')} do not match ${programme.code}: answer each group first`, 'mismatches', { undecided });
    }

    // Refuse the whole import if a delete was asked for something in use (nothing is saved)
    const refusedDeletes = preview.missingCourses
        .filter((c) => decisionFor(decisions.courses, String(c.id), c.default) === 'delete' && !c.canDelete)
        .map((c) => `${c.programme_code} ${c.course_code}`);
    if (refusedDeletes.length > 0) return refusal(409, 'DELETE_IN_USE', `In use, so it cannot be deleted: ${refusedDeletes.join(', ')}`, undefined, { refused: refusedDeletes });

    let programmeId = programme.id;
    if (programme.isNew) {
        programmeId = (await client.query(
            "INSERT INTO programmes (code, name_hu, name_en, name_de, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id",
            [programme.code, programme.name_hu, programme.name_en, programme.name_de]
        )).rows[0].id;
    }
    for (const p of preview.changedProgrammes) {
        await client.query("UPDATE programmes SET name_hu = $2, name_en = $3, name_de = $4, status = 'active' WHERE id = $1", [p.id, p.after.name_hu, p.after.name_en, p.after.name_de]);
    }
    // The codes answered "same" become other codes of the programme: the next import matches them by itself
    let aliasesSaved = 0;
    for (const code of preview.aliasesToSave) {
        const saved = await saveAlias(client, programmeId, code, actorId);
        if (saved.error) return saved;
        aliasesSaved += saved.added;
    }
    for (const c of preview.newCourses) {
        await client.query(
            "INSERT INTO courses (programme_id, semester_id, course_code, course_name, credits, status) VALUES ($1, $2, $3, $4, $5, 'active')",
            [programmeId, semesterId, c.course_code, c.course_name, c.credits]
        );
    }
    for (const c of preview.changedCourses) {
        await client.query("UPDATE courses SET course_name = $2, credits = $3, status = 'active' WHERE id = $1", [c.id, c.after.course_name, c.after.credits]);
    }
    const counts = { coursesHidden: 0, coursesDeleted: 0 };
    for (const c of preview.missingCourses) {
        const decision = decisionFor(decisions.courses, String(c.id), c.default);
        if (decision === 'hide') counts.coursesHidden += (await client.query("UPDATE courses SET status = 'hidden' WHERE id = $1 AND status <> 'hidden'", [c.id])).rowCount;
        if (decision === 'delete') counts.coursesDeleted += (await client.query('DELETE FROM courses WHERE id = $1', [c.id])).rowCount;
    }

    return {
        summary: {
            programme: programme.code, programmeId,
            programmesAdded: preview.newProgrammes.length, programmesChanged: preview.changedProgrammes.length, aliasesSaved,
            coursesAdded: preview.newCourses.length, coursesChanged: preview.changedCourses.length,
            rowsSkipped: preview.errors.length, ...counts,
        },
    };
};

/**
 * The part of a file with one programme code (the demo fixture holds several programmes; each is
 * imported on its own, as the admin screen does).
 */
const fileForProgramme = (file, code) => ({
    ...file,
    programmes: new Map([[code, file.programmes.get(code)]]),
    courses: file.courses.filter((c) => c.programme_code === code),
    errors: [],
    rowCount: file.courses.filter((c) => c.programme_code === code).length,
});

module.exports = {
    readNeptunFile, resolveProgramme, buildPreview, applyImport, fileForProgramme,
    programmeBlockers, removeProgramme, courseBlockers, courseUsageSql, isCourseInUseError, DECISIONS,
};

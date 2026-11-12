const pool = require('../db');
const minioClient = require('../minio');
const inTransaction = require('./transaction');
const { getSemesterTermData } = require('./getTermData');
const buildTermBookPdf = require('./buildTermBookPdf');
const { ARCHIVE_BUCKET } = require('../config/buckets');

// Closing a semester (admin round Group 6; round 2 Group 1: the review period). An admin click,
// never automatic. Allowed once
//   - its application period is over (no Close now needed: its closing time has passed),
//   - no late access of it is still running, and
//   - nothing in it is pending or in needs info (every application decided or withdrawn),
//   - nothing in it awaits the committee (round 2 Group 2: the decisions are final),
// even before its review deadline (the review deadline is a target, not a lock). The preview lists
// what blocks it, per programme. Nobody is rejected by the close any more (old closes keep their
// "SEMESTER_ENDED" records and texts). In ONE transaction:
//   - its late access ends (expired grants are marked ended too)
//   - unsent drafts are deleted, unless another semester's application period is open or still to
//     come (drafts have no semester: then they belong to that period and stay)
//   - the semester becomes closed (closed_at, closed_by)
// After the commit: the PDF book. If the PDF fails, the close stands and the error is kept on the
// semester, so the admin can generate it again. Nothing else is deleted.
// A closed semester is read-only for everyone (utils/semesters.js semesterEndedSql).

// Everything that blocks a close: undecided, and (round 2 Group 2) awaiting the committee
const NOT_FINAL = ['pending', 'needs_info', 'awaiting_committee'];

// Shared by the preview and the close: $1 the semester, $2 now
const STATE_SQL = `
    s.applications_close_at <= $2 AS period_over,
    s.review_end_at <= $2 AS review_passed, s.review_end_at,
    (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id AND a.status = 'pending') AS pending,
    (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id AND a.status = 'needs_info') AS needs_info,
    (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id AND a.status = 'awaiting_committee') AS awaiting_committee,
    (SELECT count(*)::int FROM late_access l WHERE l.semester_id = s.id AND l.revoked_at IS NULL AND l.deadline > $2) AS late_access,
    -- drafts stay when another semester's application period is open or still to come
    EXISTS (SELECT 1 FROM semesters o WHERE o.id <> s.id AND o.status IN ('setup', 'active') AND o.applications_close_at > $2) AS drafts_belong_elsewhere`;

// The reasons a close is refused now, in the order they are shown
const blockersOf = (r) => [
    !r.period_over && 'PERIOD_STILL_OPEN',
    r.late_access > 0 && 'LATE_ACCESS_ACTIVE',
    r.pending + r.needs_info > 0 && 'UNDECIDED_APPLICATIONS',
    r.awaiting_committee > 0 && 'AWAITING_COMMITTEE',
].filter(Boolean);

/**
 * What a close would do right now, and what blocks it; saves nothing. The same conditions as closeSemester.
 * @returns {Promise<null | { id, name, status, canClose, blockers, periodOver, reviewPassed, reviewEndAt,
 *   pending, needsInfo, lateAccess, drafts, draftsKept, undecidedByProgramme }>}
 */
// requireActive: false only in the tests (their far-future semesters stay in setup), as in closeSemester
const closePreview = async (db, semesterId, { now = new Date(), onlyDraftsOf = null, requireActive = true } = {}) => {
    const { rows } = await db.query(
        `SELECT s.id, s.name, s.status, ${STATE_SQL},
                (SELECT count(*)::int FROM application_drafts d WHERE $3::int[] IS NULL OR d.student_id = ANY($3)) AS drafts
         FROM semesters s WHERE s.id = $1`,
        [semesterId, now, onlyDraftsOf]
    );
    const r = rows[0];
    if (!r) return null;
    // What is still undecided, per programme (what blocks the close)
    const undecided = (await db.query(
        `SELECT p.code, p.name_en, p.name_hu, p.name_de,
                count(*) FILTER (WHERE a.status = 'pending')::int AS pending,
                count(*) FILTER (WHERE a.status = 'needs_info')::int AS needs_info,
                count(*) FILTER (WHERE a.status = 'awaiting_committee')::int AS awaiting_committee
         FROM applications a JOIN programmes p ON p.id = a.programme_id
         WHERE a.semester_id = $1 AND a.status = ANY($2)
         GROUP BY p.id ORDER BY p.code`,
        [semesterId, NOT_FINAL]
    )).rows;
    const blockers = r.status === 'closed' ? ['ALREADY_CLOSED']
        : r.status !== 'active' && requireActive ? ['SEMESTER_NOT_ACTIVE'] : blockersOf(r);
    return {
        id: r.id, name: r.name, status: r.status, canClose: blockers.length === 0, blockers,
        periodOver: r.period_over, reviewPassed: r.review_passed, reviewEndAt: r.review_end_at,
        pending: r.pending, needsInfo: r.needs_info, awaitingCommittee: r.awaiting_committee, lateAccess: r.late_access,
        drafts: r.drafts_belong_elsewhere ? 0 : r.drafts, draftsKept: r.drafts_belong_elsewhere ? r.drafts : 0,
        undecidedByProgramme: undecided,
    };
};

// The refusal answers for blockersOf
const REFUSAL = {
    PERIOD_STILL_OPEN: [409, 'PERIOD_STILL_OPEN', 'The application period is still open: close it first (Close now) or wait for its closing time'],
    LATE_ACCESS_ACTIVE: [409, 'LATE_ACCESS_ACTIVE', 'Late access of this semester is still running: wait for its deadline or revoke it'],
    UNDECIDED_APPLICATIONS: [409, 'UNDECIDED_APPLICATIONS', 'Some applications are still pending or in needs info: decide them first'],
    AWAITING_COMMITTEE: [409, 'AWAITING_COMMITTEE', 'Some decisions are still waiting for the committee'],
};

/**
 * Generates (or generates again) the PDF book of a closed semester and remembers it on the
 * semester. Never throws: a failure is stored in semesters.book_error and returned.
 * @returns {Promise<{ name?: string, error?: string }>}
 */
const generateSemesterBook = async (semesterId, { generatedBy = null } = {}) => {
    try {
        const semester = (await pool.query('SELECT status FROM semesters WHERE id = $1', [semesterId])).rows[0];
        if (!semester || semester.status !== 'closed') throw new Error('Only a closed semester has a PDF book');
        const data = await getSemesterTermData(semesterId);
        const { buffer, pages } = await buildTermBookPdf(data);
        if (!(await minioClient.bucketExists(ARCHIVE_BUCKET))) await minioClient.makeBucket(ARCHIVE_BUCKET, 'us-east-1');
        const name = `semester-book_${semesterId}_${Date.now()}.pdf`;
        await minioClient.putObject(ARCHIVE_BUCKET, name, buffer, buffer.length, {
            'Content-Type': 'application/pdf',
            'X-Amz-Meta-Applications': String(data.total),
            'X-Amz-Meta-Pages': String(pages),
            'X-Amz-Meta-Generated-By': String(generatedBy ?? ''),
        });
        await pool.query('UPDATE semesters SET book_name = $2, book_generated_at = now(), book_error = NULL WHERE id = $1', [semesterId, name]);
        console.log(`📚 Semester book ${name}: ${data.total} applications, ${pages} pages`);
        return { name };
    } catch (err) {
        const message = String(err.message || err).slice(0, 500);
        console.error(`❌ Semester book for semester ${semesterId} failed:`, message);
        await pool.query('UPDATE semesters SET book_error = $2 WHERE id = $1', [semesterId, message]).catch(() => {});
        return { error: message };
    }
};

/**
 * Closes the semester. `confirmName` must be the semester's name exactly (the admin types it).
 * `now`, `onlyDraftsOf` and `book`: for the tests (a fake clock, the test students' drafts only,
 * no PDF). requireActive: false only in the tests, which close their own far-future semester.
 * @returns {Promise<{ error?: [status, code, message], summary?: object }>}
 */
const closeSemester = async ({ semesterId, adminId, confirmName, now = new Date(), onlyDraftsOf = null, book = true, requireActive = true }) => {
    const result = await inTransaction(async (client) => {
        // Locking the semester row: granting late access and Reopen until lock it too, so nothing
        // can reopen submitting while this runs
        const s = (await client.query(`SELECT s.id, s.name, s.status, ${STATE_SQL} FROM semesters s WHERE s.id = $1 FOR UPDATE`, [semesterId, now])).rows[0];
        if (!s) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
        if (s.status === 'closed') return { error: [409, 'ALREADY_CLOSED', 'This semester is already closed'] };
        if (s.status !== 'active' && requireActive) return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only a semester in progress can be closed'] };
        if (typeof confirmName !== 'string' || confirmName.trim() !== s.name) {
            return { error: [400, 'CONFIRM_NAME_MISMATCH', 'Type the semester name exactly to confirm', 'confirm_name'] };
        }
        // The undecided ones, locked, so none can turn up between this check and the close
        await client.query('SELECT id FROM applications WHERE semester_id = $1 AND status = ANY($2) FOR UPDATE', [s.id, NOT_FINAL]);
        const [blocker] = blockersOf(s);
        if (blocker) return { error: REFUSAL[blocker] };

        const lateAccess = (await client.query(
            'UPDATE late_access SET revoked_at = $2, revoked_by = $3 WHERE semester_id = $1 AND revoked_at IS NULL',
            [s.id, now, adminId]
        )).rowCount;
        const drafts = s.drafts_belong_elsewhere ? 0
            : (await client.query('DELETE FROM application_drafts WHERE $1::int[] IS NULL OR student_id = ANY($1)', [onlyDraftsOf])).rowCount;
        await client.query("UPDATE semesters SET status = 'closed', closed_at = $2, closed_by = $3, close_reason = NULL WHERE id = $1", [s.id, now, adminId]);
        return { counts: { lateAccess, drafts, draftsKept: s.drafts_belong_elsewhere } };
    });
    if (result.error) return result;

    // After the commit: the PDF book
    const pdf = book ? await generateSemesterBook(semesterId, { generatedBy: adminId }) : { skipped: true };
    return { summary: { ...result.counts, book: pdf } };
};

module.exports = { closePreview, closeSemester, generateSemesterBook };

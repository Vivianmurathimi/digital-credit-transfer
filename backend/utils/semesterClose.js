const pool = require('../db');
const minioClient = require('../minio');
const inTransaction = require('./transaction');
const notifyStudent = require('./notifyStudent');
const { getSemesterTermData } = require('./getTermData');
const buildTermBookPdf = require('./buildTermBookPdf');
const { ARCHIVE_BUCKET } = require('../config/buckets');
const { rejectInTransaction, notifyEach } = require('../jobs/applicationJobs');

// Closing a semester (admin round Group 6). An admin click, never automatic, and only after the
// semester's last day. In ONE transaction:
//   - its pending and needs-info applications are rejected as System, reason SEMESTER_ENDED
//     ("Not reviewed before the semester closed"), with their history entries
//   - its late access ends
//   - unsent drafts are deleted (a draft belongs to the period that just ended)
//   - the semester becomes closed (closed_at, closed_by)
// After the commit: the rejection emails, then the PDF book. If the PDF fails, the close stands and
// the error is kept on the semester, so the admin can generate it again. Nothing else is deleted.
// A closed semester is read-only for everyone (utils/semesters.js semesterEndedSql).

const OPEN = ['pending', 'needs_info'];

// The moment after the semester's last day (Budapest), compared with `now`
const ENDED_SQL = "(s.end_date + 1)::timestamp AT TIME ZONE 'Europe/Budapest' <= $2";

/**
 * What a close would do right now; saves nothing. The same conditions as closeSemester.
 * @returns {Promise<null | { id, name, status, ended, pending, needsInfo, drafts, lateAccess }>}
 */
const closePreview = async (db, semesterId, { now = new Date(), onlyDraftsOf = null } = {}) => {
    const { rows } = await db.query(
        `SELECT s.id, s.name, s.status, ${ENDED_SQL} AS ended,
                (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id AND a.status = 'pending') AS pending,
                (SELECT count(*)::int FROM applications a WHERE a.semester_id = s.id AND a.status = 'needs_info') AS needs_info,
                (SELECT count(*)::int FROM application_drafts d WHERE $3::int[] IS NULL OR d.student_id = ANY($3)) AS drafts,
                (SELECT count(*)::int FROM late_access l WHERE l.semester_id = s.id AND l.revoked_at IS NULL AND l.deadline > $2) AS late_access
         FROM semesters s WHERE s.id = $1`,
        [semesterId, now, onlyDraftsOf]
    );
    const r = rows[0];
    return r ? { id: r.id, name: r.name, status: r.status, ended: r.ended, pending: r.pending, needsInfo: r.needs_info, drafts: r.drafts, lateAccess: r.late_access } : null;
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
 * `now`, `notify`, `onlyDraftsOf` and `book`: for the tests (a fake clock, a recorded email, the
 * test students' drafts only, no PDF).
 * @returns {Promise<{ error?: [status, code, message], summary?: object }>}
 */
const closeSemester = async ({ semesterId, adminId, confirmName, now = new Date(), notify = notifyStudent, onlyDraftsOf = null, book = true, requireActive = true }) => {
    const result = await inTransaction(async (client) => {
        const s = (await client.query(`SELECT s.id, s.name, s.status, ${ENDED_SQL} AS ended FROM semesters s WHERE s.id = $1 FOR UPDATE`, [semesterId, now])).rows[0];
        if (!s) return { error: [404, 'SEMESTER_NOT_FOUND', 'Semester not found'] };
        if (s.status === 'closed') return { error: [409, 'ALREADY_CLOSED', 'This semester is already closed'] };
        // (requireActive: false only in the tests, which close their own far-future test semester)
        if (s.status !== 'active' && requireActive) return { error: [409, 'SEMESTER_NOT_ACTIVE', 'Only the active semester can be closed'] };
        if (!s.ended) return { error: [409, 'SEMESTER_NOT_ENDED', 'The semester can only be closed after its last day (change its last day first if it is wrong)'] };
        if (typeof confirmName !== 'string' || confirmName.trim() !== s.name) {
            return { error: [400, 'CONFIRM_NAME_MISMATCH', 'Type the semester name exactly to confirm', 'confirm_name'] };
        }

        // The open applications, locked, so the counts are exactly what is rejected below
        const open = (await client.query(
            'SELECT status FROM applications WHERE semester_id = $1 AND status = ANY($2) FOR UPDATE', [s.id, OPEN]
        )).rows;
        const rejected = await rejectInTransaction(client, {
            now, reasonCode: 'SEMESTER_ENDED',
            condition: 'semester_id = $3 AND status = ANY($4)', params: [s.id, OPEN],
        });
        const lateAccess = (await client.query(
            'UPDATE late_access SET revoked_at = $2, revoked_by = $3 WHERE semester_id = $1 AND revoked_at IS NULL AND deadline > $2',
            [s.id, now, adminId]
        )).rowCount;
        // Grants already past their deadline end too (revoked), so nothing of this semester stays open
        await client.query('UPDATE late_access SET revoked_at = $2, revoked_by = $3 WHERE semester_id = $1 AND revoked_at IS NULL', [s.id, now, adminId]);
        const drafts = (await client.query('DELETE FROM application_drafts WHERE $1::int[] IS NULL OR student_id = ANY($1)', [onlyDraftsOf])).rowCount;
        await client.query("UPDATE semesters SET status = 'closed', closed_at = $2, closed_by = $3, close_reason = NULL WHERE id = $1", [s.id, now, adminId]);
        return {
            rejected,
            counts: {
                pending: open.filter((a) => a.status === 'pending').length,
                needsInfo: open.filter((a) => a.status === 'needs_info').length,
                rejected: rejected.length, lateAccess, drafts,
            },
        };
    });
    if (result.error) return result;

    // After the commit: the emails (each on its own), then the PDF book
    const emails = await notifyEach(result.rejected, notify, 'statusUpdate', () => ({ status: 'rejected', reasonCode: 'SEMESTER_ENDED' }));
    const pdf = book ? await generateSemesterBook(semesterId, { generatedBy: adminId }) : { skipped: true };
    return { summary: { ...result.counts, emailsSent: emails, book: pdf } };
};

module.exports = { closePreview, closeSemester, generateSemesterBook };

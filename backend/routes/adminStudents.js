const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { requireIdParam } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const notifyStudent = require('../utils/notifyStudent');
const { addEvent } = require('../utils/applicationEvents');
const { semesterEndedSql } = require('../utils/semesters');
const { OPEN_STATUSES } = require('../utils/reviewers');
const { normalizeDomain, isValidDomain } = require('../utils/domains');

// Students and domains (admin round Group 3), superadmin only.
// - Allowed domains: students may register only with an address from a listed domain.
// - Students: search, and fix a student's programme. A change withdraws the student's open
//   applications (pending, needs info; not in an ended semester) with reason PROGRAMME_CHANGED,
//   recorded as admin, deletes the unsent draft (its courses belong to the old programme), and is
//   recorded in student_programme_changes. Approved and rejected applications stay as they are.

// Every route: superadmin only
const adminOnly = [verifyToken, requireRole('superadmin')];

const PROGRAMME_CHANGED = 'PROGRAMME_CHANGED';
const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 100;
const SEARCH_LIMIT = 50;

// ---------------------------------------------------------------------------------------------
// Allowed domains
// ---------------------------------------------------------------------------------------------

// GET /api/admin/domains: the list (empty = no student can register; the dashboard warns)
router.get('/admin/domains', ...adminOnly, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT d.id, d.domain, d.created_at, u.name AS added_by_name
             FROM allowed_domains d LEFT JOIN users u ON u.id = d.added_by ORDER BY d.domain`
        );
        res.json({ success: true, domains: rows });
    } catch (err) {
        console.error('❌ Domain list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the domains');
    }
});

// POST /api/admin/domains { domain }: e.g. "students.example" or "@students.example"
router.post('/admin/domains', ...adminOnly, async (req, res) => {
    const domain = normalizeDomain(req.body?.domain);
    if (!isValidDomain(domain)) {
        return sendError(res, 400, 'INVALID_DOMAIN', 'Enter a domain such as name.example (letters, digits, hyphens and dots)', { field: 'domain' });
    }
    try {
        const { rows } = await pool.query(
            `INSERT INTO allowed_domains (domain, added_by) VALUES ($1, $2)
             ON CONFLICT (domain) DO NOTHING RETURNING id, domain, created_at`,
            [domain, req.actor.id]
        );
        if (rows.length === 0) return sendError(res, 409, 'DOMAIN_EXISTS', 'This domain is already on the list', { field: 'domain' });
        res.status(201).json({ success: true, domain: rows[0] });
    } catch (err) {
        console.error('❌ Add domain error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not add the domain');
    }
});

// DELETE /api/admin/domains/:id: blocks new sign-ups only; existing accounts keep working
router.delete('/admin/domains/:id', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const { rowCount } = await pool.query('DELETE FROM allowed_domains WHERE id = $1', [req.ids.id]);
        if (rowCount === 0) return sendError(res, 404, 'DOMAIN_NOT_FOUND', 'Domain not found');
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Remove domain error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not remove the domain');
    }
});

// ---------------------------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------------------------

// GET /api/admin/students?q=: by name, email or Neptun code (at least 2 characters), at most 50
router.get('/admin/students', ...adminOnly, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < MIN_SEARCH_LENGTH || q.length > MAX_SEARCH_LENGTH) {
        return sendError(res, 400, 'INVALID_SEARCH', `Search with ${MIN_SEARCH_LENGTH} to ${MAX_SEARCH_LENGTH} characters`, { field: 'q' });
    }
    // LIKE wildcards in the search are taken literally
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    try {
        const { rows } = await pool.query(
            `SELECT u.id, u.name, u.email, u.neptun_code, p.code AS programme_code, p.name_en, p.name_hu, p.name_de,
                    (SELECT count(*)::int FROM applications a
                     WHERE a.student_id = u.id AND a.status = ANY($2) AND NOT ${semesterEndedSql('a')}) AS open_count,
                    EXISTS (SELECT 1 FROM application_drafts dr WHERE dr.student_id = u.id) AS has_draft
             FROM users u LEFT JOIN programmes p ON p.id = u.programme_id
             WHERE u.role = 'student' AND (u.name ILIKE $1 OR u.email ILIKE $1 OR u.neptun_code ILIKE $1)
             ORDER BY u.name, u.id LIMIT ${SEARCH_LIMIT}`,
            [pattern, OPEN_STATUSES]
        );
        res.json({
            success: true,
            students: rows.map(({ programme_code: code, name_en, name_hu, name_de, ...student }) => (
                { ...student, programme: code ? { code, name_en, name_hu, name_de } : null }
            )),
        });
    } catch (err) {
        console.error('❌ Student search error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not search the students');
    }
});

// GET /api/admin/students/:id/programme-changes: that student's changes, newest first
router.get('/admin/students/:id/programme-changes', ...adminOnly, requireIdParam('id'), async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT c.id, c.changed_at, c.withdrawn_count, c.draft_removed, u.name AS changed_by_name,
                    op.code AS old_code, op.name_en AS old_name_en, op.name_hu AS old_name_hu, op.name_de AS old_name_de,
                    np.code AS new_code, np.name_en AS new_name_en, np.name_hu AS new_name_hu, np.name_de AS new_name_de
             FROM student_programme_changes c
             LEFT JOIN users u ON u.id = c.changed_by
             LEFT JOIN programmes op ON op.id = c.old_programme_id
             JOIN programmes np ON np.id = c.new_programme_id
             WHERE c.student_id = $1 ORDER BY c.changed_at DESC, c.id DESC`,
            [req.ids.id]
        );
        res.json({
            success: true,
            changes: rows.map((c) => ({
                id: c.id, changed_at: c.changed_at, withdrawn_count: c.withdrawn_count, draft_removed: c.draft_removed, changed_by_name: c.changed_by_name,
                old_programme: c.old_code ? { code: c.old_code, name_en: c.old_name_en, name_hu: c.old_name_hu, name_de: c.old_name_de } : null,
                new_programme: { code: c.new_code, name_en: c.new_name_en, name_hu: c.new_name_hu, name_de: c.new_name_de },
            })),
        });
    } catch (err) {
        console.error('❌ Programme change list error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not list the programme changes');
    }
});

// "CS101 – Programming" for the email
const courseLabel = (app) => {
    const target = Array.isArray(app.target_courses) ? app.target_courses[0] : null;
    const code = target?.course_code || app.target_course_code || '';
    return target?.course_name ? `${code} – ${target.course_name}` : code || app.pte_course_names || '';
};

// PUT /api/admin/students/:id/programme { programme_code }
router.put('/admin/students/:id/programme', ...adminOnly, requireIdParam('id'), async (req, res) => {
    const programmeCode = req.body?.programme_code;
    if (typeof programmeCode !== 'string' || !programmeCode.trim()) {
        return sendError(res, 400, 'INVALID_PROGRAMME', 'Choose a programme', { field: 'programme_code' });
    }
    try {
        const result = await inTransaction(async (client) => {
            // The student row is locked, so two changes at the same moment run one after the other
            const student = (await client.query('SELECT id, role, programme_id FROM users WHERE id = $1 FOR UPDATE', [req.ids.id])).rows[0];
            if (!student || student.role !== 'student') return { error: [404, 'STUDENT_NOT_FOUND', 'Student not found'] };
            // Every programme counts as active until programmes get a status (admin round Group 4)
            const programme = (await client.query('SELECT id, code, name_en, name_hu, name_de FROM programmes WHERE code = $1', [programmeCode.trim()])).rows[0];
            if (!programme) return { error: [400, 'INVALID_PROGRAMME', 'Unknown study programme', 'programme_code'] };
            if (programme.id === student.programme_id) return { error: [400, 'SAME_PROGRAMME', 'The student is already in this programme', 'programme_code'] };
            const from = student.programme_id
                ? (await client.query('SELECT code, name_en, name_hu, name_de FROM programmes WHERE id = $1', [student.programme_id])).rows[0]
                : null;

            await client.query('UPDATE users SET programme_id = $2 WHERE id = $1', [student.id, programme.id]);

            // Open applications of the old programme (not in an ended semester: those are read-only)
            const withdrawn = (await client.query(
                `UPDATE applications SET status = 'withdrawn', info_requested_at = NULL, info_deadline = NULL, info_reminder_sent_at = NULL
                 WHERE student_id = $1 AND status = ANY($2) AND NOT ${semesterEndedSql()}
                 RETURNING id, target_courses, target_course_code, pte_course_names`,
                [student.id, OPEN_STATUSES]
            )).rows;
            for (const app of withdrawn) {
                await addEvent(client, {
                    applicationId: app.id, kind: 'withdrawn', actorRole: 'admin', actorId: req.actor.id,
                    status: 'withdrawn', reasonCode: PROGRAMME_CHANGED,
                });
            }

            const draftRemoved = (await client.query('DELETE FROM application_drafts WHERE student_id = $1', [student.id])).rowCount > 0;
            await client.query(
                `INSERT INTO student_programme_changes (student_id, old_programme_id, new_programme_id, changed_by, withdrawn_count, draft_removed)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [student.id, student.programme_id, programme.id, req.actor.id, withdrawn.length, draftRemoved]
            );
            return { studentId: student.id, from, to: programme, withdrawn, draftRemoved };
        });
        if (result.error) {
            const [status, code, message, field] = result.error;
            return sendError(res, status, code, message, { field });
        }
        res.json({ success: true, withdrawn: result.withdrawn.length, draftRemoved: result.draftRemoved });

        // One email after saving (never blocks or fails the request)
        notifyStudent(result.studentId, 'programmeChanged', {
            fromProgramme: result.from, toProgramme: result.to,
            withdrawn: result.withdrawn.map(courseLabel), draftRemoved: result.draftRemoved,
        });
    } catch (err) {
        console.error('❌ Programme change error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not change the programme');
    }
});

module.exports = router;

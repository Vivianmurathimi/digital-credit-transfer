const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { positiveInt, requireIdParam } = require('../utils/validate');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const { OPEN_STATUSES, seesProgrammeSql, lockProgramme } = require('../utils/reviewers');
const { semesterEndedSql } = require('../utils/semesters');

// Sharing work between reviewers (round 2 Group 1 Part C), superadmin only, per programme:
//   - turn "allowed to assist" on or off for an extra reviewer (off: their open applications
//     assigned to them become shared again)
//   - assign selected open applications to a reviewer who can see the programme, or unassign them
//   - "Distribute evenly": the unassigned pending applications split across the ticked reviewers
// None of it is required: an application nobody is assigned to is shared, and everyone who can
// see the programme may decide it (the first decision wins, routes/applications.js).
// Applications of a closed semester are read-only and never assigned.

const adminOnly = [verifyToken, requireRole('superadmin')];
const MAX_IDS = 500;

// An open application that can still be (un)assigned (alias a)
const ASSIGNABLE_SQL = `a.status = ANY($OPEN::text[]) AND NOT ${semesterEndedSql('a')}`;
const assignable = (param) => ASSIGNABLE_SQL.replace('$OPEN', param);

const findProgramme = async (db, code) => (await db.query(
    'SELECT id, code, name_en, name_hu, name_de FROM programmes WHERE code = $1', [String(code)]
)).rows[0] || null;

// A list of distinct positive whole numbers, or null
const idList = (value, max = MAX_IDS) => {
    if (!Array.isArray(value) || value.length === 0 || value.length > max) return null;
    const ids = value.map(positiveInt);
    if (ids.some((id) => id === null) || new Set(ids).size !== ids.length) return null;
    return ids;
};

// The people who can see (and so be assigned) the programme's applications now, locked
const reviewersWhoSee = async (client, programmeId, userIds) => (await client.query(
    `SELECT u.id FROM staff_programmes sp JOIN users u ON u.id = sp.user_id AND u.deactivated_at IS NULL
     WHERE sp.programme_id = $1 AND sp.user_id = ANY($2) AND ${seesProgrammeSql('sp')}
     FOR UPDATE OF sp`,
    [programmeId, userIds]
)).rows.map((row) => row.id);

/**
 * GET /api/admin/sharing/:code: the programme's reviewers (current links: role, allowed to
 * assist, whether they see it, how many open applications are assigned to them) and its open
 * applications (pending, needs info; not of a closed semester) with who they are assigned to.
 */
router.get('/admin/sharing/:code', ...adminOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const programme = await findProgramme(pool, req.params.code);
        if (!programme) return sendError(res, 404, 'PROGRAMME_NOT_FOUND', 'Programme not found');
        const reviewers = (await pool.query(
            `SELECT u.id, u.name, sp.role, sp.can_assist, ${seesProgrammeSql('sp')} AS sees,
                    (SELECT count(*)::int FROM applications a
                     WHERE a.programme_id = sp.programme_id AND a.assigned_reviewer_id = u.id AND ${assignable('$2')}) AS assigned_open
             FROM staff_programmes sp JOIN users u ON u.id = sp.user_id AND u.deactivated_at IS NULL
             WHERE sp.programme_id = $1 AND sp.ended_at IS NULL
             ORDER BY (sp.role = 'main') DESC, u.name`,
            [programme.id, OPEN_STATUSES]
        )).rows;
        const applications = (await pool.query(
            `SELECT a.id, a.status, s.name AS student_name, s.neptun_code, a.target_course_code,
                    a.target_courses->0->>'course_name' AS course_name, a.created_at AT TIME ZONE 'UTC' AS submitted_at,
                    sem.name AS semester_name, a.assigned_reviewer_id, assignee.name AS assigned_name
             FROM applications a
             JOIN users s ON s.id = a.student_id
             LEFT JOIN semesters sem ON sem.id = a.semester_id
             LEFT JOIN users assignee ON assignee.id = a.assigned_reviewer_id
             WHERE a.programme_id = $1 AND ${assignable('$2')}
             ORDER BY a.created_at, a.id`,
            [programme.id, OPEN_STATUSES]
        )).rows;
        res.json({ success: true, programme, reviewers, applications });
    } catch (err) {
        console.error('❌ Sharing load error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not load the programme\'s reviewers');
    }
});

/**
 * PUT /api/admin/sharing/:code/assist/:userId { can_assist: boolean }: an extra reviewer of the
 * programme may assist (sees and decides its applications) or is on standby (sees nothing).
 * Turning it off makes their open applications assigned to them in this programme shared again.
 */
router.put('/admin/sharing/:code/assist/:userId', ...adminOnly, requireIdParam('userId'), async (req, res) => {
    const canAssist = req.body?.can_assist;
    if (typeof canAssist !== 'boolean') return sendError(res, 400, 'INVALID_FIELD', 'can_assist must be true or false', { field: 'can_assist' });
    try {
        const result = await inTransaction(async (client) => {
            const programme = await findProgramme(client, req.params.code);
            if (!programme) return { error: [404, 'PROGRAMME_NOT_FOUND', 'Programme not found'] };
            await lockProgramme(client, programme.id);
            const link = (await client.query(
                `SELECT sp.id, sp.role FROM staff_programmes sp JOIN users u ON u.id = sp.user_id AND u.deactivated_at IS NULL
                 WHERE sp.programme_id = $1 AND sp.user_id = $2 AND sp.ended_at IS NULL FOR UPDATE OF sp`,
                [programme.id, req.ids.userId]
            )).rows[0];
            if (!link) return { error: [404, 'LINK_NOT_FOUND', 'This reviewer is not linked to this programme'] };
            if (link.role !== 'extra') return { error: [400, 'ASSIST_ONLY_EXTRA', 'Only an extra reviewer is allowed to assist or put on standby'] };
            await client.query('UPDATE staff_programmes SET can_assist = $2 WHERE id = $1', [link.id, canAssist]);
            const unassigned = canAssist ? 0 : (await client.query(
                'UPDATE applications SET assigned_reviewer_id = NULL WHERE programme_id = $1 AND assigned_reviewer_id = $2 AND status = ANY($3)',
                [programme.id, req.ids.userId, OPEN_STATUSES]
            )).rowCount;
            return { can_assist: canAssist, unassigned };
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2]);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Assist change error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not change assisting');
    }
});

/**
 * POST /api/admin/sharing/:code/assign { application_ids: [..], reviewer_id: id | null }:
 * assigns the open applications to a reviewer who can see the programme now, or (null) makes them
 * shared again. All or nothing: an application of another programme, a decided or withdrawn one,
 * or one of a closed semester refuses the whole request (NOT_ASSIGNABLE, with their ids).
 */
router.post('/admin/sharing/:code/assign', ...adminOnly, async (req, res) => {
    const ids = idList(req.body?.application_ids);
    if (!ids) return sendError(res, 400, 'INVALID_FIELD', `application_ids must be 1 to ${MAX_IDS} different application ids`, { field: 'application_ids' });
    const rawReviewer = req.body?.reviewer_id;
    const reviewerId = rawReviewer === null ? null : positiveInt(rawReviewer);
    if (rawReviewer !== null && reviewerId === null) return sendError(res, 400, 'INVALID_FIELD', 'reviewer_id must be a reviewer id or null', { field: 'reviewer_id' });
    try {
        const result = await inTransaction(async (client) => {
            const programme = await findProgramme(client, req.params.code);
            if (!programme) return { error: [404, 'PROGRAMME_NOT_FOUND', 'Programme not found'] };
            await lockProgramme(client, programme.id);
            if (reviewerId !== null && (await reviewersWhoSee(client, programme.id, [reviewerId])).length === 0) {
                return { error: [409, 'REVIEWER_CANNOT_SEE', 'This reviewer cannot see the programme now (not linked, on standby or deactivated)', 'reviewer_id'] };
            }
            const ok = (await client.query(
                `SELECT a.id FROM applications a WHERE a.id = ANY($1) AND a.programme_id = $2 AND ${assignable('$3')} FOR UPDATE OF a`,
                [ids, programme.id, OPEN_STATUSES]
            )).rows.map((row) => row.id);
            const refused = ids.filter((id) => !ok.includes(id));
            if (refused.length) return { error: [409, 'NOT_ASSIGNABLE', `Not an open application of this programme: ${refused.join(', ')}`, 'application_ids'] };
            const { rowCount } = await client.query('UPDATE applications SET assigned_reviewer_id = $2 WHERE id = ANY($1)', [ids, reviewerId]);
            return { changed: rowCount };
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Assign error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not assign the applications');
    }
});

/**
 * POST /api/admin/sharing/:code/distribute { reviewer_ids: [..] }: splits the programme's
 * UNASSIGNED PENDING applications evenly across the ticked reviewers (each must see the programme
 * now). Oldest application first; each goes to the ticked reviewer with the fewest open
 * applications assigned so far (ties: the order ticked), so the result is even including what
 * they already had. Applications already assigned and needs-info ones are not touched.
 */
router.post('/admin/sharing/:code/distribute', ...adminOnly, async (req, res) => {
    const reviewerIds = idList(req.body?.reviewer_ids, 100);
    if (!reviewerIds) return sendError(res, 400, 'INVALID_FIELD', 'reviewer_ids must be 1 to 100 different reviewer ids', { field: 'reviewer_ids' });
    try {
        const result = await inTransaction(async (client) => {
            const programme = await findProgramme(client, req.params.code);
            if (!programme) return { error: [404, 'PROGRAMME_NOT_FOUND', 'Programme not found'] };
            await lockProgramme(client, programme.id);
            const seeing = await reviewersWhoSee(client, programme.id, reviewerIds);
            const cannot = reviewerIds.filter((id) => !seeing.includes(id));
            if (cannot.length) return { error: [409, 'REVIEWER_CANNOT_SEE', `These reviewers cannot see the programme now: ${cannot.join(', ')}`, 'reviewer_ids'] };

            const load = new Map(reviewerIds.map((id) => [id, 0]));
            for (const row of (await client.query(
                `SELECT a.assigned_reviewer_id AS id, count(*)::int AS n FROM applications a
                 WHERE a.programme_id = $1 AND a.assigned_reviewer_id = ANY($2) AND ${assignable('$3')} GROUP BY 1`,
                [programme.id, reviewerIds, OPEN_STATUSES]
            )).rows) load.set(row.id, row.n);

            const waiting = (await client.query(
                `SELECT a.id FROM applications a
                 WHERE a.programme_id = $1 AND a.assigned_reviewer_id IS NULL AND a.status = 'pending' AND NOT ${semesterEndedSql('a')}
                 ORDER BY a.created_at, a.id FOR UPDATE OF a`,
                [programme.id]
            )).rows.map((row) => row.id);
            const given = new Map(reviewerIds.map((id) => [id, []]));
            for (const applicationId of waiting) {
                // the fewest so far; on a tie the first ticked
                const next = reviewerIds.reduce((best, id) => (load.get(id) < load.get(best) ? id : best), reviewerIds[0]);
                given.get(next).push(applicationId);
                load.set(next, load.get(next) + 1);
            }
            for (const [id, applicationIds] of given) {
                if (applicationIds.length) await client.query('UPDATE applications SET assigned_reviewer_id = $2 WHERE id = ANY($1)', [applicationIds, id]);
            }
            return { distributed: waiting.length, perReviewer: reviewerIds.map((id) => ({ reviewer_id: id, given: given.get(id).length, total: load.get(id) })) };
        });
        if (result.error) return sendError(res, result.error[0], result.error[1], result.error[2], { field: result.error[3] });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('❌ Distribute error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not distribute the applications');
    }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const notifyStudent = require('../utils/notifyStudent');
const { findFilesNotOwnedBy, splitFileList } = require('../utils/fileOwner');
const sendError = require('../utils/sendError');
const inTransaction = require('../utils/transaction');
const { getSubmissionState, refuseUnlessSubmitting } = require('../utils/semesters');
const { actorRoleOf, addEvent, listStudentApplications, getStudentApplication } = require('../utils/applicationEvents');
const { sendValidationErrors } = sendError;
const {
    validateApplicationForm, filesWithPaths, syllabusReasons, syllabusNote, missingSyllabi, BLOCKING_STATUSES, normalizeCourseCode,
    checkNote, normalizeNote,
} = require('../utils/applicationForm');

// The database refused a second active application for the same PTE course (migration 005)
const isDuplicateApplication = (err) => err.code === '23505' && err.constraint === 'applications_one_active_per_course';
const alreadyApplied = (res) => sendError(res, 409, 'ALREADY_APPLIED', 'There is already an active or approved application for this PTE course', { field: 'target_course_ids' });


// The statuses a reviewer or the superadmin may set. "withdrawn" is set only by the student
// (the withdraw route below), and a withdrawn application can't be changed by anyone.
const VALID_STATUSES = ['pending', 'needs_info', 'approved', 'rejected'];

// A student may withdraw an application while it is waiting: under review or waiting for their reply
const WITHDRAWABLE_STATUSES = ['pending', 'needs_info'];

// Submit an application. The student, their programme and the target courses' details all
// come from the database; anything else in the request (student_id, programme_id,
// pte_course_names, system_note) is ignored. Institutions and fulfilled courses are stored only as
// rebuilt from checked fields (utils/applicationForm.js).
router.post('/applications', verifyToken, requireRole('student'), async (req, res) => {
    const { student_note } = req.body;

    const student_id = req.user.id;

    try {
        // 0. Only inside the current semester's application period, with submissions open (Group 3)
        const submission = await getSubmissionState();
        if (refuseUnlessSubmitting(res, submission)) return undefined;

        // 1. Every field rule at once (400 with all problems and their field paths)
        const form = validateApplicationForm(req.body);
        if (form.errors.length > 0) return sendValidationErrors(res, form.errors);
        const targetIds = form.targetCourseIds;

        // 2. Every target course must belong to the student's own programme (read from the database).
        // A course of another programme and an id that doesn't exist get the same answer.
        // The same query gives the snapshot that is saved, so it is exactly what was checked.
        const programmeId = (await pool.query('SELECT programme_id FROM users WHERE id = $1', [student_id])).rows[0]?.programme_id;
        // ... and to the current semester (courses are imported per semester)
        const found = await pool.query(
            'SELECT id, course_code, course_name, credits FROM courses WHERE id = ANY($1) AND programme_id = $2 AND semester_id = $3',
            [targetIds, programmeId, submission.semester.id]
        );
        if (!programmeId || found.rows.length !== targetIds.length) {
            return sendError(res, 400, 'COURSE_NOT_IN_PROGRAMME', 'A chosen course is not part of your programme', { field: 'target_course_ids' });
        }
        // Snapshot in the order the student chose them (kept as is if courses are re-imported later)
        const byId = new Map(found.rows.map((c) => [c.id, c]));
        const targetCourses = targetIds.map((id) => {
            const c = byId.get(id);
            return { course_id: c.id, course_code: c.course_code, course_name: c.course_name, credits: c.credits };
        });
        // Legacy text list, still read by the reviewer and admin screens and the term book.
        // To be dropped after the reviewer and admin rounds (use target_courses instead).
        const pteCourseNames = targetCourses.map((c) => `${c.course_code} (${c.course_name})`).join(' + ');

        // 2b. One active application per PTE course: refused while one for the same course
        //     (code + programme, so it also works after courses are re-imported) is still open or approved.
        //     Deliberately in every semester (Group 3): a course approved in an earlier semester can't be
        //     applied for again; a rejected (or withdrawn) one can. Earlier semesters' pending ones are
        //     closed at their semester end, so in practice only "approved" carries over.
        const targetCode = normalizeCourseCode(targetCourses[0].course_code);
        const existing = await pool.query(
            'SELECT 1 FROM applications WHERE student_id = $1 AND programme_id = $2 AND target_course_code = $3 AND status = ANY($4)',
            [student_id, programmeId, targetCode, BLOCKING_STATUSES]
        );
        if (existing.rows.length > 0) return alreadyApplied(res);

        // 3. Syllabus rule: when it applies, every fulfilled course needs its syllabus.
        //    The reasons are stored as codes (for translation later) and as an English note.
        const targetCredits = targetCourses.reduce((sum, c) => sum + Number(c.credits), 0);
        const reasons = syllabusReasons(form.fulfilledCourses, targetCredits);
        const missing = reasons.length > 0 ? missingSyllabi(form.fulfilledCourses) : [];
        if (missing.length > 0) return sendValidationErrors(res, missing);

        // 4. Transcripts, syllabi and grading files must be the student's own uploads. A file of someone else
        //    and a file that doesn't exist get the identical answer (no way to probe file names).
        const files = filesWithPaths(form.institutions, form.fulfilledCourses);
        const notOwned = new Set(await findFilesNotOwnedBy([...new Set(files.map((f) => f.file))], student_id));
        const fileErrors = files.filter((f) => notOwned.has(f.file)).map(({ field }) => (
            { field, code: 'FILES_NOT_OWNED', message: 'You can only attach files you uploaded yourself' }
        ));
        if (fileErrors.length > 0) return sendValidationErrors(res, fileErrors, 403);

        // The application and the first step of its history are saved together
        const studentNote = normalizeNote(student_note);
        const inserted = await inTransaction(async (client) => {
            const { rows } = await client.query(
                `INSERT INTO applications 
                (student_id, programme_id, institutions, fulfilled_courses_json, target_courses, target_course_code, pte_course_names, system_note, syllabus_reasons, student_note, status, semester_id) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11) RETURNING id`,
                [student_id, programmeId, JSON.stringify(form.institutions), JSON.stringify(form.fulfilledCourses), JSON.stringify(targetCourses), targetCode, pteCourseNames, syllabusNote(reasons), reasons, studentNote, submission.semester.id]
            );
            await addEvent(client, { applicationId: rows[0].id, kind: 'submitted', actorRole: 'student', actorId: student_id, status: 'pending', note: studentNote });
            return rows[0];
        }).catch((err) => {
            // Two submits at the same moment both passed the check above: the database lets only one in
            if (isDuplicateApplication(err)) return null;
            throw err;
        });
        if (inserted === null) return alreadyApplied(res);
        // The draft has become this application. A failure here must not fail the submit:
        // the browser's next autosave of the now empty form deletes it anyway.
        await pool.query('DELETE FROM application_drafts WHERE student_id = $1', [student_id])
            .catch((err) => console.error('Could not delete the draft after submit:', err.message));
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        notifyStudent(student_id, 'submitted');
    } catch (err) {
        console.error('❌ Submission error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Submission failed');
    }
});

// The logged-in student's own applications: the id comes from the token, never from the URL.
// Only the fields a student may see (utils/applicationEvents.js), never SELECT *.
router.get('/applications/mine', verifyToken, requireRole('student'), async (req, res) => {
    try {
        res.json({ success: true, applications: await listStudentApplications(pool, req.user.id) });
    } catch (err) {
        console.error('❌ Fetch my apps error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// One of the student's own applications in full, with its history (the detail view in My Status).
// Another student's application and an id that doesn't exist get the same 404.
router.get('/applications/mine/:id', verifyToken, requireRole('student'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const application = await getStudentApplication(pool, req.user.id, req.params.id);
        if (!application) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        res.json({ success: true, application });
    } catch (err) {
        console.error('❌ Fetch my application error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// One student's applications as that student sees them, for reviewers and the superadmin
// (the impersonation view shows the student's own screen)
router.get('/applications/student/:id', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {
    const requestedId = Number(req.params.id);
    if (!Number.isSafeInteger(requestedId)) return res.json({ success: true, applications: [] });

    try {
        res.json({ success: true, applications: await listStudentApplications(pool, requestedId) });
    } catch (err) {
        console.error('❌ Fetch student apps error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

// One application of that student, as the detail view shows it (impersonation, read-only)
router.get('/applications/student/:id/:applicationId', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {
    const requestedId = Number(req.params.id);
    try {
        const application = Number.isSafeInteger(requestedId)
            ? await getStudentApplication(pool, requestedId, req.params.applicationId)
            : null;
        if (!application) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        res.json({ success: true, application });
    } catch (err) {
        console.error('❌ Fetch student application error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});


router.get('/applications', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {

    try {
        const result = await pool.query(
            `SELECT a.*, u.name as student_name FROM applications a JOIN users u ON a.student_id=u.id ORDER BY a.created_at DESC`
        );
        res.json({ success: true, applications: result.rows });
    } catch (err) {
        console.error('❌ Fetch all apps error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Fetch failed');
    }
});

router.put('/applications/:id/status', verifyToken, requireRole('reviewer', 'superadmin'), async (req, res) => {
    const { status, note } = req.body;

    if (!VALID_STATUSES.includes(status)) {
        return sendError(res, 400, 'INVALID_STATUS', 'This status is not valid');
    }
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
    // No note (the admin's override sends none) keeps the reviewer's note that is already there
    const newNote = typeof note === 'string' ? note : null;

    try {
        // The status change and its history entry are saved together. The row is locked while
        // this runs, so the previous status (used for the email) can't change underneath.
        let updated;
        try {
            updated = await inTransaction(async (client) => {
                const current = await client.query('SELECT status, reviewer_note FROM applications WHERE id=$1 FOR UPDATE', [id]);
                if (current.rows.length === 0) return null;
                const previous = current.rows[0];
                // The student withdrew it: it is closed for good
                if (previous.status === 'withdrawn') return { withdrawn: true };

                // Record who made the decision and when (the logged-in reviewer or superadmin).
                // Reply deadline (Group 9): set when the application is newly sent back for information,
                // kept when it is asked again while already waiting, cleared by any other status.
                // Reopening an old rejected application while the student has a newer active one for the
                // same PTE course would break the one-active-application rule: the database refuses it.
                const { rows } = await client.query(
                    `UPDATE applications SET status=$1, reviewer_note=COALESCE($2, reviewer_note), reviewed_by=$3, reviewed_at=NOW(),
                        info_requested_at     = CASE WHEN $5 THEN COALESCE(info_requested_at, now()) END,
                        info_deadline         = CASE WHEN $5 THEN COALESCE(info_deadline, info_reply_deadline(now())) END,
                        info_reminder_sent_at = CASE WHEN $5 THEN info_reminder_sent_at END
                     WHERE id=$4 RETURNING student_id, reviewer_note, info_deadline`,
                    [status, newNote, req.user.id, id, status === 'needs_info']
                );
                // Saving the same status and note again adds nothing to the history
                if (status !== previous.status || (newNote !== null && newNote !== previous.reviewer_note)) {
                    await addEvent(client, {
                        applicationId: id, kind: status === 'needs_info' ? 'info_requested' : 'decided',
                        actorRole: actorRoleOf(req.user), actorId: req.user.id, status, note: newNote,
                    });
                }
                return { previousStatus: previous.status, ...rows[0] };
            });
        } catch (err) {
            if (isDuplicateApplication(err)) return alreadyApplied(res);
            throw err;
        }
        if (!updated) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        if (updated.withdrawn) return sendError(res, 409, 'APPLICATION_WITHDRAWN', 'The student has withdrawn this application');
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        if (status !== updated.previousStatus) {
            const { student_id, reviewer_note, info_deadline } = updated;
            const type = status === 'needs_info' ? 'needsInfo' : 'statusUpdate';
            notifyStudent(student_id, type, { status, note: reviewer_note, deadline: info_deadline });
        }
    } catch (err) {
       console.error("❌ Status update error:", err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Update failed');
    }
});

// The student withdraws their own application (Group 8). Allowed while it is pending or waiting
// for their reply, also while submissions are closed. The reply deadline is cleared, the step is
// added to the history, and a withdrawn application no longer blocks a new one for the same course.
// Another student's application and an id that doesn't exist get the same 404.
router.put('/applications/:id/withdraw', verifyToken, requireRole('student'), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');

    try {
        // The status is checked in the update itself, so a decision or an automatic rejection
        // made a moment earlier can't be overwritten
        const result = await inTransaction(async (client) => {
            const { rowCount } = await client.query(
                `UPDATE applications SET status = 'withdrawn', info_requested_at = NULL, info_deadline = NULL, info_reminder_sent_at = NULL
                 WHERE id = $1 AND student_id = $2 AND status = ANY($3)`,
                [id, req.user.id, WITHDRAWABLE_STATUSES]
            );
            if (rowCount === 0) {
                const own = await client.query('SELECT 1 FROM applications WHERE id = $1 AND student_id = $2', [id, req.user.id]);
                return own.rows.length === 0 ? 'not_found' : 'not_allowed';
            }
            await addEvent(client, { applicationId: id, kind: 'withdrawn', actorRole: 'student', actorId: req.user.id, status: 'withdrawn' });
            return 'withdrawn';
        });
        if (result === 'not_found') return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        if (result === 'not_allowed') return sendError(res, 409, 'CANNOT_WITHDRAW', 'Only an application under review or waiting for your reply can be withdrawn');
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        notifyStudent(req.user.id, 'withdrawn');
    } catch (err) {
        console.error('❌ Withdraw error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Withdraw failed');
    }
});

// Resubmit adds a note and evidence files only. Target courses and programme can't be changed
// here: any target_course_ids, pte_course_names or programme_id in the request is ignored.
router.put('/applications/:id/resubmit', verifyToken, requireRole('student'), async (req, res) => {
    const id = Number(req.params.id);
    const { student_resubmit_note, new_files } = req.body;

    // The same note rules as the application note (2000 characters, counted the same way)
    const noteProblem = checkNote(student_resubmit_note);
    if (noteProblem) {
        return sendError(res, 400, noteProblem.code, noteProblem.message, {
            field: 'student_resubmit_note',
            errors: [{ field: 'student_resubmit_note', code: noteProblem.code, error: noteProblem.message, ...(noteProblem.params ? { params: noteProblem.params } : {}) }],
        });
    }

    try {
        const ownerCheck = Number.isSafeInteger(id) && id > 0
            ? await pool.query(
                `SELECT a.student_id, a.status, a.supplemental_files, a.info_deadline <= now() AS deadline_passed, b.ends_at <= now() AS semester_ended
                 FROM applications a LEFT JOIN semester_bounds b ON b.id = a.semester_id WHERE a.id = $1`, [id])
            : { rows: [] };
        if (ownerCheck.rows.length === 0) {
            return sendError(res, 404, 'APPLICATION_NOT_FOUND', 'Application not found');
        }
        if (ownerCheck.rows[0].student_id !== req.user.id) {
            return sendError(res, 403, 'NOT_OWNER', 'You can only resubmit your own applications');
        }
        // Only an application the reviewer sent back for more information can be resubmitted
        if (ownerCheck.rows[0].status !== 'needs_info') {
            return sendError(res, 409, 'NOT_WAITING_FOR_INFO', 'This application is not waiting for more information');
        }

        // After the semester end (Group 3) or the deadline the reply is refused; the background job
        // rejects the application
        if (ownerCheck.rows[0].semester_ended) {
            return sendError(res, 409, 'SEMESTER_ENDED', 'The semester has ended, so the application can no longer be changed');
        }
        if (ownerCheck.rows[0].deadline_passed) {
            return sendError(res, 409, 'INFO_DEADLINE_PASSED', 'The deadline for replying has passed');
        }
        // A reply is allowed while new submissions are closed: it answers an existing application,
        // and its deadline keeps running either way

        // Only the student's own uploads may be added as evidence
        const newFiles = splitFileList(new_files);
        if ((await findFilesNotOwnedBy(newFiles, req.user.id)).length > 0) {
            return sendError(res, 403, 'FILES_NOT_OWNED', 'You can only attach files you uploaded yourself');
        }

        // Append to the existing list without empty entries (no stray commas)
        const updatedFiles = [...splitFileList(ownerCheck.rows[0].supplemental_files), ...newFiles].join(',');

        // Back to review, the deadline cleared, and the reply added to the history, all together.
        // The status is checked again in the update itself, so a reply can never overwrite an
        // application that was rejected (e.g. at its deadline) a moment ago.
        const replyNote = normalizeNote(student_resubmit_note);
        const saved = await inTransaction(async (client) => {
            const { rowCount } = await client.query(
                `UPDATE applications SET status = 'pending', student_resubmit_note = $1, supplemental_files = $2,
                    info_requested_at = NULL, info_deadline = NULL, info_reminder_sent_at = NULL
                 WHERE id = $3 AND student_id = $4 AND status = 'needs_info' AND (info_deadline IS NULL OR info_deadline > now())
                   AND NOT EXISTS (SELECT 1 FROM semester_bounds b WHERE b.id = applications.semester_id AND b.ends_at <= now())`,
                [replyNote, updatedFiles, id, req.user.id]
            );
            if (rowCount === 0) return false;
            await addEvent(client, { applicationId: id, kind: 'replied', actorRole: 'student', actorId: req.user.id, status: 'pending', note: replyNote, files: newFiles });
            return true;
        });
        if (!saved) return sendError(res, 409, 'NOT_WAITING_FOR_INFO', 'This application is not waiting for more information');
        res.json({ success: true });

        // Respond first, then email in the background (never blocks or fails the request)
        notifyStudent(req.user.id, 'resubmitted');
    } catch (err) {
        console.error('❌ Resubmit error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Resubmit failed');
    }
});

module.exports = router;
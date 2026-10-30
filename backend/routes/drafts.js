const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const sendError = require('../utils/sendError');
const { sendValidationErrors } = sendError;
const { getFileOwner } = require('../utils/fileOwner');
const { checkDraft, draftFileNames, keepOnlyFiles } = require('../utils/drafts');

// The logged-in student's draft of the application form (Group 7). Like /applications/mine,
// there is no id in the address: the student comes from the token, so nobody can reach
// another student's draft.

// Read the draft back. Files that no longer exist or aren't the student's own are removed
// (and counted, so the form can say so); original file names come from the files themselves.
router.get('/mine', verifyToken, requireRole('student'), async (req, res) => {
    // Shared lab computers: the browser must not keep a copy
    res.set('Cache-Control', 'no-store');
    try {
        const result = await pool.query('SELECT version, data, updated_at FROM application_drafts WHERE student_id = $1', [req.user.id]);
        if (result.rows.length === 0) return res.json({ success: true, draft: null });

        const { version, data, updated_at } = result.rows[0];
        const own = new Set();
        const fileNames = {};
        for (const fileName of draftFileNames(data)) {
            const { exists, ownerId, originalName } = await getFileOwner(fileName);
            if (exists && ownerId === req.user.id) {
                own.add(fileName);
                if (originalName) fileNames[fileName] = originalName;
            }
        }
        const { data: cleaned, dropped } = keepOnlyFiles(data, own);
        res.json({ success: true, draft: { version, data: cleaned, updated_at, dropped_files: dropped, file_names: fileNames } });
    } catch (err) {
        console.error('Read draft error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not read the draft');
    }
});

// Save the draft: replaces the previous one ("last save wins", also across tabs)
router.put('/mine', verifyToken, requireRole('student'), async (req, res) => {
    const { version, data } = req.body || {};
    const problem = checkDraft(version, data);
    if (problem) {
        const { status, ...error } = problem;
        return sendValidationErrors(res, [error], status);
    }
    try {
        const result = await pool.query(
            `INSERT INTO application_drafts (student_id, version, data, updated_at) VALUES ($1, $2, $3, now())
             ON CONFLICT (student_id) DO UPDATE SET version = EXCLUDED.version, data = EXCLUDED.data, updated_at = now()
             RETURNING updated_at`,
            [req.user.id, version, JSON.stringify(data)]
        );
        res.json({ success: true, updated_at: result.rows[0].updated_at });
    } catch (err) {
        // Text PostgreSQL can't store in JSON (a NUL character): a bad draft, not a server fault
        if (err.code === '22P05') return sendError(res, 400, 'INVALID_DRAFT', 'The draft contains characters that cannot be saved', { field: 'data' });
        console.error('Save draft error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not save the draft');
    }
});

// Throw the draft away (e.g. it was made with an older form)
router.delete('/mine', verifyToken, requireRole('student'), async (req, res) => {
    try {
        await pool.query('DELETE FROM application_drafts WHERE student_id = $1', [req.user.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Delete draft error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not delete the draft');
    }
});

module.exports = router;

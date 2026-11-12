const express = require('express');
const router = express.Router();
const pool = require('../db');
const verifyToken = require('../middleware/verifyToken');
const requireRole = require('../middleware/requireRole');
const { positiveInt } = require('../utils/validate');
const sendError = require('../utils/sendError');
const { normalizeLanguage, statusLabels } = require('../utils/emailTemplates');
const { semesterAnalytics, STATUSES } = require('../utils/analytics');
const { sendCsv } = require('../utils/csv');

// Analytics (admin round Group 7), superadmin only: how a semester went, calculated on the server
// (utils/analytics.js). The active semester by default; closed ones selectable; never a semester
// still in setup (it has no applications yet).

const adminOnly = [verifyToken, requireRole('superadmin')];
const TABLES = ['status', 'programmes', 'turnaround', 'courses'];

// The semester to show: ?semester_id=, or the newest one in progress (several can be, round 2
// Group 1). [error] or [null, semester]
const pickSemester = async (value) => {
    if (value === undefined || value === '') {
        const active = (await pool.query("SELECT id, name, status FROM semesters WHERE status = 'active' ORDER BY applications_open_at DESC LIMIT 1")).rows[0];
        return active ? [null, active] : [[404, 'NO_ACTIVE_SEMESTER', 'There is no active semester: choose a closed one']];
    }
    const id = positiveInt(value);
    if (id === null) return [[400, 'INVALID_ID', 'semester_id must be a positive whole number', 'semester_id']];
    const semester = (await pool.query('SELECT id, name, status FROM semesters WHERE id = $1', [id])).rows[0];
    if (!semester) return [[404, 'SEMESTER_NOT_FOUND', 'Semester not found', 'semester_id']];
    if (semester.status === 'setup') return [[400, 'SEMESTER_IN_SETUP', 'A semester in setup has no analytics yet', 'semester_id']];
    return [null, semester];
};

// GET /api/admin/analytics?semester_id=: the semesters to choose from, and the chosen one's numbers
router.get('/admin/analytics', ...adminOnly, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const [problem, semester] = await pickSemester(req.query.semester_id);
        const semesters = (await pool.query(
            "SELECT id, name, status FROM semesters WHERE status IN ('active', 'closed') ORDER BY (status = 'active') DESC, applications_open_at DESC"
        )).rows;
        if (problem) {
            if (problem[1] === 'NO_ACTIVE_SEMESTER') return res.json({ success: true, semesters, semester: null, analytics: null });
            return sendError(res, problem[0], problem[1], problem[2], { field: problem[3] });
        }
        res.json({ success: true, semesters, semester, analytics: await semesterAnalytics(pool, semester.id) });
    } catch (err) {
        console.error('❌ Analytics error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not calculate the analytics');
    }
});

const HEADERS = {
    status: { en: ['Status', 'Applications'], hu: ['Állapot', 'Kérelmek'], de: ['Status', 'Anträge'] },
    programmes: {
        en: ['Programme', 'Pending', 'Needs info', 'Approved', 'Rejected', 'Withdrawn', 'Total'],
        hu: ['Szak', 'Bírálatra vár', 'Kiegészítés szükséges', 'Elfogadva', 'Elutasítva', 'Visszavonva', 'Összesen'],
        de: ['Studiengang', 'In Prüfung', 'Informationen benötigt', 'Genehmigt', 'Abgelehnt', 'Zurückgezogen', 'Gesamt'],
    },
    turnaround: {
        en: ['Programme', 'Decided', 'Average days to decision', 'Median days to decision', 'Average days, excluding waiting for the student', 'Median days, excluding waiting for the student'],
        hu: ['Szak', 'Elbírálva', 'Átlagos napok a döntésig', 'Napok mediánja a döntésig', 'Átlagos napok, a hallgatóra várás nélkül', 'Napok mediánja, a hallgatóra várás nélkül'],
        de: ['Studiengang', 'Entschieden', 'Tage bis zur Entscheidung (Mittelwert)', 'Tage bis zur Entscheidung (Median)', 'Tage ohne Warten auf Studierende (Mittelwert)', 'Tage ohne Warten auf Studierende (Median)'],
    },
    courses: { en: ['Programme', 'Course code', 'Course', 'Applications'], hu: ['Szak', 'Tárgykód', 'Kurzus', 'Kérelmek'], de: ['Studiengang', 'Kurscode', 'Kurs', 'Anträge'] },
};
const ALL = { en: 'All programmes', hu: 'Minden szak', de: 'Alle Studiengänge' };
const programmeText = (programme, lang) => (programme ? `${programme.code} – ${programme[`name_${lang}`] || programme.name_en}` : ALL[lang]);

// GET /api/admin/analytics/export.csv?semester_id=&table=status|programmes|turnaround|courses&lang=
router.get('/admin/analytics/export.csv', ...adminOnly, async (req, res) => {
    const table = req.query.table;
    if (!TABLES.includes(table)) return sendError(res, 400, 'INVALID_TABLE', `table must be one of ${TABLES.join(', ')}`, { field: 'table' });
    const lang = normalizeLanguage(req.query.lang);
    try {
        const [problem, semester] = await pickSemester(req.query.semester_id);
        if (problem) return sendError(res, problem[0], problem[1], problem[2], { field: problem[3] });
        const a = await semesterAnalytics(pool, semester.id);
        let rows;
        if (table === 'status') rows = STATUSES.map((s) => [statusLabels[lang][s], a.status.overall[s]]).concat([[HEADERS.programmes[lang][6], a.status.overall.total]]);
        if (table === 'programmes') rows = a.status.byProgramme.map((r) => [programmeText(r.programme, lang), ...STATUSES.map((s) => r[s]), r.total]);
        if (table === 'turnaround') {
            rows = [...a.turnaround.byProgramme, a.turnaround.overall].map((r) => [
                programmeText(r.programme, lang), r.decided, r.averageDays, r.medianDays, r.averageDaysWithoutWaiting, r.medianDaysWithoutWaiting,
            ]);
        }
        if (table === 'courses') rows = a.topCourses.map((c) => [programmeText(c.programme, lang), c.courseCode, c.courseName, c.applications]);
        sendCsv(res, `analytics-${table}-${semester.name}.csv`, [HEADERS[table][lang], ...rows]);
    } catch (err) {
        console.error('❌ Analytics export error:', err.message);
        sendError(res, 500, 'SERVER_ERROR', 'Could not export the analytics');
    }
});

module.exports = router;

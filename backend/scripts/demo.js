/**
 * The defence demo: its own database and its own MinIO buckets, separate from the development data.
 *
 *   npm run demo:seed     (re)creates the demo database "credit_demo" and the buckets
 *                         "demo-transcripts" / "demo-archives", then fills them with demo data
 *   npm run demo:start    starts the backend on the demo database and buckets (same port as usual)
 *
 * Nothing in backend/.env changes: these two commands set DB_NAME, MINIO_BUCKET and
 * MINIO_ARCHIVE_BUCKET for themselves only. The development database (DB_NAME in .env) is used
 * only to create and drop the demo database. Refused when NODE_ENV=production.
 *
 * demo:seed starts from scratch every time: the demo database is dropped and created again (stop
 * demo:start first) and the demo buckets are emptied. Sends no emails.
 *
 * The demo data (every account's password: Demo1234!):
 *   - two programmes (Computer Science Engineering, Civil Engineering), each with a main reviewer and an
 *     extra reviewer: assisting in CS (sees CS), on standby in Civil (sees nothing)
 *   - a previous semester (ended) and the current one, with the PTE courses of both programmes
 *   - 7 students and applications in every state: pending (also waiting 9 and 16 days), resubmitted (pending after the student's
 *     reply), needs info with the deadline tomorrow, approved with a grade, rejected by the reviewer,
 *     rejected by the admin, rejected by the system (no reply by the deadline, and not reviewed
 *     before the semester closed), withdrawn
 *   - small PDF files for every transcript, grading system document, syllabus and reply
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const DEMO_ENV = { DB_NAME: 'credit_demo', MINIO_BUCKET: 'demo-transcripts', MINIO_ARCHIVE_BUCKET: 'demo-archives' };
const DEMO_PASSWORD = 'Demo1234!';

const command = process.argv[2];
const devDatabase = process.env.DB_NAME;

const stop = (message) => {
    console.error(message);
    process.exit(1);
};

if (process.env.NODE_ENV === 'production') stop('Refusing to run: NODE_ENV=production. The demo is for the defence on a development machine only.');
if (!['seed', 'start'].includes(command)) stop('Use "npm run demo:seed" or "npm run demo:start".');
if (devDatabase === DEMO_ENV.DB_NAME) stop(`DB_NAME in backend/.env is "${devDatabase}": set it back to the development database.`);

// From here on everything (db.js, minio buckets, the server) uses the demo settings
Object.assign(process.env, DEMO_ENV);

if (command === 'start') {
    console.log(`🎓 DEMO backend: database "${DEMO_ENV.DB_NAME}", buckets "${DEMO_ENV.MINIO_BUCKET}" and "${DEMO_ENV.MINIO_ARCHIVE_BUCKET}"`);
    require('../server');
    return;
}

// ---------- demo:seed ----------

const crypto = require('crypto');
const { Client } = require('pg');
const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const minioClient = require('../minio');
const { EVIDENCE_BUCKET, ARCHIVE_BUCKET } = require('../config/buckets');
const { encodeForMetadata } = require('../utils/fileRules');
const { syllabusReasons, syllabusNote, normalizeCourseCode } = require('../utils/applicationForm');

const DAY = 24 * 60 * 60 * 1000;
const budapestTime = (date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Budapest', dateStyle: 'medium', timeStyle: 'short' }).format(date);
const NOW = new Date();
const daysAgo = (days, hours = 0) => new Date(NOW.getTime() - days * DAY - hours * 60 * 60 * 1000);

// 1. A fresh, empty demo database (connected through the development database)
const recreateDatabase = async () => {
    const admin = new Client({
        user: process.env.DB_USER, host: process.env.DB_HOST, port: process.env.DB_PORT, password: process.env.DB_PASSWORD, database: devDatabase,
    });
    await admin.connect();
    try {
        await admin.query(`DROP DATABASE IF EXISTS ${DEMO_ENV.DB_NAME} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${DEMO_ENV.DB_NAME}`);
    } finally {
        await admin.end();
    }
};

// 2. Empty demo buckets
const emptyBucket = async (bucket) => {
    if (!(await minioClient.bucketExists(bucket))) {
        await minioClient.makeBucket(bucket, 'us-east-1');
        return 0;
    }
    const names = await new Promise((resolve, reject) => {
        const found = [];
        const stream = minioClient.listObjects(bucket, '', true);
        stream.on('data', (obj) => found.push(obj.name));
        stream.on('end', () => resolve(found));
        stream.on('error', reject);
    });
    if (names.length) await minioClient.removeObjects(bucket, names);
    return names.length;
};

// A small PDF standing in for an uploaded document
const makePdf = (title, lines) => new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(9).fillColor('#a00').text('DEMO DATA – not a real document');
    doc.moveDown().fontSize(18).fillColor('#000').text(title);
    doc.moveDown().fontSize(12);
    lines.forEach((line) => doc.text(line));
    doc.end();
});

// Stored exactly like the upload route does: generated name, uploader id, original name
const uploadFile = async (student, originalName, title, lines) => {
    const pdf = await makePdf(title, lines);
    const fileName = `${crypto.randomUUID()}.pdf`;
    await minioClient.putObject(EVIDENCE_BUCKET, fileName, pdf, pdf.length, {
        'Content-Type': 'application/pdf',
        'X-Amz-Meta-Uploader-Id': String(student.id),
        'X-Amz-Meta-Uploader-Role': 'student',
        'X-Amz-Meta-Original-Name': encodeForMetadata(originalName),
    });
    return fileName;
};

// The courses come from backend/fixtures/demo-neptun.csv (admin round Group 4), imported like the admin's Neptun import

const STAFF = [
    { key: 'admin', role: 'superadmin', name: 'Demo Admin', email: 'demo.admin@staff.example', language: 'en' },
    // Each programme's main reviewer, and one extra reviewer each (round 2 Group 1): the CS one is
    // allowed to assist (sees CS), the Civil one is on standby (sees nothing until the admin turns assisting on)
    { key: 'reviewerCS', role: 'reviewer', name: 'Dr. Katalin Szabó', email: 'demo.reviewer.cs@staff.example', programme: 'CS', staffRole: 'main', language: 'en' },
    { key: 'reviewerCIVIL', role: 'reviewer', name: 'Dr. Péter Horváth', email: 'demo.reviewer.civil@staff.example', programme: 'CIVIL', staffRole: 'main', language: 'hu' },
    { key: 'extraCS', role: 'reviewer', name: 'Dr. Gergely Balogh', email: 'demo.extra.cs@staff.example', programme: 'CS', staffRole: 'extra', canAssist: true, language: 'en' },
    { key: 'extraCIVIL', role: 'reviewer', name: 'Dr. Réka Fehér', email: 'demo.extra.civil@staff.example', programme: 'CIVIL', staffRole: 'extra', canAssist: false, language: 'en' },
    // The committee (round 2 Group 2): one member on both programmes' committees, one on CS only
    { key: 'committeeBoth', role: 'committee', name: 'Prof. Judit Lakatos', email: 'demo.committee@staff.example', committee: ['CS', 'CIVIL'], language: 'en' },
    { key: 'committeeCS', role: 'committee', name: 'Prof. András Takács', email: 'demo.committee.cs@staff.example', committee: ['CS'], language: 'hu' },
];
const STUDENTS = [
    { key: 'anna', name: 'Anna Kovács', email: 'demo.anna@students.example', programme: 'CS', neptun: 'DMCS01', language: 'en' },
    { key: 'bence', name: 'Bence Tóth', email: 'demo.bence@students.example', programme: 'CS', neptun: 'DMCS02', language: 'hu' },
    { key: 'csilla', name: 'Csilla Varga', email: 'demo.csilla@students.example', programme: 'CS', neptun: 'DMCS03', language: 'de' },
    { key: 'daniel', name: 'Dániel Kiss', email: 'demo.daniel@students.example', programme: 'CS', neptun: 'DMCS04', language: 'en' },
    { key: 'eszter', name: 'Eszter Nagy', email: 'demo.eszter@students.example', programme: 'CIVIL', neptun: 'DMCV01', language: 'en' },
    { key: 'ferenc', name: 'Ferenc Molnár', email: 'demo.ferenc@students.example', programme: 'CIVIL', neptun: 'DMCV02', language: 'hu' },
    { key: 'gabor', name: 'Gábor Farkas', email: 'demo.gabor@students.example', programme: 'CIVIL', neptun: 'DMCV03', language: 'en' },
];

const seed = async (pool) => {
    const { runPendingMigrations } = require('../utils/migrations');
    const { createSemester } = require('../utils/semesters');
    const { importFixture } = require('../utils/neptun/fixture');

    const applied = await runPendingMigrations();
    console.log(`Migrations applied: ${applied.length}`);

    const programmes = Object.fromEntries((await pool.query('SELECT id, code FROM programmes')).rows.map((p) => [p.code, p.id]));
    await pool.query("INSERT INTO universities (name, country) VALUES ('University of Pécs (PTE)', 'Hungary')");

    // Semesters (Budapest days): the previous one ended 60 days ago; the current one takes
    // applications from 30 days ago to 30 days from now and ends in 90 days
    const day = (await pool.query(
        `SELECT (d - 180)::text AS p_from, (d - 150)::text AS p_until, (d - 60)::text AS p_ends,
                (d - 30)::text AS c_from, (d + 30)::text AS c_until, (d + 90)::text AS c_ends
         FROM (SELECT (now() AT TIME ZONE 'Europe/Budapest')::date AS d) t`
    )).rows[0];
    const semesters = {
        previous: (await createSemester(pool, { name: 'Demo – previous semester', applyFrom: day.p_from, applyUntil: day.p_until, ends: day.p_ends, status: 'closed' })).id,
        current: (await createSemester(pool, { name: 'Demo – current semester', applyFrom: day.c_from, applyUntil: day.c_until, ends: day.c_ends, status: 'active' })).id,
    };
    // Both semesters' catalogue from the fixture file (the same import as the admin screen)
    const courses = {};
    for (const [semester, semesterId] of Object.entries(semesters)) {
        await importFixture(pool, semesterId);
        const { rows } = await pool.query('SELECT id, course_code, course_name, credits FROM courses WHERE semester_id = $1', [semesterId]);
        for (const c of rows) courses[`${semester}:${c.course_code}`] = { course_id: c.id, course_code: c.course_code, course_name: c.course_name, credits: c.credits };
    }

    // Students register from the reserved example domain (never on a real list: demo:seed refuses
    // to run with NODE_ENV=production). Staff are invited, so staff.example is not on the list.
    await pool.query("INSERT INTO allowed_domains (domain) VALUES ('students.example') ON CONFLICT (domain) DO NOTHING");

    // Accounts
    const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const users = {};
    for (const account of [...STAFF, ...STUDENTS.map((s) => ({ ...s, role: 'student' }))]) {
        // users.programme_id is for students only; staff are linked in staff_programmes
        const isStudent = account.role === 'student';
        const { rows } = await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id, preferred_language)
             VALUES ($1, $2, $3, $4, true, $5, $6, $7) RETURNING id`,
            [account.name, account.email, hash, account.role, account.neptun || null, isStudent ? programmes[account.programme] : null, account.language]
        );
        if (account.staffRole) {
            await pool.query(
                'INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, $3, $4)',
                [rows[0].id, programmes[account.programme], account.staffRole, account.canAssist === true]
            );
        }
        for (const code of account.committee || []) {
            await pool.query("INSERT INTO staff_programmes (user_id, programme_id, role) VALUES ($1, $2, 'committee')", [rows[0].id, programmes[code]]);
        }
        users[account.key] = { id: rows[0].id, name: account.name, programme: account.programme };
    }
    const reviewerOf = (programme) => users[`reviewer${programme}`];

    const utc = (date) => date.toISOString(); // stored "AT TIME ZONE 'UTC'" where the column has no time zone

    /**
     * One application with its files and its history, written the way the routes write them.
     * spec: student, semester, target (course code), institution, previous (the completed course),
     *       submittedAt, note, events (after the submit), final (the application's last state)
     */
    const application = async (spec) => {
        const student = users[spec.student];
        const target = courses[`${spec.semester}:${spec.target}`];
        const { institution, previous } = spec;
        const gradingFile = await uploadFile(student, `grading_scale_${institution.short}.pdf`, `Grading system – ${institution.name}`,
            [`Country: ${institution.country}`, 'Grades and their meaning (demo).']);
        const transcript = await uploadFile(student, `transcript_${institution.short}.pdf`, `Transcript of records – ${institution.name}`,
            [`Student: ${student.name}`, `${previous.course_code} ${previous.course_name}: ${previous.credits} ${previous.credit_system}, grade ${previous.grade}`]);
        const row = { ...previous, file: transcript, syllabus_file: null, institution: 0, credit_system_other: null };
        const reasons = syllabusReasons([row], target.credits);
        if (reasons.length) {
            row.syllabus_file = await uploadFile(student, `syllabus_${previous.course_code}.pdf`, `Syllabus – ${previous.course_name}`,
                ['Topics, hours and learning outcomes (demo).']);
        }

        const final = spec.final;
        const replyFiles = [];
        for (const event of spec.events) {
            if (event.replyFile) {
                event.files = [await uploadFile(student, event.replyFile, 'Additional document', [event.note])];
                replyFiles.push(...event.files);
            }
        }
        const { rows } = await pool.query(
            `INSERT INTO applications
                (student_id, programme_id, institutions, fulfilled_courses_json, target_courses, target_course_code, pte_course_names,
                 system_note, syllabus_reasons, student_note, status, semester_id, assigned_reviewer_id, created_at,
                 reviewer_note, student_resubmit_note, supplemental_files, reviewed_by, reviewed_at,
                 info_requested_at, info_deadline, final_grade, decided_by, decided_by_role, decided_at, decision_rationale,
                 reviewer_decision, reviewer_grade, committee_state, committee_by, committee_by_role, committee_at, committee_note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz AT TIME ZONE 'UTC',
                     $15, $16, $17, $18, $19::timestamptz AT TIME ZONE 'UTC',
                     $20, info_reply_deadline($20), $21, $22, $23, $24, $25,
                     $26, $27, COALESCE($28, CASE WHEN ($11)::varchar IN ('approved', 'rejected') THEN 'before_committee' END),
                     $29, CASE WHEN $29::int IS NOT NULL THEN 'committee' END, $30, $31)
             RETURNING id`,
            [
                student.id, programmes[student.programme],
                JSON.stringify([{ name: institution.name, country: institution.countryCode, grading_file: gradingFile }]),
                JSON.stringify([row]), JSON.stringify([target]), normalizeCourseCode(target.course_code), `${target.course_code} (${target.course_name})`,
                syllabusNote(reasons), reasons, spec.note || null, final.status, semesters[spec.semester],
                // open applications are shared (round 2 Group 1); decided ones name the programme's reviewer
                ['pending', 'needs_info'].includes(final.status) ? null : reviewerOf(student.programme).id, utc(spec.submittedAt),
                final.reviewerNote ?? null, final.replyNote ?? null, replyFiles.length ? replyFiles.join(',') : null,
                final.reviewedBy ?? null, final.reviewedAt ? utc(final.reviewedAt) : null,
                final.infoRequestedAt ?? null, final.grade ?? null, final.decidedBy ?? null, final.decidedByRole ?? null, final.decidedAt ?? null, final.rationale ?? null,
                // The committee (round 2 Group 2): the reviewer's own decision, and the committee's step
                final.reviewerDecision ?? null, final.reviewerGrade ?? null, final.committeeState ?? null,
                final.committeeBy ?? null, final.committeeAt ?? null, final.committeeNote ?? null,
            ]
        );
        const id = rows[0].id;
        const history = [{ kind: 'submitted', actor: student, role: 'student', status: 'pending', note: spec.note || null, at: spec.submittedAt }, ...spec.events];
        for (const e of history) {
            await pool.query(
                `INSERT INTO application_events (application_id, kind, actor_role, actor_id, status, note, reason_code, files, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [id, e.kind, e.role, e.role === 'system' ? null : e.actor.id, e.status, e.note ?? null, e.reasonCode ?? null, e.files || [], e.at]
            );
        }
        return id;
    };

    const deadlineOf = async (requestedAt) => (await pool.query('SELECT info_reply_deadline($1::timestamptz) AS d', [requestedAt])).rows[0].d;
    const semesterEnd = (await pool.query('SELECT ends_at FROM semester_bounds WHERE id = $1', [semesters.previous])).rows[0].ends_at;

    const INSTITUTIONS = {
        wien: { name: 'Technische Universität Wien', short: 'TU_Wien', country: 'Austria', countryCode: 'AT' },
        milano: { name: 'Politecnico di Milano', short: 'PoliMi', country: 'Italy', countryCode: 'IT' },
        stuttgart: { name: 'Universität Stuttgart', short: 'Uni_Stuttgart', country: 'Germany', countryCode: 'DE' },
        bme: { name: 'Budapest University of Technology and Economics', short: 'BME', country: 'Hungary', countryCode: 'HU' },
        prague: { name: 'Czech Technical University in Prague', short: 'CTU', country: 'Czechia', countryCode: 'CZ' },
        bratislava: { name: 'Slovak University of Technology in Bratislava', short: 'STU', country: 'Slovakia', countryCode: 'SK' },
        zagreb: { name: 'University of Zagreb', short: 'UniZg', country: 'Croatia', countryCode: 'HR' },
    };
    const course = (course_name, course_code, credits, grade) => ({ course_name, course_code, credits, grade, credit_system: 'ECTS' });
    const rv = (programme) => ({ actor: reviewerOf(programme), role: 'reviewer' });
    const made = [];
    const add = async (label, spec) => made.push([label, users[spec.student].name, await application(spec)]);

    // --- Computer Science Engineering ---
    await add('pending', {
        student: 'anna', semester: 'current', target: 'CS202', institution: INSTITUTIONS.wien,
        previous: course('Algorithms and Data Structures', '186.866', 6, '1 (Sehr gut)'),
        submittedAt: daysAgo(2), note: 'I completed this course during my Erasmus semester in Vienna.', events: [], final: { status: 'pending' },
    });

    const bRequested = daysAgo(5);
    await add('resubmitted (pending after the reply)', {
        student: 'bence', semester: 'current', target: 'CS305', institution: INSTITUTIONS.milano,
        previous: course('Databases 2', '088921', 4, '28/30'),
        submittedAt: daysAgo(8), note: 'Databases course from my exchange year in Milan.',
        events: [
            { ...rv('CS'), kind: 'info_requested', status: 'needs_info', at: bRequested, note: 'Please upload the official course description that lists the SQL and normalisation topics.' },
            { actor: users.bence, role: 'student', kind: 'replied', status: 'pending', at: daysAgo(1), note: 'I attached the official course description from the university website.', replyFile: 'course_description_Databases2.pdf' },
        ],
        final: { status: 'pending', replyNote: 'I attached the official course description from the university website.', reviewedBy: reviewerOf('CS').id, reviewedAt: bRequested },
    });

    const cRequested = daysAgo(2);
    const cDeadline = await deadlineOf(cRequested);
    const cMessage = 'Please send the syllabus with the number of contact hours; the transcript does not show them.';
    await add(`needs info, reply by ${budapestTime(cDeadline)} (tomorrow)`, {
        student: 'csilla', semester: 'current', target: 'CS310', institution: INSTITUTIONS.stuttgart,
        previous: course('Webtechnologien', 'WT-410', 5, '1,7'),
        submittedAt: daysAgo(6), note: 'Web technologies course from Stuttgart.',
        events: [{ ...rv('CS'), kind: 'info_requested', status: 'needs_info', at: cRequested, note: cMessage }],
        final: { status: 'needs_info', reviewerNote: cMessage, reviewedBy: reviewerOf('CS').id, reviewedAt: cRequested, infoRequestedAt: cRequested },
    });

    const dDecided = daysAgo(0, 1); // an hour ago: in the committee's next daily summary
    await add('awaiting the committee (the reviewer approved, grade 4)', {
        student: 'daniel', semester: 'current', target: 'MATH205', institution: INSTITUTIONS.bme,
        previous: course('Linear Algebra', 'BMETE90AX00', 5, '4'),
        submittedAt: daysAgo(10), note: '',
        events: [{ ...rv('CS'), kind: 'decided', status: 'approved', at: dDecided, note: 'Content and credits match the PTE course.' }],
        final: { status: 'awaiting_committee', reviewerNote: 'Content and credits match the PTE course.', reviewedBy: reviewerOf('CS').id, reviewedAt: dDecided,
            decidedBy: reviewerOf('CS').id, decidedByRole: 'reviewer', decidedAt: dDecided, rationale: 'Content and credits match the PTE course.',
            reviewerDecision: 'approved', reviewerGrade: 4, committeeState: 'awaiting' },
    });

    // Changed by the committee: the reviewer approved, the CS committee member rejects (round 2 Group 2)
    const hDecided = daysAgo(6);
    const hCommittee = daysAgo(2);
    const hNote = 'The completed course has no architecture or design-patterns part, which is half of CS401.';
    await add('changed by the committee: approved -> rejected', {
        student: 'anna', semester: 'current', target: 'CS401', institution: INSTITUTIONS.wien,
        previous: course('Software Engineering 1', '194.020', 6, '2 (Gut)'),
        submittedAt: daysAgo(14), note: '',
        events: [
            { ...rv('CS'), kind: 'decided', status: 'approved', at: hDecided, note: 'Credits and topics are close enough.' },
            { actor: users.committeeCS, role: 'committee', kind: 'committee_changed', status: 'rejected', at: hCommittee, note: hNote },
        ],
        final: { status: 'rejected', reviewerNote: 'Credits and topics are close enough.', reviewedBy: reviewerOf('CS').id, reviewedAt: hDecided,
            decidedBy: reviewerOf('CS').id, decidedByRole: 'reviewer', decidedAt: hDecided, rationale: 'Credits and topics are close enough.',
            reviewerDecision: 'approved', reviewerGrade: 3, committeeState: 'changed', committeeBy: users.committeeCS.id, committeeAt: hCommittee, committeeNote: hNote },
    });

    const aRequested = daysAgo(7);
    const aDeadline = await deadlineOf(aRequested);
    await add('rejected by the system (no reply by the deadline)', {
        student: 'anna', semester: 'current', target: 'SEC300', institution: INSTITUTIONS.wien,
        previous: course('Network Security', '389.159', 3, '2 (Gut)'),
        submittedAt: daysAgo(9), note: '',
        events: [
            { ...rv('CS'), kind: 'info_requested', status: 'needs_info', at: aRequested, note: 'Please add the lab assignments to show the practical part.' },
            { role: 'system', kind: 'auto_rejected', status: 'rejected', at: aDeadline, reasonCode: 'NO_INFO_RESPONSE' },
        ],
        final: { status: 'rejected', reviewedAt: aDeadline, decidedByRole: 'system', decidedAt: aDeadline },
    });

    // --- Civil Engineering ---
    const eDecided = daysAgo(4);
    const eReason = 'The completed course covers only statically determinate structures; CE210 also requires indeterminate structures and matrix methods.';
    const eCommittee = daysAgo(1);
    const eNote = 'The Prague course also covered indeterminate structures in its second half (see the syllabus): approved.';
    await add('changed by the committee: rejected -> approved, grade 3', {
        student: 'eszter', semester: 'current', target: 'CE210', institution: INSTITUTIONS.prague,
        previous: course('Structural Mechanics 1', '132SM01', 6, 'B'),
        submittedAt: daysAgo(12), note: 'Structural mechanics from my semester in Prague.',
        events: [
            { ...rv('CIVIL'), kind: 'decided', status: 'rejected', at: eDecided, note: eReason },
            { actor: users.committeeBoth, role: 'committee', kind: 'committee_changed', status: 'approved', at: eCommittee, note: eNote },
        ],
        final: { status: 'approved', grade: 3, reviewerNote: eReason, reviewedBy: reviewerOf('CIVIL').id, reviewedAt: eDecided,
            decidedBy: reviewerOf('CIVIL').id, decidedByRole: 'reviewer', decidedAt: eDecided, rationale: eReason,
            reviewerDecision: 'rejected', committeeState: 'changed', committeeBy: users.committeeBoth.id, committeeAt: eCommittee, committeeNote: eNote },
    });

    const fDecided = daysAgo(2, 3);
    const fReason = 'The transcript is not an official document. Please apply again with the certified transcript.';
    const fCommittee = daysAgo(1, 5);
    const fNote = 'The committee agrees: a certified transcript is needed.';
    await add('rejected by the admin, kept by the committee', {
        student: 'ferenc', semester: 'current', target: 'CE230', institution: INSTITUTIONS.bratislava,
        previous: course('Soil Mechanics', 'B-GEO2', 5, 'B'),
        submittedAt: daysAgo(11), note: '',
        events: [
            { actor: users.admin, role: 'admin', kind: 'decided', status: 'rejected', at: fDecided, note: fReason },
            { actor: users.committeeBoth, role: 'committee', kind: 'committee_kept', status: 'rejected', at: fCommittee, note: fNote },
        ],
        final: { status: 'rejected', reviewerNote: fReason, reviewedBy: users.admin.id, reviewedAt: fDecided,
            decidedBy: users.admin.id, decidedByRole: 'admin', decidedAt: fDecided, rationale: fReason,
            reviewerDecision: 'rejected', committeeState: 'kept', committeeBy: users.committeeBoth.id, committeeAt: fCommittee, committeeNote: fNote },
    });

    await add('pending', {
        student: 'gabor', semester: 'current', target: 'CE310', institution: INSTITUTIONS.zagreb,
        previous: course('Fluid Mechanics', 'FM-201', 6, 'vrlo dobar (4)'),
        submittedAt: daysAgo(1), note: 'Fluid mechanics, completed in Zagreb.', events: [], final: { status: 'pending' },
    });

    // Waiting long (reviewer group L2 colour cues): amber from 7 days, red from 14
    await add('pending, waiting 9 days', {
        student: 'daniel', semester: 'current', target: 'CS401', institution: INSTITUTIONS.bme,
        previous: course('Software Engineering', 'BMEVIIIAB07', 5, '5'),
        submittedAt: daysAgo(9), note: '', events: [], final: { status: 'pending' },
    });
    await add('pending, waiting 16 days', {
        student: 'ferenc', semester: 'current', target: 'CE320', institution: INSTITUTIONS.bratislava,
        previous: course('Building Materials', 'B-MAT1', 5, 'A'),
        submittedAt: daysAgo(16), note: '', events: [], final: { status: 'pending' },
    });

    await add('withdrawn', {
        student: 'gabor', semester: 'current', target: 'CE320', institution: INSTITUTIONS.zagreb,
        previous: course('Building Materials', 'BM-110', 5, 'dobar (3)'),
        submittedAt: daysAgo(5), note: '',
        events: [{ actor: users.gabor, role: 'student', kind: 'withdrawn', status: 'withdrawn', at: daysAgo(3) }],
        final: { status: 'withdrawn' },
    });

    // A decided application of the previous semester for the CS reviewer's read-only view (reviewer group L3)
    const bPastDecided = await (async () => (await pool.query("SELECT (ends_at - interval '30 days') AS d FROM semester_bounds WHERE id = $1", [semesters.previous])).rows[0].d)();
    await add('approved, grade 5, previous semester', {
        student: 'bence', semester: 'previous', target: 'CS101', institution: INSTITUTIONS.milano,
        previous: course('Fondamenti di Informatica', '085877', 6, '30/30'),
        submittedAt: daysAgo(170), note: '',
        events: [{ ...rv('CS'), kind: 'decided', status: 'approved', at: bPastDecided, note: 'Equivalent content, full credits.' }],
        final: { status: 'approved', grade: 5, reviewerNote: 'Equivalent content, full credits.', reviewedBy: reviewerOf('CS').id, reviewedAt: bPastDecided,
            decidedBy: reviewerOf('CS').id, decidedByRole: 'reviewer', decidedAt: bPastDecided, rationale: 'Equivalent content, full credits.' },
    });

    await add('rejected by the system (not reviewed before the semester closed), previous semester', {
        student: 'eszter', semester: 'previous', target: 'CE101', institution: INSTITUTIONS.prague,
        previous: course('Engineering Mechanics – Statics', '132EM01', 5, 'A'),
        submittedAt: daysAgo(160), note: '',
        events: [{ role: 'system', kind: 'auto_rejected', status: 'rejected', at: semesterEnd, reasonCode: 'SEMESTER_ENDED' }],
        final: { status: 'rejected', reviewedAt: semesterEnd, decidedByRole: 'system', decidedAt: semesterEnd },
    });

    // Moments for trying the automatic actions with npm run jobs:run -- --now=... (08:00 UTC on those days)
    const moments = (await pool.query(
        `SELECT to_char(($1::timestamptz AT TIME ZONE 'Europe/Budapest')::date + 1, 'YYYY-MM-DD') AS after_deadline,
                to_char((review_ends_at AT TIME ZONE 'Europe/Budapest')::date - 6, 'YYYY-MM-DD') AS week_before,
                to_char((review_ends_at AT TIME ZONE 'Europe/Budapest')::date, 'YYYY-MM-DD') AS day_before,
                to_char((review_ends_at AT TIME ZONE 'Europe/Budapest')::date + 1, 'YYYY-MM-DD') AS after_review,
                to_char((now() AT TIME ZONE 'Europe/Budapest')::date + 1, 'YYYY-MM-DD') AS next_morning,
                to_char((committee_ends_at AT TIME ZONE 'Europe/Budapest')::date - 6, 'YYYY-MM-DD') AS committee_week_before,
                to_char((committee_ends_at AT TIME ZONE 'Europe/Budapest')::date + 1, 'YYYY-MM-DD') AS after_committee
         FROM semester_bounds WHERE id = $2`,
        [cDeadline, semesters.current]
    )).rows[0];
    return { users, made, semesters: day, moments };
};

const main = async () => {
    console.log(`Demo: database "${DEMO_ENV.DB_NAME}", buckets "${EVIDENCE_BUCKET}" and "${ARCHIVE_BUCKET}" (development data is not touched)`);
    await recreateDatabase();
    const removed = (await emptyBucket(EVIDENCE_BUCKET)) + (await emptyBucket(ARCHIVE_BUCKET));
    console.log(`Demo database created; ${removed} old demo file(s) removed.`);

    const pool = require('../db'); // after the database exists
    try {
        const { users, made, semesters, moments } = await seed(pool);
        console.log(`\nSemesters: previous ${semesters.p_from} to ${semesters.p_ends} (closed), current: applications ${semesters.c_from} to ${semesters.c_until}, review deadline ${moments.day_before} (14 days later).`);
        console.log('\nApplications:');
        made.forEach(([label, student, id]) => console.log(`  ${`#${id}`.padEnd(4)} ${student.padEnd(14)} ${label}`));
        console.log(`\nLogins (password for all: ${DEMO_PASSWORD}):`);
        const what = (a) => (a.staffRole ? `${a.staffRole === 'main' ? 'main reviewer' : `extra reviewer, ${a.canAssist ? 'assisting' : 'standby'}`} (${a.programme})`
            : a.committee ? `committee member (${a.committee.join(', ')})`
                : `${a.role || 'student'}${a.programme ? ` (${a.programme})` : ''}`);
        [...STAFF, ...STUDENTS].forEach((a) => console.log(`  ${a.email.padEnd(36)} ${what(a).padEnd(34)} ${users[a.key].name}`));
        console.log('\nStart the demo backend with: npm run demo:start');
        // A fake "now" changes the demo database for good (npm run demo:seed starts it over)
        const run = (day) => `DB_NAME=${DEMO_ENV.DB_NAME} npm run jobs:run -- --now=${day}T08:00:00Z --yes`;
        console.log('\nTrying the automatic actions on the demo database (demo:start may keep running):');
        console.log(`  Csilla's deadline has passed:      ${run(moments.after_deadline)}`);
        console.log(`  7 days before the review deadline: ${run(moments.week_before)}`);
        console.log(`  1 day before the review deadline:  ${run(moments.day_before)}`);
        console.log(`  the review deadline has passed:    ${run(moments.after_review)}  (nothing rejected; the admins are emailed once)`);
        console.log(`  the committee's daily summary:     ${run(moments.next_morning)}  (07:00 Budapest has passed: the members' summary)`);
        console.log(`  7 days before the committee deadline: ${run(moments.committee_week_before)}`);
        console.log(`  the committee deadline has passed: ${run(moments.after_committee)}  (nothing decided; the admins are emailed once)`);
        console.log('  closing the semester: the admin does it (Semester section), once everything is decided; not the job');
    } finally {
        await pool.end();
    }
};

main().catch((err) => {
    console.error(`Demo seed failed: ${err.message}`);
    process.exit(1);
});

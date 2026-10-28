/**
 * Fills the development database with test data (never in production):
 *   - PTE target courses for Computer Science Engineering and Civil Engineering
 *   - verified test accounts (one student and one reviewer per programme, one superadmin)
 *   - for each test student: one small evidence PDF and one pending application
 *
 *   npm run seed:dev
 *
 * Run after "npm run migrate". Safe to run again: existing courses and accounts are kept.
 * Sends no emails. The courses are temporary: later the admin imports them from Neptun.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run: NODE_ENV=production. seed:dev creates test accounts and is for development only.');
    process.exit(1);
}

const bcrypt = require('bcryptjs');
const PDFDocument = require('pdfkit');
const pool = require('../db');
const minioClient = require('../minio');
const { listPendingMigrations } = require('../utils/migrations');

// One password for every test account (development only)
const DEV_PASSWORD = 'Test1234!';
const EVIDENCE_BUCKET = 'transcripts';

const COURSES = {
    CS: [
        ['CS101', 'Introduction to Computer Science', 5],
        ['CS202', 'Data Structures and Algorithms', 6],
        ['CS305', 'Database Management Systems', 5],
        ['CS310', 'Web Engineering and Modern UI', 4],
        ['CS401', 'Software Engineering Architecture', 5],
        ['CS415', 'Artificial Intelligence', 4],
        ['CS450', 'Machine Learning & Data Mining', 6],
        ['MATH205', 'Linear Algebra for CS', 4],
        ['MATH310', 'Discrete Mathematics', 3],
        ['MGMT201', 'IT Project Management', 4],
        ['SEC300', 'Cybersecurity Fundamentals', 5],
        ['NET201', 'Computer Networks', 4],
    ],
    CIVIL: [
        ['CE101', 'Engineering Mechanics', 5],
        ['CE210', 'Structural Analysis', 6],
        ['CE230', 'Geotechnical Engineering', 5],
        ['CE310', 'Hydraulics and Water Resources', 4],
        ['CE320', 'Construction Materials', 4],
    ],
};

// role, name, email, programme code, Neptun code, sample application (students only)
const ACCOUNTS = [
    { role: 'student', name: 'Test Student CS', email: 'student.cs@tr.pte.hu', programme: 'CS', neptun: 'CSTST1',
        application: { target: 'CS202', previous: { course_name: 'Algorithms and Data Structures', course_code: 'INF-210', credits: 6, grade: '4' } } },
    { role: 'student', name: 'Test Student Civil', email: 'student.civil@tr.pte.hu', programme: 'CIVIL', neptun: 'CVTST1',
        application: { target: 'CE101', previous: { course_name: 'Statics and Mechanics', course_code: 'ME-110', credits: 5, grade: '5' } } },
    { role: 'reviewer', name: 'Test Reviewer CS', email: 'reviewer.cs@mik.pte.hu', programme: 'CS' },
    { role: 'reviewer', name: 'Test Reviewer Civil', email: 'reviewer.civil@mik.pte.hu', programme: 'CIVIL' },
    { role: 'superadmin', name: 'Test Admin', email: 'admin@adminisztracio.pte.hu' },
];

// A one-page PDF standing in for a transcript
const makeEvidencePdf = (studentName, courseName) => new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.fontSize(18).text('Test evidence (development data)');
    doc.moveDown().fontSize(12).text(`Student: ${studentName}`);
    doc.text(`Previous course: ${courseName}`);
    doc.end();
});

// Stored exactly like the upload route does, so ownership checks treat it as the student's own file
const uploadEvidence = async (student, courseName) => {
    const pdf = await makeEvidencePdf(student.name, courseName);
    const fileName = `${Date.now()}-seed-evidence-${student.id}.pdf`;
    await minioClient.putObject(EVIDENCE_BUCKET, fileName, pdf, pdf.length, {
        'Content-Type': 'application/pdf',
        'X-Amz-Meta-Uploader-Id': String(student.id),
        'X-Amz-Meta-Uploader-Role': 'student',
    });
    return fileName;
};

const seed = async () => {
    const pending = await listPendingMigrations();
    if (pending.length > 0) {
        throw new Error(`pending migrations (${pending.join(', ')}). Run "npm run migrate" first.`);
    }
    if (!(await minioClient.bucketExists(EVIDENCE_BUCKET))) await minioClient.makeBucket(EVIDENCE_BUCKET, 'us-east-1');

    const programmeIds = Object.fromEntries(
        (await pool.query('SELECT id, code FROM programmes')).rows.map((p) => [p.code, p.id])
    );

    const pte = await pool.query(
        "INSERT INTO universities (name, country) VALUES ('University of Pécs (PTE)', 'Hungary') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id"
    );
    const pteId = pte.rows[0].id;

    let newCourses = 0;
    for (const [programme, courses] of Object.entries(COURSES)) {
        for (const [code, name, credits] of courses) {
            const result = await pool.query(
                'INSERT INTO courses (university_id, programme_id, course_code, course_name, credits) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
                [pteId, programmeIds[programme], code, name, credits]
            );
            newCourses += result.rowCount;
        }
    }

    const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
    const created = [];
    for (const account of ACCOUNTS) {
        const result = await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified, neptun_code, programme_id, preferred_language)
             VALUES ($1, $2, $3, $4, true, $5, $6, 'en')
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [account.name, account.email, passwordHash, account.role, account.neptun || null, programmeIds[account.programme] || null]
        );
        if (result.rows.length === 0) continue; // already there
        created.push(account.email);

        // A pending application with one evidence file, only for a newly created student
        if (account.application) {
            const student = { id: result.rows[0].id, name: account.name };
            const { previous, target } = account.application;
            const file = await uploadEvidence(student, previous.course_name);
            const course = (await pool.query(
                'SELECT id, course_code, course_name, credits FROM courses WHERE programme_id = $1 AND course_code = $2',
                [programmeIds[account.programme], target]
            )).rows[0];
            const targetCourses = [{ course_id: course.id, course_code: course.course_code, course_name: course.course_name, credits: course.credits }];
            await pool.query(
                `INSERT INTO applications
                    (student_id, programme_id, fulfilled_courses_json, target_courses, pte_course_names, system_note, student_note, status)
                 VALUES ($1, $2, $3, $4, $5, '', $6, 'pending')`,
                [
                    student.id,
                    programmeIds[account.programme],
                    JSON.stringify([{ id: 1, ...previous, file }]),
                    JSON.stringify(targetCourses),
                    `${course.course_code} (${course.course_name})`,
                    'Test application created by seed:dev.',
                ]
            );
        }
    }

    console.log(`Courses added: ${newCourses}. Accounts created: ${created.length}${created.length ? ` (${created.join(', ')})` : ''}.`);
    console.log(`Password for every test account: ${DEV_PASSWORD}`);
};

seed()
    .then(() => process.exit(0)) // db.js keeps its startup test connection open
    .catch((err) => {
        console.error(`Seed failed: ${err.message}`);
        process.exit(1);
    });

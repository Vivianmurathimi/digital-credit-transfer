/**
 * Checks that the application form's rules in the browser and on the server agree.
 *
 *   cd frontend
 *   npm run check:form-rules
 *
 * The browser rules (src/applicationForm.js) only exist for convenience; the server rules
 * (backend/utils/applicationForm.js) are the real check. Both are written separately, so this
 * script runs the same inputs through both and requires identical field paths, codes and limits.
 * No server, database or network is needed.
 */
import { createRequire } from 'module';
import * as browser from '../src/applicationForm.js';
import * as browserFiles from '../src/fileRules.js';

const require = createRequire(new URL('../../backend/utils/', import.meta.url));
const server = require('./applicationForm.js');
const { isCountryCode } = require('./countries.js');
const serverFiles = require('./fileRules.js');

let failed = 0;
const report = (ok, name, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const inst = (o = {}) => ({ name: 'TU Berlin', country: 'DE', grading_file: 'g.pdf', ...o });
const row = (o = {}) => ({ institution: 0, course_name: 'Statics', course_code: '', credits: 5, credit_system: 'ECTS', grade: 'A', file: 'e.pdf', ...o });
const form = ({ institutions = [inst()], rows = [row()], targets = [1] } = {}) => ({ institutions, fulfilled_courses: rows, target_course_ids: targets });

const cases = {
    'valid application': form(),
    'everything empty': form({ institutions: [inst({ name: '', country: '', grading_file: null })], rows: [row({ institution: null, course_name: '', credits: null, credit_system: '', grade: '', file: null })], targets: [] }),
    'credits as text, 0, negative, 2.3': form({ rows: [row({ credits: '5' }), row({ credits: 0 }), row({ credits: -1 }), row({ credits: 2.3 })] }),
    'credits over the limit per system': form({ rows: [row({ credits: 60.5 }), row({ credits: 30.5, credit_system: 'US_CREDIT_HOURS' }), row({ credits: 120.5, credit_system: 'UK_CATS' }), row({ credits: 120.5, credit_system: 'OTHER', credit_system_other: 'Points' })] }),
    'credits exactly at the limits, and 2.5': form({ rows: [row({ credits: 60 }), row({ credits: 30, credit_system: 'US_CREDIT_HOURS' }), row({ credits: 120, credit_system: 'UK_CATS' }), row({ credits: 2.5 })] }),
    'no or unknown credit system': form({ rows: [row({ credit_system: '' }), row({ credit_system: 'POINTS' })] }),
    '"Other" without a name, and with a 51-character name': form({ rows: [row({ credit_system: 'OTHER' }), row({ credit_system: 'OTHER', credit_system_other: 'x'.repeat(51) })] }),
    '"Other" name sent with ECTS': form({ rows: [row({ credit_system_other: 'Ignored' })] }),
    'country missing, XX, and lower case "de"': form({ institutions: [inst({ country: '' }), inst({ name: 'B', country: 'XX' }), inst({ name: 'C', country: 'de' })], rows: [row(), row({ institution: 1 }), row({ institution: 2 })] }),
    'same institution twice (case and spaces)': form({ institutions: [inst(), inst({ name: '  tu   BERLIN ' })], rows: [row(), row({ institution: 1 })] }),
    'same name, different country': form({ institutions: [inst(), inst({ country: 'AT' })], rows: [row(), row({ institution: 1 })] }),
    'institution no course uses': form({ institutions: [inst(), inst({ name: 'ELTE', country: 'HU' })] }),
    'row pointing to a missing institution': form({ rows: [row({ institution: 4 })] }),
    'texts too long (name 201, code 51, grade 21)': form({ institutions: [inst({ name: 'n'.repeat(201) })], rows: [row({ course_name: 'c'.repeat(201), course_code: 'k'.repeat(51), grade: 'g'.repeat(21) })] }),
    'missing grade, evidence and grading file': form({ institutions: [inst({ grading_file: '' })], rows: [row({ grade: '  ', file: '' })] }),
    '11 institutions': form({ institutions: Array.from({ length: 11 }, (_, i) => inst({ name: `U${i}` })) }),
    '21 course rows': form({ rows: Array(21).fill(row()) }),
    'target course as text': form({ targets: ['1'] }),
    'two target courses (one per application)': form({ targets: [1, 2] }),
    'the same target course twice (counts as one)': form({ targets: [1, 1] }),
    'several mistakes at once': form({ institutions: [inst({ country: '' }), inst({ name: '', grading_file: '' })], rows: [row({ credits: 0 }), row({ institution: 1, grade: '', file: '' })] }),
};

console.log('Browser rules vs. server rules, same inputs\n');
const fmt = (errors) => errors.map((e) => `${e.field} ${e.code}${e.params ? JSON.stringify(e.params) : ''}`).join(' | ');
for (const [name, body] of Object.entries(cases)) {
    const inBrowser = fmt(browser.validateSubmission(body, isCountryCode));
    const onServer = fmt(server.validateApplicationForm(body).errors);
    const count = onServer ? onServer.split(' | ').length : 0;
    report(inBrowser === onServer, name, inBrowser === onServer
        ? (count ? `${count} error${count > 1 ? 's' : ''}, identical` : 'valid in both')
        : `\n      browser: ${inBrowser || 'valid'}\n      server:  ${onServer || 'valid'}`);
}

console.log('\nSyllabus rule: browser vs. server\n');
const rows = (...list) => list.map(([credits, credit_system]) => ({ credits, credit_system }));
const syllabusCases = {
    'one ECTS course, enough credits': [rows([6, 'ECTS']), 6],
    'one ECTS course, more credits': [rows([7.5, 'ECTS']), 6],
    'one ECTS course, fewer credits': [rows([5.5, 'ECTS']), 6],
    'one US course': [rows([3, 'US_CREDIT_HOURS']), 6],
    'one "Other" course': [rows([10, 'OTHER']), 6],
    'two ECTS courses, enough together': [rows([3, 'ECTS'], [3, 'ECTS']), 6],
    'two ECTS courses, too few together': [rows([2, 'ECTS'], [3, 'ECTS']), 6],
    'ECTS + UK credits combined': [rows([4, 'ECTS'], [15, 'UK_CATS']), 6],
};
for (const [name, [list, target]] of Object.entries(syllabusCases)) {
    const inBrowser = browser.syllabusReasons(list, target).join(', ');
    const onServer = server.syllabusReasons(list, target).join(', ');
    report(inBrowser === onServer, name, inBrowser === onServer ? (onServer || 'no syllabus needed') : `browser: ${inBrowser} | server: ${onServer}`);
}
const missingB = JSON.stringify(browser.missingSyllabi([{ syllabus_file: 'a' }, { syllabus_file: null }]));
const missingS = JSON.stringify(server.missingSyllabi([{ syllabus_file: 'a' }, { syllabus_file: null }]).map(({ field, code }) => ({ field, code })));
report(missingB === missingS, 'Missing syllabi reported at the same paths', missingS);

console.log('\nFile rules: browser vs. server\n');
const pdfBytes = Buffer.from('%PDF-1.4\n%test');
const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const fileCases = [
    ['a PDF', pdfBytes, 'syllabus.pdf'], ['a JPG', jpgBytes, 'photo.jpg'], ['a JPEG named .jpeg', jpgBytes, 'photo.jpeg'], ['a PNG', pngBytes, 'scan.PNG'],
    ['text renamed to .pdf', Buffer.from('hello world'), 'fake.pdf'], ['a PNG named .pdf', pngBytes, 'scan.pdf'],
    ['a PDF named .png', pdfBytes, 'doc.png'], ['a Word file', Buffer.from('PK\x03\x04xxxx'), 'letter.docx'], ['a PDF without extension', pdfBytes, 'syllabus'],
];
for (const [name, bytes, fileName] of fileCases) {
    const inBrowser = (await browserFiles.checkFile(new File([bytes], fileName), 50)) === null;
    const onServer = serverFiles.detectFileType(bytes, fileName) !== null;
    report(inBrowser === onServer, name, inBrowser === onServer ? (onServer ? 'allowed in both' : 'refused in both') : `browser ${inBrowser}, server ${onServer}`);
}
const big = await browserFiles.checkFile(new File([pdfBytes, new Uint8Array(11 * 1024 * 1024)], 'big.pdf'), browserFiles.MAX_MB.unchanged);
report(big?.code === 'FILE_TOO_LARGE' && big.params.max === 10, 'An 11 MB file is too large for an unchanged upload', JSON.stringify(big));
report(browserFiles.MAX_MB.highlighted === serverFiles.MAX_BYTES.highlighted / serverFiles.MB && browserFiles.MAX_MB.unchanged === serverFiles.MAX_BYTES.unchanged / serverFiles.MB,
    'Same size limits (highlighted 15 MB, unchanged 10 MB)');
const header = serverFiles.contentDisposition('tantárgyleírás "v2".pdf');
report(browserFiles.fileNameFromDisposition(header) === 'tantárgyleírás "v2".pdf', "The browser reads the server's download name, accents and quotes included", header);

console.log('\nOne application per PTE course: browser vs. server\n');
report(JSON.stringify(browser.BLOCKING_STATUSES) === JSON.stringify(server.BLOCKING_STATUSES), 'Same blocking statuses', server.BLOCKING_STATUSES.join(', '));
const codes = ['CS202', 'cs202', ' cs 202 ', 'CS\t202', 'MATH-205', 'math 205'];
report(codes.every((c) => browser.normalizeCourseCode(c) === server.normalizeCourseCode(c)), 'Course codes normalised the same way', codes.map((c) => `${JSON.stringify(c)}→${server.normalizeCourseCode(c)}`).join(' '));
const blocked = browser.blockedCourseCodes([
    { status: 'rejected', target_course_code: 'CS101' }, { status: 'pending', target_course_code: 'CS202' },
    { status: 'approved', target_course_code: 'CS305' }, { status: 'withdrawn', target_course_code: 'CS310' },
    { status: 'needs_info', target_courses: [{ course_code: 'cs 401' }] },
]);
report(JSON.stringify(blocked) === JSON.stringify({ CS202: 'pending', CS305: 'approved', CS401: 'needs_info' }),
    'Picker blocks pending, needs-info and approved courses; rejected and withdrawn stay available', JSON.stringify(blocked));

console.log('\nLimits and stored data\n');
report(JSON.stringify(browser.LIMITS) === JSON.stringify(server.LIMITS), 'Same limits', JSON.stringify(server.LIMITS));
report(JSON.stringify(browser.CREDIT_MAX) === JSON.stringify(server.CREDIT_MAX), 'Same credit maximum per system', JSON.stringify(server.CREDIT_MAX));
const otherIgnored = server.validateApplicationForm(cases['"Other" name sent with ECTS']).fulfilledCourses[0];
report(otherIgnored.credit_system_other === null, 'An "Other" name sent with ECTS is not stored', `stored: ${JSON.stringify(otherIgnored.credit_system_other)}`);
const sent = browser.buildSubmission([{ key: 'k1', name: 'TU Wien', country: 'AT', grading_file: 'g' }], [{ id: 'r1', institutionKey: 'k1', course_name: 'X', course_code: '', credits: '5', credit_system: 'ECTS', credit_system_other: 'leftover', grade: 'A', file: 'e' }]);
report(!('credit_system_other' in sent.fulfilled_courses[0]) && sent.fulfilled_courses[0].credits === 5, 'The form sends credits as numbers and no leftover "Other" name', JSON.stringify(sent.fulfilled_courses[0]));

console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) FAILED`}`);
process.exitCode = failed === 0 ? 0 : 1;

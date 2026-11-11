/**
 * Checks the admin menu (admin round Group 5, B4):   npm run check:admin-menu
 *
 * - every admin screen of Groups 1-5 is in exactly one menu section (src/components/admin/sections.js)
 * - every screen named there exists and the layout renders it
 * - each section has its own URL, /admin is Overview, unknown URLs go nowhere special
 * - a badge shows only when its condition is true
 * No server, database or browser is needed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECTIONS, sectionForPath, pathOf, badgeFor } from '../src/components/admin/sections.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
let failed = 0;
const report = (ok, name, detail = '') => {
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// Every admin screen built in Groups 1-5 (component, or component:role when one serves two roles)
const ADMIN_SCREENS = [
    'ReviewerOverview', 'AdminOverview', 'Semesters', 'PeriodControls', 'LateAccess', 'CatalogueImport', 'Catalogue',
    'ApplicationsSection', 'PastSemesters', 'TermArchive', 'Analytics', 'StaffAccess:reviewer', 'StaffAccess:superadmin', 'ActAs:reviewer', 'ActAs:student',
    'StudentProgrammes', 'AllowedDomains',
];

const listed = SECTIONS.flatMap((s) => s.components.map((c) => [c, s.id]));
for (const screen of ADMIN_SCREENS) {
    const where = listed.filter(([c]) => c === screen).map(([, id]) => id);
    report(where.length === 1, `"${screen}" is in exactly one section`, where.join(', ') || 'none');
}
for (const [c, id] of listed) report(ADMIN_SCREENS.includes(c), `Section "${id}" lists only known screens`, c);

// Every screen exists (a file, or a component inside one) and the layout or its section wrapper uses it
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const sources = files(join(SRC, 'components')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8'));
const layout = ['admin/AdminLayout.js', 'admin/AdminOverview.js', 'admin/SemesterCatalogue.js', 'admin/Semesters.js', 'admin/ApplicationsSection.js', 'admin/PastSemesters.js']
    .map((f) => readFileSync(join(SRC, 'components', f), 'utf8')).join('\n');
for (const screen of ADMIN_SCREENS) {
    const [name, role] = screen.split(':');
    report(sources.some((s) => new RegExp(`const ${name} = `).test(s)), `"${name}" exists`);
    const used = role ? new RegExp(`<${name} role="${role}"`).test(layout) : new RegExp(`<${name}[\\s/>]`).test(layout);
    report(used, `The admin layout renders "${screen}"`);
}

// URLs
const paths = SECTIONS.map(pathOf);
report(new Set(paths).size === SECTIONS.length, 'Every section has its own URL', paths.join(' '));
report(sectionForPath('/admin')?.id === 'overview' && sectionForPath('/admin/')?.id === 'overview', '/admin opens Overview');
report(SECTIONS.every((s) => sectionForPath(pathOf(s))?.id === s.id), 'Each URL opens its own section (also after a refresh)');
report(sectionForPath('/admin/nope') === null, 'An unknown section is not a section (the layout sends it to Overview)');
report(SECTIONS[0].id === 'overview' && SECTIONS.at(-1).id === 'domains', 'Menu order: Overview first, Allowed domains last');

// Badges only when their condition is true
const calm = { pending: 0, programmesWithoutReviewer: 0, domains: 2, activeSemester: { id: 1 }, programmesWithoutCourses: 0 };
report(SECTIONS.every((s) => badgeFor(s.id, calm) === null), 'Nothing to do: no badge anywhere');
report(badgeFor('semesters', { ...calm, readyToClose: true }) === '!', 'Semester: ready to close (Group 6)');
report(badgeFor('applications', { ...calm, pending: 4 }) === '4', 'Applications: the pending count');
report(badgeFor('reviewers', { ...calm, programmesWithoutReviewer: 1 }) === '1', 'Reviewers: programmes without one');
report(badgeFor('domains', { ...calm, domains: 0 }) === '!', 'Allowed domains: an empty list');
report(badgeFor('semesters', { ...calm, activeSemester: null }) === '!' && badgeFor('semesters', { ...calm, programmesWithoutCourses: 2 }) === '!', 'Semester: no active semester, or programmes without courses');
report(badgeFor('applications', null) === null, 'No summary yet: no badge');

console.log(failed ? `\n${failed} problem(s)` : '\nAll admin menu checks passed');
process.exit(failed ? 1 : 0);

/**
 * Translation check (Group 10):   npm run check:translations
 *
 * 1. Every key exists in en.json, hu.json and de.json.
 * 2. The {{placeholders}} of a text are the same in all three languages.
 * 3. No unused keys: every key is used somewhere in the frontend. Keys built at run time count as
 *    used through their prefix (t(`student_status_${status}`) uses every student_status_* key), and
 *    error texts (errors.CODE) through their code appearing in the backend or the frontend.
 * 4. No hard-coded English on the student side: visible text, alert()/confirm(), aria-label,
 *    title, placeholder and alt in the student's screens must come from the locale files.
 * 5. Every student email template exists in HU, EN and DE with the same parts.
 *
 * Needs no server or database. Exits with 1 when anything is found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const BACKEND = join(here, '..', '..', 'backend');
const LANGUAGES = ['en', 'hu', 'de'];

// The student's screens (and the pages before login), checked for hard-coded English
const STUDENT_FILES = [
    'components/StudentDashboard.js', 'components/ApplicationDetail.js', 'components/SubmitSummary.js',
    'components/SubmissionBanner.js', 'components/ReplyDeadline.js', 'components/EvidenceHighlighter.js',
    'components/ProfileHeader.js', 'components/Dashboard.js', 'components/Login.js', 'components/Register.js',
    'components/ForgotPassword.js', 'components/ResetPassword.js', 'components/VerifyEmail.js', 'components/EmailLink.js',
    'components/Notice.js', 'components/LanguageSwitcher.js', 'components/PasswordInput.js', 'components/SecureImage.js',
];

const problems = [];
const problem = (section, text) => problems.push(`${section}: ${text}`);

// { 'a.b': 'text' } from nested objects
const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) => (
    value && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]
));
const locales = Object.fromEntries(LANGUAGES.map((lang) => [
    lang, Object.fromEntries(flatten(JSON.parse(readFileSync(join(SRC, 'locales', `${lang}.json`), 'utf8')))),
]));
const allKeys = [...new Set(LANGUAGES.flatMap((lang) => Object.keys(locales[lang])))].sort();

// 1. Missing keys
for (const key of allKeys) {
    const missing = LANGUAGES.filter((lang) => !(key in locales[lang]));
    if (missing.length) problem('Missing', `${key} (no ${missing.join(', ')})`);
}

// 2. Placeholders
const placeholders = (text) => [...String(text).matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]).sort().join(',');
for (const key of allKeys) {
    const sets = LANGUAGES.filter((lang) => key in locales[lang]).map((lang) => [lang, placeholders(locales[lang][key])]);
    if (new Set(sets.map(([, p]) => p)).size > 1) problem('Placeholders', `${key}: ${sets.map(([lang, p]) => `${lang} {${p}}`).join(' / ')}`);
}

// 3. Unused keys
const filesUnder = (dir, test) => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'locales' ? [] : filesUnder(path, test);
    return test(name) ? [path] : [];
});
const frontendCode = filesUnder(SRC, (n) => /\.(js|jsx|mjs)$/.test(n)).map((f) => readFileSync(f, 'utf8')).join('\n');
const backendCode = filesUnder(BACKEND, (n) => n.endsWith('.js') && !n.endsWith('.test.js'))
    .filter((f) => !f.includes(`${join('backend', 'scripts')}`))
    .map((f) => readFileSync(f, 'utf8')).join('\n');
const literals = new Set([...frontendCode.matchAll(/['"`]([A-Za-z][\w.]*)['"`]/g)].map((m) => m[1]));
// Keys built at run time: t(`student_status_${…}`) -> 'student_status_'
const prefixes = [...frontendCode.matchAll(/`([a-z][\w.]*)\$\{/g)].map((m) => m[1]);
const isUsed = (key) => {
    const base = key.replace(/_(one|other|zero|two|few|many)$/, ''); // plural forms belong to their base key
    if (literals.has(key) || literals.has(base)) return true;
    if (prefixes.some((p) => key.startsWith(p))) return true;
    if (key.startsWith('errors.')) {
        // An error text is used when the backend (or the frontend) can answer that code
        const code = key.slice('errors.'.length);
        return new RegExp(`['"\`]${code}['"\`]`).test(backendCode) || literals.has(code);
    }
    return false;
};
for (const key of allKeys) if (!isUsed(key)) problem('Unused', key);

// 4. Hard-coded English on the student side
for (const file of STUDENT_FILES) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
        const where = `${file}:${i + 1}`;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments
        // Text between tags: >Some text<  (not {expressions})
        for (const m of line.matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) {
            if (!/=>|&&|\|\||\(|\)/.test(m[1])) problem('Hard-coded', `${where} text "${m[1].trim()}"`);
        }
        // Attributes people read or hear
        for (const m of line.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-z][^"]*)"/g)) problem('Hard-coded', `${where} ${m[1]}="${m[2]}"`);
        // Pop-ups with a fixed text, and t('key', 'English fallback')
        for (const m of line.matchAll(/\b(alert|confirm)\(\s*['"`]/g)) problem('Hard-coded', `${where} ${m[1]}() with fixed text`);
        for (const m of line.matchAll(/\bt\(\s*'[\w.]+'\s*,\s*['"`]/g)) problem('Hard-coded', `${where} English fallback in ${m[0]}…`);
        // The server's messages are English only: a page must show its own translated text
        if (/\bdata\.message\b/.test(line)) problem('Hard-coded', `${where} shows the server's English data.message`);
    });
}

// 5. Email templates: the same templates and parts in every language
const require = createRequire(import.meta.url);
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.FRONTEND_URL ||= 'http://localhost:3000'; // only so the templates load without a backend .env
const emails = require(join(BACKEND, 'utils', 'emailTemplates.js'));
const EMAIL_LANGUAGES = ['hu', 'en', 'de'];
const shape = (obj) => Object.entries(obj).map(([key, value]) => (
    value && typeof value === 'object' && !Array.isArray(value) ? `${key}{${shape(value)}}` : key
)).sort().join(',');
for (const [name, table] of Object.entries(emails.translatedTables || {})) {
    const shapes = EMAIL_LANGUAGES.map((lang) => [lang, table[lang] ? shape(table[lang]) : 'MISSING']);
    if (new Set(shapes.map(([, s]) => s)).size > 1) problem('Emails', `${name}: ${shapes.map(([lang, s]) => `${lang} [${s}]`).join(' / ')}`);
}
if (!emails.translatedTables) problem('Emails', 'backend/utils/emailTemplates.js exports no translatedTables to compare');

const counts = { keys: allKeys.length, files: STUDENT_FILES.length };
if (problems.length) {
    problems.forEach((p) => console.log(`FAIL  ${p}`));
    console.log(`\n${problems.length} problem(s) in ${counts.keys} keys and ${counts.files} student-side files`);
    process.exit(1);
}
console.log(`All translations complete: ${counts.keys} keys in EN/HU/DE with matching placeholders, none unused, no hard-coded English in ${counts.files} student-side files, emails in HU/EN/DE`);
console.log(`(checked from ${relative(process.cwd(), SRC)})`);

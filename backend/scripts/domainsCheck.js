/**
 * Proves that no real email domain is written anywhere in the repository (admin round Group 3):
 * the allowed student domains live only in the database (allowed_domains), managed by the admin.
 *
 *   npm run check:domains
 *
 * Scans every file in the repository that is not ignored (code, docs, config) for email addresses and for university domains
 * (anything ending in pte.hu). Allowed are only names reserved for examples and tests, which can
 * never be real: *.example, *.invalid, *.test, *.localhost, localhost, and example.com/.net/.org.
 * Read-only: it changes nothing.
 */
const { execFileSync } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..', '..');
const RESERVED = /(^|\.)(example|invalid|test|localhost)$|^localhost$|^example\.(com|net|org)$/;
// Files that are generated or not ours
// (and this file itself, which names the pattern it looks for)
const SKIP = [/(^|\/)package-lock\.json$/, /(^|\/)node_modules\//, /^backend\/scripts\/domainsCheck\.js$/, /\.(png|jpe?g|gif|ico|pdf|woff2?|ttf|svg)$/i];

// Tracked files and new files not yet added (ignored files such as .env are left out)
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter((file) => !SKIP.some((pattern) => pattern.test(file)));

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const UNIVERSITY = /\b(?:[a-z0-9-]+\.)*pte\.hu\b/gi;

const problems = [];
for (const file of files) {
    let text;
    try { text = readFileSync(join(ROOT, file), 'utf8'); } catch { continue; }
    text.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(EMAIL)) {
            const domain = match[1].toLowerCase().replace(/\.+$/, '');
            // npm scopes and decorators like @types/node, @testing-library: no dot-separated host after "@"
            if (!RESERVED.test(domain)) problems.push(`${file}:${index + 1}  ${match[0]}`);
        }
        for (const match of line.matchAll(UNIVERSITY)) problems.push(`${file}:${index + 1}  ${match[0]}`);
    });
}

if (problems.length > 0) {
    console.error(`Hard-coded domains found (${problems.length}). Use the admin's allowed-domains list or a reserved example domain instead:`);
    [...new Set(problems)].forEach((problem) => console.error(`  ${problem}`));
    process.exit(1);
}
console.log(`No hard-coded domains: ${files.length} tracked files checked (only reserved example domains such as students.example are used).`);

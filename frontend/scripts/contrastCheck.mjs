/**
 * Colour check (reviewer group L2):   npm run check:contrast
 *
 * 1. Contrast: every text colour on its background, read from src/theme/theme.css itself, meets
 *    WCAG 2.1 AA (at least 4.5:1 for normal text). Uses the WCAG relative-luminance formula.
 * 2. No hard-coded colours in the reviewer dashboard: every colour comes from a theme token
 *    (var(--...)), so it can be changed in one place.
 * The app has a light theme only. Needs no server or browser. Exits with 1 when anything fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const AA = 4.5;

// --- the tokens from theme.css (:root) ---
const css = readFileSync(join(SRC, 'theme', 'theme.css'), 'utf8');
const tokens = Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]));

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};

// [text token, background token, where]
const PAIRS = [
    ...['pending', 'needs-info', 'approved', 'rejected', 'system', 'resubmitted', 'neutral']
        .map((cue) => [`--cue-${cue}-text`, `--cue-${cue}-bg`, `${cue} chip`]),
    ['--text', '--cue-note-student-bg', 'student note'],
    ['--text', '--cue-note-reviewer-bg', 'reviewer note'],
    ['--text', '--cue-note-resubmit-bg', 'resubmit note'],
    ['--text', '--cue-note-system-bg', 'system note'],
    ['--text', '--cue-row-hover', 'row on hover'],
    ['--text', '--cue-row-open', 'open row'],
    ['--link', '--cue-row-open', 'course name in the open row'],
    ['--text-secondary', '--cue-row-open', 'secondary text in the open row'],
    ['--link', '--cue-tab-active-bg', 'active tab'],
    ['--cue-system-text', '--cue-row-open', 'read-only note in the open row'],
    ['--cue-tab-badge-text', '--cue-tab-badge-bg', 'tab count badge'],
    ['--cue-btn-approve-text', '--cue-btn-approve', 'Approve button'],
    ['--cue-btn-reject-text', '--cue-btn-reject', 'Reject button'],
    ['--cue-btn-info-text', '--cue-btn-info', 'Request information button'],
];

let failed = 0;
for (const [text, background, where] of PAIRS) {
    if (!tokens[text] || !tokens[background]) {
        failed += 1;
        console.log(`FAIL  ${where}: token missing (${!tokens[text] ? text : background})`);
        continue;
    }
    const value = ratio(tokens[text], tokens[background]);
    const ok = value >= AA;
    if (!ok) failed += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${where.padEnd(32)} ${tokens[text]} on ${tokens[background]}  ${value.toFixed(2)}:1`);
}

// --- no hard-coded colours in the reviewer dashboard ---
const REVIEWER_FILES = [
    'components/ReviewerDashboard.js', 'components/reviewer/ReviewerHeader.js', 'components/reviewer/ReviewerTabs.js',
    'components/reviewer/ReviewerSearch.js', 'components/reviewer/ApplicationRow.js', 'components/reviewer/ApplicationDetails.js',
    'components/reviewer/DecisionModal.js', 'components/reviewer/FileLink.js', 'components/reviewer/CreditComparison.js',
    'components/reviewer/NotesConversation.js', 'components/reviewer/HistoryTable.js', 'components/reviewer/Chip.js',
    'components/reviewer/SemesterSelect.js',
];
const HARD_CODED = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|['"](white|black|red|green|blue|orange|yellow|grey|gray|purple)['"]/;
for (const file of REVIEWER_FILES) {
    readFileSync(join(SRC, file), 'utf8').split('\n').forEach((line, i) => {
        if (HARD_CODED.test(line) && !line.trim().startsWith('//')) {
            failed += 1;
            console.log(`FAIL  hard-coded colour in ${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
    });
}

console.log(failed ? `\n${failed} problem(s)` : `\nAll colour checks passed: ${PAIRS.length} contrast pairs at least ${AA}:1, no hard-coded colours in ${REVIEWER_FILES.length} reviewer files`);
process.exit(failed ? 1 : 0);

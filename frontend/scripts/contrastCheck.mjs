/**
 * Colour check (reviewer group L2, admin round Group 8):   npm run check:contrast
 *
 * 1. Contrast: every text colour on its background, read from src/theme/theme.css itself, meets
 *    WCAG 2.1 AA (at least 4.5:1 for normal text). Uses the WCAG relative-luminance formula.
 *    Chart bars (shapes, not text) need at least 3:1 against their background (WCAG 1.4.11).
 * 2. No colour written in any component or other source file: every colour comes from a theme
 *    token (var(--...)) in src/theme/theme.css, the one place to change it. (src/theme/ itself and
 *    comments are allowed to contain colour values.)
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
    ...['pending', 'needs-info', 'approved', 'rejected', 'withdrawn', 'awaiting', 'system', 'resubmitted', 'neutral']
        .map((cue) => [`--cue-${cue}-text`, `--cue-${cue}-bg`, `${cue} chip`]),
    // Admin screens (admin round Group 8)
    ['--text', '--section-bg', 'text on an admin section'],
    ['--text-muted', '--section-bg', 'muted text on an admin section'],
    ['--section-heading', '--section-bg', 'admin section heading'],
    ['--menu-active-text', '--menu-active-bg', 'active menu item'],
    ['--text', '--menu-hover-bg', 'menu item on hover'],
    ['--badge-text', '--badge-bg', 'menu badge'],
    ...['info', 'success', 'warning', 'danger'].map((kind) => [`--banner-${kind}-text`, `--banner-${kind}-bg`, `${kind} banner`]),
    ['--acting-text', '--acting-bg', '"Acting as" banner'],
    // Text on solid buttons (white on the theme's button colours)
    ...['--brand', '--accent', '--red', '--grey', '--teal', '--request', '--header-bg', '--purple']
        .map((bg) => ['--text-on-primary', bg, `button text on ${bg}`]),
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

// [shape colour, background, where]: at least 3:1
const SHAPES = ['pending', 'needs-info', 'approved', 'rejected', 'withdrawn', 'awaiting', 'neutral'].map((c) => [`--chart-${c}`, '--bg', `chart bar ${c}`]);
const GRAPHICS = 3;

let failed = 0;
for (const [shape, background, where] of SHAPES) {
    if (!tokens[shape] || !tokens[background]) {
        failed += 1;
        console.log(`FAIL  ${where}: token missing`);
        continue;
    }
    const value = ratio(tokens[shape], tokens[background]);
    if (value < GRAPHICS) failed += 1;
    console.log(`${value >= GRAPHICS ? 'PASS' : 'FAIL'}  ${where.padEnd(32)} ${tokens[shape]} on ${tokens[background]}  ${value.toFixed(2)}:1 (shape, ${GRAPHICS}:1)`);
}
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

// --- no colour written in any source file (src/theme/ excepted) ---
import { readdirSync } from 'node:fs';
const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'theme' || e.name === 'locales' ? [] : sourceFiles(full);
    return /\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name) ? [full] : [];
});
const FILES = sourceFiles(SRC);
// #hex, rgb()/hsl() with numbers, and named colours as values; pdf-lib's rgb(paper.r, ...) with theme values is fine
const HARD_CODED = /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b|\brgba?\(\s*[\d.]|\bhsla?\(\s*[\d.]|['"`](white|black|red|green|blue|orange|yellow|grey|gray|purple|navy|teal|pink)['"`]|solid (white|black|red|green|blue|orange|yellow|grey|gray)\b/;
for (const file of FILES) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
        if (code && !code.startsWith('*') && HARD_CODED.test(code)) {
            failed += 1;
            console.log(`FAIL  colour written in ${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        }
    });
}

console.log(failed ? `\n${failed} problem(s)` : `\nAll colour checks passed: ${PAIRS.length} text pairs at least ${AA}:1, ${SHAPES.length} chart colours at least ${GRAPHICS}:1, no colour written in ${FILES.length} source files`);
process.exit(failed ? 1 : 0);

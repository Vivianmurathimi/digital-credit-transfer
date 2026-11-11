/**
 * The email and PDF colours (utils/brandColors.js) match the app's theme (frontend/src/theme/theme.css),
 * and the emails and the PDF write no colour of their own (admin round Group 8):
 *
 *   npm test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BRAND_COLORS, THEME_TOKENS } = require('../utils/brandColors');

const THEME = path.join(__dirname, '..', '..', 'frontend', 'src', 'theme', 'theme.css');

test('every brand colour equals its theme.css token', { skip: !fs.existsSync(THEME) && 'frontend not next to the backend' }, () => {
    const css = fs.readFileSync(THEME, 'utf8');
    const tokens = Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toLowerCase()]));
    for (const [key, token] of Object.entries(THEME_TOKENS)) {
        const value = key.split('.').reduce((o, k) => o[k], BRAND_COLORS);
        assert.equal(value.toLowerCase(), tokens[token], `brandColors ${key} should equal ${token} in theme.css`);
    }
});

test('the emails and the PDF use brandColors.js, not colour values of their own', () => {
    for (const file of ['emailTemplates.js', 'buildTermBookPdf.js']) {
        const code = fs.readFileSync(path.join(__dirname, '..', 'utils', file), 'utf8').replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(code, /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b|color:\s*(white|black|red)\b/, file);
    }
});

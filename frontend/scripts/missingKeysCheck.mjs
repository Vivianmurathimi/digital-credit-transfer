/**
 * Missing translation keys (admin round Group 8):   npm run check:missing-keys
 *
 * Compares src/locales/en.json, hu.json and de.json (nested keys as a.b.c) and lists every key that
 * is missing, or empty, in any of them, per language. Needs no server. Exits with 1 when any is found.
 * (npm run check:translations does this too, with more checks; this one is the short list to fix.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales');
const LANGUAGES = ['en', 'hu', 'de'];

const flatten = (obj, prefix = '') => Object.entries(obj).flatMap(([key, value]) => (
    value && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [[`${prefix}${key}`, value]]
));
const locales = Object.fromEntries(LANGUAGES.map((lang) => [
    lang, Object.fromEntries(flatten(JSON.parse(readFileSync(join(LOCALES, `${lang}.json`), 'utf8')))),
]));
const allKeys = [...new Set(LANGUAGES.flatMap((lang) => Object.keys(locales[lang])))].sort();

let found = 0;
for (const lang of LANGUAGES) {
    const missing = allKeys.filter((key) => !(key in locales[lang]));
    const empty = allKeys.filter((key) => key in locales[lang] && String(locales[lang][key]).trim() === '');
    if (missing.length || empty.length) {
        console.log(`${lang}.json:`);
        missing.forEach((key) => console.log(`  missing  ${key}`));
        empty.forEach((key) => console.log(`  empty    ${key}`));
    }
    found += missing.length + empty.length;
}
console.log(found ? `\n${found} key(s) to fix` : `No missing or empty keys: ${allKeys.length} keys in ${LANGUAGES.join(', ')}`);
process.exit(found ? 1 : 0);

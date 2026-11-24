// Searching text in the browser, without case or accents (reviewer Group 3; fixes 3a). Plain
// JavaScript without React, so the Node checks can load it too (npm run check:reviewer-list).

/**
 * Text for comparing, without case or accents: "Kovács Ödön" -> "kovacs odon", "Straße" -> "strasse".
 * NFD splits a letter from its accent marks (also Hungarian ő and ű), which are then dropped.
 */
export const foldText = (value) => String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss');

// The typed text, folded, trimmed and with single spaces
const foldQuery = (query) => foldText(query).replace(/\s+/g, ' ').trim();

/**
 * Whether the typed text appears in any of the texts ("epites" finds "Építés"). An empty box matches
 * everything; missing texts are skipped.
 * @param {string} query  what was typed
 * @param {Array<string|null|undefined>} texts
 */
export const matchesAny = (query, texts) => {
    const wanted = foldQuery(query);
    if (!wanted) return true;
    return texts.some((text) => foldText(text).replace(/\s+/g, ' ').includes(wanted));
};

// Programmes & Courses (fixes 3a): a programme by its code, its other codes and its names in every
// language; a course by its code or name
export const programmeMatches = (query, p) => matchesAny(query, [p.code, ...(p.aliases || []), p.name_hu, p.name_en, p.name_de]);
export const courseMatches = (query, c) => matchesAny(query, [c.course_code, c.course_name]);

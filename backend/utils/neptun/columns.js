// The Neptun CSV columns, in ONE place (admin round Group 4). When the real Neptun export arrives,
// only this file changes: add its header names to `headers` (matched without case, spaces,
// underscores, hyphens or accents), or change how a cell is read.
// The sample file is docs/sample-neptun.csv.

// field: our name; headers: the names a file may use for it; required: must have a value
const COLUMNS = [
    { field: 'programme_code', headers: ['programme_code', 'szak_kod', 'szakkod', 'program_code'], required: true },
    { field: 'programme_name_hu', headers: ['programme_name_hu', 'szak_nev', 'szaknev', 'programme_name'], required: true },
    { field: 'programme_name_en', headers: ['programme_name_en'], required: false },
    { field: 'programme_name_de', headers: ['programme_name_de'], required: false },
    { field: 'course_code', headers: ['course_code', 'targykod', 'targy_kod', 'subject_code'], required: true },
    { field: 'course_name', headers: ['course_name', 'targynev', 'targy_nev', 'subject_name'], required: true },
    { field: 'credits', headers: ['credits', 'kredit', 'kreditertek'], required: true },
];

// "Szak kód" -> "szakkod", "programme_code" -> "programmecode"
const simplify = (header) => String(header || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Which column of the file holds each field.
 * @param {string[]} header  the file's first line
 * @returns {{ index: Record<string, number>, missing: string[] }}  missing: required fields not found
 */
const mapHeader = (header) => {
    const simplified = header.map(simplify);
    const index = {};
    for (const column of COLUMNS) {
        const at = simplified.findIndex((h) => column.headers.map(simplify).includes(h));
        if (at !== -1) index[column.field] = at;
    }
    const missing = COLUMNS.filter((c) => c.required && index[c.field] === undefined).map((c) => c.field);
    return { index, missing };
};

// One row's cells -> { programme_code, ... } (trimmed text; '' when the column is absent)
const readRow = (cells, index) => Object.fromEntries(
    COLUMNS.map(({ field }) => [field, index[field] === undefined ? '' : String(cells[index[field]] ?? '').trim()])
);

module.exports = { COLUMNS, mapHeader, readRow };

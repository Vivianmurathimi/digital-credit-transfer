const { readFileSync } = require('fs');
const { join } = require('path');
const { readNeptunFile, applyImport, fileForProgramme } = require('./catalogue');

// The demo and development catalogue (admin round Group 4): no course list is written in the code.
// The seed and demo scripts import backend/fixtures/demo-neptun.csv with the same import as the
// admin screen, one programme at a time (fixes 1b): an existing programme by its code, otherwise a
// new one with the file's names. Nothing already there is hidden or deleted: every missing course is kept.
const FIXTURE = join(__dirname, '..', '..', 'fixtures', 'demo-neptun.csv');

/**
 * @param {{ query: Function }} client  inside a transaction, or the pool
 * @returns {Promise<object>}  the import summary
 */
const importFixture = async (client, semesterId, path = FIXTURE) => {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to import demo data with NODE_ENV=production');
    const file = readNeptunFile(readFileSync(path));
    if (file.fileError) throw new Error(`${path}: ${file.fileError.message}`);
    if (file.errors.length > 0) throw new Error(`${path}: row ${file.errors[0].row}: ${file.errors[0].code}`);
    const total = { programmesAdded: 0, programmesChanged: 0, aliasesSaved: 0, coursesAdded: 0, coursesChanged: 0, rowsSkipped: 0, coursesHidden: 0, coursesDeleted: 0 };
    for (const [code, written] of file.programmes) {
        const existing = (await client.query(
            'SELECT id FROM programmes WHERE upper(code) = $1 UNION ALL SELECT programme_id FROM programme_aliases WHERE alias_code = $1', [code]
        )).rows[0]; // by its code, or one of its other codes
        const programme = existing
            ? { id: existing.id }
            : { new: { code, name_hu: written.name_hu, name_en: written.name_en, name_de: written.name_de }, confirmed_different: true };
        const part = fileForProgramme(file, code);
        const keepAll = Object.fromEntries((existing
            ? (await client.query('SELECT id FROM courses WHERE programme_id = $1 AND semester_id = $2', [existing.id, semesterId])).rows
            : []).map((c) => [String(c.id), 'keep']));
        const result = await applyImport(client, semesterId, part, { programme, courses: keepAll });
        if (result.error) throw new Error(`${code}: ${result.error[2]}`);
        for (const key of Object.keys(total)) total[key] += result.summary[key] || 0;
    }
    return total;
};

module.exports = { importFixture, FIXTURE };

const { readFileSync } = require('fs');
const { join } = require('path');
const { readNeptunFile, buildPreview, applyImport } = require('./catalogue');

// The demo and development catalogue (admin round Group 4): no course list is written in the code.
// The seed and demo scripts import backend/fixtures/demo-neptun.csv with the same import as the
// admin screen. Nothing already there is hidden or deleted: every missing item is kept.
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
    const preview = await buildPreview(client, semesterId, file);
    const keep = (items, key) => Object.fromEntries(items.map((item) => [key(item), 'keep']));
    const result = await applyImport(client, semesterId, file, {
        programmes: keep(preview.missingProgrammes, (p) => p.code),
        courses: keep(preview.missingCourses, (c) => String(c.id)),
    });
    if (result.error) throw new Error(result.error[2]);
    return result.summary;
};

module.exports = { importFixture, FIXTURE };

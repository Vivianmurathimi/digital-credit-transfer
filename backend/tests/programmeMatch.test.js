/**
 * One programme per import, never two for the same thing (fixes 1b):   npm test
 *
 * The matching rules on their own, then the real Neptun import on temporary programmes (codes ZQX…,
 * made-up names that match nothing else) in a temporary semester in 2098. A refused import is rolled
 * back exactly as the route does it. Everything is deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const inTransaction = require('../utils/transaction');
const { normalizeName, findLookalikes, rowMatches } = require('../utils/programmeMatch');
const { readNeptunFile, resolveProgramme, buildPreview, applyImport } = require('../utils/neptun/catalogue');

const PREFIX = 'ZQX';
let semesterId;

const csv = (rows) => Buffer.from(
    ['programme_code;programme_name_hu;programme_name_en;programme_name_de;course_code;course_name;credits', ...rows].join('\n'), 'utf8'
);
// As the route: one transaction, and a refusal undoes everything
const importFile = (rows, decisions) => inTransaction(async (client) => {
    const outcome = await applyImport(client, semesterId, readNeptunFile(csv(rows)), decisions);
    if (outcome.error) throw Object.assign(new Error('refused'), { refusal: outcome });
    return outcome;
}).catch((err) => { if (err.refusal) return err.refusal; throw err; });
const previewOf = async (rows, choice, mismatches = {}) => {
    const resolved = await resolveProgramme(pool, choice);
    if (resolved.error) return resolved;
    return buildPreview(pool, semesterId, readNeptunFile(csv(rows)), { programme: resolved.programme, mismatches });
};
const programme = async (code) => (await pool.query('SELECT id, code FROM programmes WHERE code = $1', [code])).rows[0];
const coursesOf = async (code) => (await pool.query(
    'SELECT c.course_code FROM courses c JOIN programmes p ON p.id = c.programme_id WHERE p.code = $1 AND c.semester_id = $2 ORDER BY 1', [code, semesterId]
)).rows.map((r) => r.course_code);
// What this test can have saved (its own programmes and semester only: other test files run at the same time)
const counts = async () => (await pool.query(
    `SELECT (SELECT count(*)::int FROM programmes WHERE code LIKE $1) AS programmes,
            (SELECT count(*)::int FROM courses WHERE semester_id = $2) AS courses,
            (SELECT count(*)::int FROM programme_aliases a JOIN programmes p ON p.id = a.programme_id WHERE p.code LIKE $1 OR a.alias_code LIKE $1) AS aliases`,
    [`${PREFIX}%`, semesterId]
)).rows[0];

const cleanUp = async () => {
    const ids = (await pool.query('SELECT id FROM programmes WHERE code LIKE $1', [`${PREFIX}%`])).rows.map((r) => r.id);
    if (ids.length) {
        await pool.query('DELETE FROM courses WHERE programme_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM programme_aliases WHERE programme_id = ANY($1)', [ids]); // nothing goes along with a programme (migration 029)
        await pool.query('DELETE FROM programmes WHERE id = ANY($1)', [ids]);
    }
};

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    await cleanUp();
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2098-02-01T08:00:00Z', '2098-02-28T22:59:00Z', '2098-03-14T22:59:00Z', '2098-06-30') RETURNING id`,
        [`Programme match test ${Date.now()}`]
    )).rows[0].id;
});

after(async () => {
    await cleanUp();
    await pool.query('DELETE FROM courses WHERE semester_id = $1', [semesterId]);
    await pool.query('DELETE FROM semesters WHERE id = $1', [semesterId]);
    await pool.end();
});

test('the rules: names ignore case, accents and spaces; codes alike from 3 characters; aliases count', () => {
    assert.equal(normalizeName('  Civil   Engineering '), 'civil engineering');
    assert.equal(normalizeName('Építőmérnöki'), normalizeName('epitomernoki'));
    const civ = { id: 1, code: 'CIV', name_hu: 'Építőmérnöki', name_en: 'Civil Engineering', name_de: 'Bauingenieurwesen', status: 'active', aliases: ['CE'] };
    const reasons = (candidate) => findLookalikes([civ], candidate)[0]?.reasons || [];
    assert.deepEqual(reasons({ code: 'CIVIL', name_hu: 'Valami más' }), ['similar_code'], 'CIVIL starts with CIV');
    assert.deepEqual(reasons({ code: 'NEW', name_hu: 'epitomernoki ' }), ['same_name'], 'the same name, accents and spaces aside');
    assert.deepEqual(reasons({ code: 'ce', name_hu: 'Valami más' }), ['same_code'], 'one of its other codes, any case');
    assert.deepEqual(reasons({ code: 'CI', name_hu: 'Valami más' }), [], 'two characters are too short to look alike');
    assert.deepEqual(reasons({ code: 'ME', name_hu: 'Gépészmérnöki', name_en: 'Mechanical Engineering' }), []);
    assert.ok(rowMatches(civ, { code: 'CE' }), 'a row with one of its other codes matches');
    assert.ok(rowMatches(civ, { code: 'XYZ', name_en: 'civil  engineering' }), 'a row with its name matches');
    assert.ok(!rowMatches(civ, { code: 'CIVIL', name_hu: 'Valami más' }), 'a look-alike code alone does not match');
});

test('an exact-match import goes straight through', async () => {
    const choice = { new: { code: `${PREFIX}ALPHA`, name_hu: 'Zqxalpha szak', name_en: 'Zqxalpha Studies' } };
    const rows = [`${PREFIX}ALPHA;Zqxalpha szak;Zqxalpha Studies;;${PREFIX}101;Alpha one;5`, `${PREFIX}ALPHA;Zqxalpha szak;Zqxalpha Studies;;${PREFIX}102;Alpha two;3`];
    const preview = await previewOf(rows, choice);
    assert.equal(preview.ready, true);
    assert.deepEqual(preview.mismatches, []);
    const done = await importFile(rows, { programme: choice });
    assert.equal(done.summary?.programmesAdded, 1, JSON.stringify(done));
    assert.deepEqual(await coursesOf(`${PREFIX}ALPHA`), [`${PREFIX}101`, `${PREFIX}102`]);
    assert.equal((await pool.query('SELECT name_de FROM programmes WHERE code = $1', [`${PREFIX}ALPHA`])).rows[0].name_de, 'Zqxalpha szak', 'no German name: the Hungarian one');
});

test('a mismatched code stops; treated as the same it imports and is remembered for the next import', async () => {
    const alpha = await programme(`${PREFIX}ALPHA`);
    const choice = { id: alpha.id };
    const rows = [
        `${PREFIX}ALPHA;Zqxalpha szak;Zqxalpha Studies;;${PREFIX}103;Alpha three;4`,
        `${PREFIX}OTHER;Zqxother szak;Zqxother Studies;;${PREFIX}104;Other four;4`,
        `${PREFIX}OTHER;Zqxother szak;Zqxother Studies;;${PREFIX}105;Other five;2`,
    ];
    const stopped = await previewOf(rows, choice);
    assert.equal(stopped.ready, false);
    assert.deepEqual(stopped.mismatches.map((g) => [g.code, g.rowRanges, g.owner]), [[`${PREFIX}OTHER`, '3–4', null]], 'rows 3–4 say ZQXOTHER');

    const before = await counts();
    const unanswered = await importFile(rows, { programme: choice });
    assert.equal(unanswered.error?.[1], 'MISMATCH_DECISION_NEEDED');
    assert.deepEqual(await counts(), before, 'nothing saved while a group is unanswered');
    assert.equal((await importFile(rows, { programme: choice, mismatches: { [`${PREFIX}OTHER`]: 'maybe' } })).error?.[1], 'INVALID_DECISIONS');

    const done = await importFile(rows, { programme: choice, mismatches: { [`${PREFIX}OTHER`]: 'same' } });
    assert.equal(done.summary?.aliasesSaved, 1, JSON.stringify(done));
    assert.deepEqual(await coursesOf(`${PREFIX}ALPHA`), [`${PREFIX}101`, `${PREFIX}102`, `${PREFIX}103`, `${PREFIX}104`, `${PREFIX}105`]);
    assert.equal(await programme(`${PREFIX}OTHER`), undefined, 'no second programme');
    const alias = (await pool.query('SELECT programme_id FROM programme_aliases WHERE alias_code = $1', [`${PREFIX}OTHER`])).rows[0];
    assert.equal(alias?.programme_id, alpha.id, 'the code is saved as another code of the programme');

    const next = await previewOf([`${PREFIX}OTHER;Zqxother szak;Zqxother Studies;;${PREFIX}106;Other six;3`], choice);
    assert.equal(next.ready, true, 'the next import with that code matches by itself');
    assert.deepEqual(next.mismatches, []);
});

test('a new programme that looks like an existing one stops and asks', async () => {
    const alikeCode = await resolveProgramme(pool, { new: { code: `${PREFIX}ALPH`, name_hu: 'Teljesen új' } });
    assert.equal(alikeCode.error?.[1], 'PROGRAMME_LOOKALIKE', 'ZQXALPH starts like ZQXALPHA');
    assert.equal(alikeCode.lookalikes[0].code, `${PREFIX}ALPHA`);
    const alikeName = await resolveProgramme(pool, { new: { code: `${PREFIX}BETA`, name_hu: 'zqxalpha   SZAK' } });
    assert.deepEqual([alikeName.error?.[1], alikeName.lookalikes?.[0]?.reasons], ['PROGRAMME_LOOKALIKE', ['same_name']]);
    const different = await resolveProgramme(pool, { new: { code: `${PREFIX}ALPH`, name_hu: 'Teljesen új' }, confirmed_different: true });
    assert.equal(different.programme?.isNew, true, 'Different programme: it can be created');
    const taken = await resolveProgramme(pool, { new: { code: `${PREFIX}OTHER`, name_hu: 'Teljesen új' }, confirmed_different: true });
    assert.equal(taken.error?.[1], 'PROGRAMME_CODE_TAKEN', 'a code that is already another code of a programme is never a new programme');

    const before = await counts();
    const refused = await importFile([`${PREFIX}ALPH;Teljesen új;;;${PREFIX}201;New one;3`], { programme: { new: { code: `${PREFIX}ALPH`, name_hu: 'Teljesen új' } } });
    assert.equal(refused.error?.[1], 'PROGRAMME_LOOKALIKE', 'the import asks again on the server');
    assert.deepEqual(await counts(), before);
});

test('cancel saves nothing; a code of another programme can never be treated as the same', async () => {
    const before = await counts();
    // The admin cancels at step 3: the import is never sent, and a preview saves nothing
    const rows = [`${PREFIX}GAMMA;Zqxgamma szak;;;${PREFIX}301;Gamma one;3`, `${PREFIX}DELTA;Zqxdelta szak;;;${PREFIX}302;Delta two;3`];
    const choice = { new: { code: `${PREFIX}GAMMA`, name_hu: 'Zqxgamma szak' } };
    assert.equal((await previewOf(rows, choice)).ready, false);
    assert.deepEqual(await counts(), before, 'the previews saved nothing');
    // ZQXOTHER is ZQXALPHA's: rows with it cannot go into ZQXGAMMA, and nothing is saved
    const other = [`${PREFIX}GAMMA;Zqxgamma szak;;;${PREFIX}301;Gamma one;3`, `${PREFIX}OTHER;Zqxother szak;;;${PREFIX}303;Other;3`];
    const group = (await previewOf(other, choice)).mismatches[0];
    assert.equal(group.owner?.code, `${PREFIX}ALPHA`);
    const refused = await importFile(other, { programme: choice, mismatches: { [`${PREFIX}OTHER`]: 'same' } });
    assert.equal(refused.error?.[1], 'ALIAS_TAKEN');
    assert.deepEqual(await counts(), before, 'nothing saved, not even the new programme');
});

// DB cleanup 3 (migration 030): courses have no university any more; one code per programme and semester
test('the import creates courses without a university; the same course code twice is refused', async () => {
    const choice = { new: { code: `${PREFIX}EPS`, name_hu: 'Zqxepsilon szak' } };
    const rows = [
        `${PREFIX}EPS;Zqxepsilon szak;;;${PREFIX}501;Epsilon one;3`,
        `${PREFIX}EPS;Zqxepsilon szak;;;${PREFIX} 501;Epsilon again;4`, // the same code, written with a space
        `${PREFIX}EPS;Zqxepsilon szak;;;${PREFIX}502;Epsilon two;2`,
    ];
    const done = await importFile(rows, { programme: choice });
    assert.deepEqual([done.summary?.coursesAdded, done.summary?.rowsSkipped], [2, 1], JSON.stringify(done));
    assert.deepEqual(await coursesOf(`${PREFIX}EPS`), [`${PREFIX}501`, `${PREFIX}502`]);
    const columns = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'courses'")).rows.map((r) => r.column_name);
    assert.ok(!columns.includes('university_id'), 'courses.university_id is gone');
    assert.equal((await pool.query("SELECT to_regclass('public.universities') AS t")).rows[0].t, null, 'the universities table is gone');

    // The database refuses a second course with the same code in that programme and semester (also without a semester)
    const programmeId = (await programme(`${PREFIX}EPS`)).id;
    const insert = (semester) => pool.query(
        "INSERT INTO courses (programme_id, semester_id, course_code, course_name, credits, status) VALUES ($1, $2, $3, 'Twice', 3, 'hidden')",
        [programmeId, semester, `${PREFIX}501`]
    );
    await assert.rejects(insert(semesterId), (err) => err.constraint === 'courses_programme_semester_code_key');
    await insert(null);
    await assert.rejects(insert(null), (err) => err.constraint === 'courses_programme_semester_code_key', 'no semester: still once');
});

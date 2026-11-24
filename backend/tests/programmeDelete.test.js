/**
 * The database protects programmes from cascading deletes (DB cleanup 2, migration 029):   npm test
 *
 *   - an unused programme with other codes and reminder records is deleted with them, explicitly
 *   - a programme with a staff link (current or ended) or an invite line: the database refuses
 *     the delete, even directly in SQL
 *   - removeProgramme (what the delete route runs after its check) answers that refusal with
 *     DELETE_IN_USE and leaves everything as it was
 * Temporary programmes ZQD…, a reviewer, an invite and a semester in 2089; all deleted afterwards.
 */
process.env.DOTENV_CONFIG_QUIET = 'true';
require('dotenv').config();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const inTransaction = require('../utils/transaction');
const { removeProgramme } = require('../utils/neptun/catalogue');

const run = Date.now().toString(36).toUpperCase();
let semesterId;
let reviewerId;
let n = 0;

const programme = async () => {
    n += 1;
    return (await pool.query(
        "INSERT INTO programmes (code, name_hu, name_en, name_de) VALUES ($1, 'Zqd', 'Zqd', 'Zqd') RETURNING id", [`ZQD${run}${n}`.slice(0, 20)]
    )).rows[0].id;
};
const exists = async (id) => (await pool.query('SELECT 1 FROM programmes WHERE id = $1', [id])).rows.length > 0;
const refusedInSql = async (id) => {
    try { await pool.query('DELETE FROM programmes WHERE id = $1', [id]); return null; } catch (err) { return err.constraint; }
};

const cleanUp = async () => {
    const ids = (await pool.query("SELECT id FROM programmes WHERE code LIKE 'ZQD%'")).rows.map((r) => r.id);
    if (ids.length) {
        await pool.query('DELETE FROM staff_programmes WHERE programme_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM staff_invite_programmes WHERE programme_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM programme_aliases WHERE programme_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM reviewer_reminders WHERE programme_id = ANY($1)', [ids]);
        await pool.query('DELETE FROM programmes WHERE id = ANY($1)', [ids]);
    }
    await pool.query("DELETE FROM staff_invites WHERE email LIKE '%@programme-delete-test.invalid'");
    await pool.query("DELETE FROM users WHERE email LIKE '%@programme-delete-test.invalid'");
    await pool.query("DELETE FROM semesters WHERE name LIKE 'Programme delete test %'");
};

before(async () => {
    if (process.env.NODE_ENV === 'production') throw new Error('Not on a production database');
    await cleanUp();
    semesterId = (await pool.query(
        `INSERT INTO semesters (name, status, applications_open_at, applications_close_at, review_end_at, end_date)
         VALUES ($1, 'setup', '2089-02-01T08:00:00Z', '2089-02-28T22:59:00Z', '2089-03-14T22:59:00Z', '2089-06-30') RETURNING id`,
        [`Programme delete test ${run}`]
    )).rows[0].id;
    reviewerId = (await pool.query(
        "INSERT INTO users (name, email, password, role, is_verified) VALUES ('Programme Delete Test', $1, 'not-a-password-hash', 'reviewer', true) RETURNING id",
        [`pd-${run.toLowerCase()}@programme-delete-test.invalid`]
    )).rows[0].id;
});

after(async () => {
    await cleanUp();
    await pool.end();
});

test('an unused programme with other codes and reminder records: deleted, and they go with it', async () => {
    const id = await programme();
    await pool.query('INSERT INTO programme_aliases (programme_id, alias_code) VALUES ($1, $2)', [id, `ZQDA${run}`.slice(0, 20)]);
    await pool.query(
        "INSERT INTO reviewer_reminders (semester_id, programme_id, kind, reviewer_id, pending_count, needs_info_count, sent_at) VALUES ($1, $2, '7_days', NULL, 0, 0, now())",
        [semesterId, id]
    );
    assert.equal(await refusedInSql(id), 'programme_aliases_programme_id_fkey', 'directly in SQL, its other codes keep it (no cascade)');
    const result = await inTransaction((client) => removeProgramme(client, id));
    assert.deepEqual(result, { deleted: true });
    assert.equal(await exists(id), false);
    const left = (await pool.query(
        'SELECT (SELECT count(*)::int FROM programme_aliases WHERE programme_id = $1) AS aliases, (SELECT count(*)::int FROM reviewer_reminders WHERE programme_id = $1) AS reminders', [id]
    )).rows[0];
    assert.deepEqual(left, { aliases: 0, reminders: 0 });
});

test('a staff link (current or ended) or an invite line: the database refuses, even directly in SQL', async () => {
    const current = await programme();
    await pool.query("INSERT INTO staff_programmes (user_id, programme_id, role, can_assist) VALUES ($1, $2, 'extra', false)", [reviewerId, current]);
    assert.equal(await refusedInSql(current), 'staff_programmes_programme_id_fkey', 'a current staff link');

    const ended = await programme();
    await pool.query("INSERT INTO staff_programmes (user_id, programme_id, role, can_assist, ended_at) VALUES ($1, $2, 'extra', false, now())", [reviewerId, ended]);
    assert.equal(await refusedInSql(ended), 'staff_programmes_programme_id_fkey', 'an ended staff link (history)');

    const invited = await programme();
    const inviteId = (await pool.query(
        `INSERT INTO staff_invites (email, role, token_hash, expires_at)
         VALUES ($1, 'reviewer', $2, now() + interval '1 day') RETURNING id`,
        [`invite-${run.toLowerCase()}@programme-delete-test.invalid`, `pd${run}`.toLowerCase().padEnd(64, '0').slice(0, 64)]
    )).rows[0].id;
    await pool.query("INSERT INTO staff_invite_programmes (invite_id, programme_id, role) VALUES ($1, $2, 'extra')", [inviteId, invited]);
    assert.equal(await refusedInSql(invited), 'staff_invite_programmes_programme_id_fkey', 'an invite line');

    for (const id of [current, ended, invited]) assert.equal(await exists(id), true, 'nothing was deleted along with it');
});

test('removeProgramme (the route, past its check) answers the refusal with DELETE_IN_USE and changes nothing', async () => {
    const id = await programme();
    await pool.query('INSERT INTO programme_aliases (programme_id, alias_code) VALUES ($1, $2)', [id, `ZQDB${run}`.slice(0, 20)]);
    await pool.query("INSERT INTO staff_programmes (user_id, programme_id, role, can_assist, ended_at) VALUES ($1, $2, 'extra', false, now())", [reviewerId, id]);
    const result = await inTransaction(async (client) => {
        const outcome = await removeProgramme(client, id);
        // The transaction is still usable after the refusal (rolled back to the savepoint)
        await client.query('SELECT 1');
        return outcome;
    });
    assert.deepEqual([result.error?.[0], result.error?.[1], result.blockedBy], [409, 'DELETE_IN_USE', ['HAS_PEOPLE']]);
    assert.equal(await exists(id), true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM programme_aliases WHERE programme_id = $1', [id])).rows[0].n, 1, 'its other code is still there');
});
